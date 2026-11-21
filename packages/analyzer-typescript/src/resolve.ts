import path from 'node:path';
import type { Diagnostic, FileRecord, SourceRef } from '@arqivanta/shared';
import ts from 'typescript';
import { comparePaths, type FoundFile, isSourceFile } from './discover.ts';

const virtualRoot = '/repo';
const defaultOptions: ts.CompilerOptions = {
  allowJs: true,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  resolveJsonModule: true,
};
const conventionalEntries = /^(?:src\/)?(?:index|main|app|server|cli)\.(?:[cm]?[jt]s|[jt]sx)$/i;

function virtualPath(filePath: string) {
  return `${virtualRoot}/${filePath}`;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createModuleResolver(files: FoundFile[], report: (diagnostic: Diagnostic) => void) {
  const contents = new Map(files.map((file) => [virtualPath(file.path), file.source]));
  const directories = new Set(['/', virtualRoot]);
  for (const filePath of contents.keys()) {
    let directory = path.posix.dirname(filePath);
    while (!directories.has(directory)) {
      directories.add(directory);
      directory = path.posix.dirname(directory);
    }
  }

  const host: ts.ParseConfigFileHost & ts.ModuleResolutionHost = {
    fileExists: (filePath) => contents.has(path.posix.normalize(filePath)),
    readFile: (filePath) => contents.get(path.posix.normalize(filePath)),
    directoryExists: (directory) => directories.has(path.posix.normalize(directory)),
    getCurrentDirectory: () => virtualRoot,
    readDirectory: () => [],
    onUnRecoverableConfigFileDiagnostic: () => undefined,
    useCaseSensitiveFileNames: true,
  };
  const nearestConfigs = new Map<string, string | undefined>();
  const configs = new Map<
    string | undefined,
    { options: ts.CompilerOptions; cache: ts.ModuleResolutionCache }
  >();

  function nearestConfig(directory: string): string | undefined {
    if (nearestConfigs.has(directory)) return nearestConfigs.get(directory);
    const local = ['tsconfig.json', 'jsconfig.json']
      .map((name) => `${directory}/${name}`)
      .find((name) => contents.has(name));
    const config =
      local ??
      (directory === virtualRoot ? undefined : nearestConfig(path.posix.dirname(directory)));
    nearestConfigs.set(directory, config);
    return config;
  }

  function resolutionConfig(containingFile: string) {
    const configPath = nearestConfig(path.posix.dirname(containingFile));
    const existing = configs.get(configPath);
    if (existing) return existing;
    let options = defaultOptions;
    if (configPath) {
      const configWarning = () => {
        report({
          severity: 'warning',
          path: configPath.slice(virtualRoot.length + 1),
          message:
            'Compiler configuration has validation errors. Resolution uses recognized settings when available.',
        });
      };
      try {
        const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, host);
        if (!parsed || parsed.errors.some((diagnostic) => diagnostic.code !== 18003))
          configWarning();
        if (parsed) {
          options = {
            ...defaultOptions,
            ...parsed.options,
            moduleResolution:
              parsed.options.moduleResolution ??
              (parsed.options.module === undefined ? defaultOptions.moduleResolution : undefined),
            traceResolution: false,
          };
        }
      } catch {
        configWarning();
      }
    }
    const result = {
      options,
      cache: ts.createModuleResolutionCache(virtualRoot, (filePath) => filePath, options),
    };
    configs.set(configPath, result);
    return result;
  }

  return (filePath: string, specifier: string, kind: string) => {
    if (
      !specifier ||
      specifier.includes('\0') ||
      specifier.includes('\\') ||
      specifier.includes(':') ||
      specifier.startsWith('/')
    )
      return;
    const containingFile = virtualPath(filePath);
    const { options, cache } = resolutionConfig(containingFile);
    let mode: ts.ResolutionMode = ts.ModuleKind.ESNext;
    if (kind === 'require' || kind === 'import equals') mode = ts.ModuleKind.CommonJS;
    else if (kind !== 'dynamic import') {
      mode =
        ts.getImpliedNodeFormatForFile(
          containingFile,
          cache.getPackageJsonInfoCache(),
          host,
          options,
        ) ?? mode;
    }
    const result = ts.resolveModuleName(
      specifier,
      containingFile,
      options,
      host,
      cache,
      undefined,
      mode,
    ).resolvedModule;
    if (!result) return;
    const resolved = path.posix.normalize(result.resolvedFileName);
    if (!resolved.startsWith(`${virtualRoot}/`) || !contents.has(resolved)) return;
    return resolved.slice(virtualRoot.length + 1);
  };
}

export function findEntryPoints(
  files: FoundFile[],
  records: FileRecord[],
  resolve: ReturnType<typeof createModuleResolver>,
  checkDeadline: () => void,
): SourceRef[] {
  const candidates = new Set<string>();
  const paths = new Set(records.map((file) => file.path));

  function addPackageTarget(packagePath: string, target: unknown) {
    if (
      typeof target !== 'string' ||
      !target ||
      target.includes('*') ||
      target.includes('\\') ||
      target.includes(':') ||
      target.startsWith('/')
    )
      return;
    const local = path.posix.normalize(target);
    if (local === '..' || local.startsWith('../')) return;
    const absolute = path.posix.join(path.posix.dirname(packagePath), local);
    try {
      const mapped = paths.has(absolute) ? absolute : resolve(packagePath, `./${local}`, 'import');
      if (mapped && isSourceFile(mapped)) candidates.add(mapped);
    } catch {
      return;
    }
  }

  for (const file of files) {
    checkDeadline();
    if (path.posix.basename(file.path) !== 'package.json') continue;
    let manifest: unknown;
    try {
      manifest = JSON.parse(file.source) as unknown;
    } catch {
      continue;
    }
    if (!object(manifest)) continue;
    for (const key of ['main', 'module', 'types', 'typings'])
      addPackageTarget(file.path, manifest[key]);
    if (object(manifest.bin)) {
      for (const value of Object.values(manifest.bin).slice(0, 500))
        addPackageTarget(file.path, value);
    } else addPackageTarget(file.path, manifest.bin);

    const exports = [manifest.exports];
    let visited = 0;
    while (exports.length > 0 && visited++ < 500) {
      checkDeadline();
      const entry = exports.pop();
      if (Array.isArray(entry) || object(entry)) {
        exports.push(...Object.values(entry).slice(0, 500));
      } else addPackageTarget(file.path, entry);
    }
  }

  for (const file of records) {
    if (conventionalEntries.test(file.path) && isSourceFile(file.path)) candidates.add(file.path);
  }
  return [...candidates]
    .sort(comparePaths)
    .map((filePath) => ({ path: filePath, startLine: 1, endLine: 1 }));
}
