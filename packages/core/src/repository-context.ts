import {
  comparePaths,
  type FileRecord,
  type ProjectAnalysis,
  type RepositoryContext,
  type RepositoryContextExcerpt,
  type SourceRef,
} from '@arqivanta/shared';
import type { openProjectStore } from './index.ts';

type Store = Pick<ReturnType<typeof openProjectStore>, 'sourceEntries' | 'sourceReader'>;
type Candidate = SourceRef & { score: number };
type Relationship = { reference: SourceRef; source: string; target: string; score: number };

const maxExcerpts = 12;
const maxExcerptLines = 18;
const maxExcerptBytes = 3_200;
const maxEdges = 24;
const maxTerms = 32;
const ignoredWords = new Set([
  'about',
  'all',
  'and',
  'are',
  'can',
  'code',
  'could',
  'does',
  'explain',
  'for',
  'from',
  'give',
  'file',
  'files',
  'has',
  'have',
  'how',
  'into',
  'its',
  'js',
  'json',
  'jsx',
  'md',
  'more',
  'our',
  'please',
  'project',
  'py',
  'repository',
  'show',
  'src',
  'tell',
  'ts',
  'tsx',
  'used',
  'that',
  'the',
  'their',
  'there',
  'these',
  'this',
  'through',
  'use',
  'using',
  'was',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'will',
  'with',
  'work',
  'works',
  'would',
  'you',
  'где',
  'как',
  'какие',
  'какой',
  'найди',
  'покажи',
  'работает',
  'расскажи',
  'что',
]);
const architectureTerms = [
  {
    intent: /(?:запуск|точк\p{L}*\s+вход)/iu,
    terms: ['start', 'startup', 'bootstrap', 'main', 'entry'],
  },
  {
    intent: /(?:авторизац|аутентификац|вход\s+в\s+систем)/iu,
    terms: ['auth', 'login', 'authenticate', 'authorize'],
  },
  { intent: /баз\p{L}*\s+данн/iu, terms: ['database', 'db', 'sql'] },
  { intent: /подключ/iu, terms: ['connect', 'connection'] },
  { intent: /(?:зависим|импорт)/iu, terms: ['dependency', 'dependencies', 'import'] },
];
const sensitiveFolders = new Set([
  '.agents',
  '.aws',
  '.azure',
  '.cache',
  '.codex',
  '.git',
  '.gnupg',
  '.hg',
  '.mypy_cache',
  '.next',
  '.nuxt',
  '.output',
  '.private',
  '.pytest_cache',
  '.ruff_cache',
  '.secrets',
  '.ssh',
  '.svn',
  '.turbo',
  '.venv',
  '__pycache__',
  '__pypackages__',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'site-packages',
  'venv',
]);
const sensitiveName =
  /(?:^|[._-])(?:env|credentials?|secrets?|private[-_]?keys?|api[-_]?keys?|access[-_]?tokens?|service[-_]?accounts?|application_default_credentials|id_(?:rsa|dsa|ecdsa|ed25519))(?:[._-]|$)|^\.(?:npmrc|pypirc|netrc|git-credentials|htpasswd)$|\.(?:pem|key|p12|pfx|jks|keystore)$/i;
const credentialMarker =
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b(?:gh[pousr]_[A-Za-z\d]{20,}|github_pat_[A-Za-z\d_]{25,}|sk-(?:proj-)?[A-Za-z\d_-]{20,}|xox[baprs]-[A-Za-z\d-]{15,})\b/u;
const literalCredential =
  /(?:\b|_)(?:api[_-]?(?:key|token)|access[_-]?token|client[_-]?secret|password|private[_-]?key)["']?\s*[:=]\s*(?:"[^"\r\n]{8,256}"|'[^'\r\n]{8,256}'|`[^`$\r\n]{8,256}`)/iu;

function splitIdentifier(value: string) {
  return value.replace(/(\p{Ll}|\d)(\p{Lu})/gu, '$1-$2');
}

export function isSensitiveAiPath(path: string): boolean {
  if (!path || path.length > 4_096 || /[\\:\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(path)) return true;
  return path
    .split('/')
    .some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        sensitiveFolders.has(part.toLowerCase()) ||
        sensitiveName.test(splitIdentifier(part)),
    );
}

export function hasSensitiveAiSource(content: string): boolean {
  return credentialMarker.test(content) || literalCredential.test(content);
}

export function estimateRepositoryTokens(serialized: string): number {
  return Math.ceil(Buffer.byteLength(serialized, 'utf8') / 2);
}

function contextTokens(context: RepositoryContext) {
  let estimate = estimateRepositoryTokens(JSON.stringify(context));
  while (estimate !== context.estimatedTokens) {
    context.estimatedTokens = estimate;
    estimate = estimateRepositoryTokens(JSON.stringify(context));
  }
  return estimate;
}

function queryMatcher(question: string, priorQuestions: string[]) {
  const weights = new Map<string, number>();
  for (const [text, weight] of [
    [question.slice(0, 4_096), 6] as const,
    ...priorQuestions
      .slice(-3)
      .reverse()
      .map((prior) => [prior.slice(0, 2_048), 2] as const),
  ]) {
    const variants = [text, splitIdentifier(text)];
    for (const variant of variants) {
      for (const match of variant.toLowerCase().matchAll(/[\p{L}\p{N}][\p{L}\p{N}_$]{1,63}/gu)) {
        const term = match[0];
        if (weights.size === maxTerms) break;
        if (ignoredWords.has(term)) continue;
        if (!weights.has(term)) weights.set(term, weight);
        if (
          term.length > 4 &&
          term.endsWith('s') &&
          !weights.has(term.slice(0, -1)) &&
          weights.size < maxTerms
        ) {
          weights.set(term.slice(0, -1), weight - 1);
        }
      }
    }
    for (const { intent, terms } of architectureTerms) {
      if (!intent.test(text)) continue;
      for (const term of terms) {
        if (weights.size === maxTerms) break;
        if (!weights.has(term)) weights.set(term, Math.max(1, weight - 2));
      }
    }
  }

  const escaped = [...weights.keys()]
    .sort((a, b) => b.length - a.length || comparePaths(a, b))
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = escaped.length ? new RegExp(escaped.join('|'), 'giu') : undefined;
  const identifier = /[\p{L}\p{N}_$]/u;
  function score(text: string) {
    if (!pattern) return 0;
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    if (!match) return 0;
    const matched = new Map<string, number>();
    let seen = 0;
    for (; match && seen++ < 64; match = pattern.exec(text)) {
      const value = match[0].toLowerCase();
      const weight = weights.get(value) ?? 0;
      const full =
        !identifier.test(text[match.index - 1] ?? '') &&
        !identifier.test(text[pattern.lastIndex] ?? '');
      const score = full ? weight : Math.max(1, Math.floor(weight / 2));
      if (score > (matched.get(value) ?? 0)) matched.set(value, score);
    }
    return [...matched.values()].reduce((total, score) => total + score, 0);
  }
  return {
    score,
    hasTerms: Boolean(pattern),
    maxScore: [...weights.values()].reduce((total, weight) => total + weight, 0),
    hasMatch(text: string) {
      if (!pattern) return false;
      pattern.lastIndex = 0;
      return pattern.test(text);
    },
  };
}

function lineBreaks(content: string, file: FileRecord) {
  return content.matchAll(
    file.language === 'Python' ? /\r\n|[\r\n]/gu : /\r\n|[\r\n\u2028\u2029]/gu,
  );
}

function lineOffsets(content: string, file: FileRecord, first: number, last: number) {
  const offsets: { start: number; end: number }[] = [];
  let start = 0;
  let line = 1;
  for (const match of lineBreaks(content, file)) {
    if (line >= first) offsets.push({ start, end: match.index });
    if (line === last) return offsets;
    line++;
    start = match.index + match[0].length;
  }
  if (line >= first) offsets.push({ start, end: content.length });
  return offsets;
}

function* linesOf(content: string, file: FileRecord) {
  let start = 0;
  for (const match of lineBreaks(content, file)) {
    yield content.slice(start, match.index);
    start = match.index + match[0].length;
  }
  yield content.slice(start);
}

function validRange(range: SourceRef, lines: number) {
  return (
    Number.isSafeInteger(range.startLine) &&
    Number.isSafeInteger(range.endLine) &&
    range.startLine >= 1 &&
    range.endLine >= range.startLine &&
    range.endLine <= lines
  );
}

function compareCandidates(left: Candidate, right: Candidate) {
  return (
    right.score - left.score ||
    comparePaths(left.path, right.path) ||
    left.startLine - right.startLine ||
    left.endLine - right.endLine
  );
}

function sameSpan(left: SourceRef, right: SourceRef) {
  return (
    left.path === right.path && left.startLine <= right.endLine && right.startLine <= left.endLine
  );
}

function covers(excerpt: SourceRef, reference: SourceRef) {
  return (
    excerpt.path === reference.path &&
    excerpt.startLine <= reference.startLine &&
    excerpt.endLine >= reference.endLine
  );
}

function excerptFor(
  source: string,
  file: FileRecord,
  candidate: Candidate,
  id: string,
  accept: (value: RepositoryContextExcerpt) => boolean,
) {
  if (!validRange(candidate, file.lines)) return;
  const { path, startLine, endLine } = candidate;
  if (endLine - startLine >= maxExcerptLines) return;
  const first = Math.max(1, startLine - 3, endLine - maxExcerptLines + 1);
  const requestedLast = Math.min(
    file.lines,
    first + maxExcerptLines - 1,
    Math.max(startLine + 10, endLine),
  );
  const offsets = lineOffsets(source, file, first, requestedLast);
  const last = first + offsets.length - 1;
  if (last < endLine) return;
  for (let trim = 0; trim <= maxExcerptLines; trim++) {
    const from = Math.min(startLine, first + trim);
    const to = Math.max(endLine, last - trim);
    const excerpt = source.slice(offsets[from - first].start, offsets[to - first].end);
    const value = { id, path, startLine: from, endLine: to, source: excerpt };
    if (excerpt.trim() && Buffer.byteLength(excerpt, 'utf8') <= maxExcerptBytes && accept(value))
      return value;
    if (from === startLine && to === endLine) break;
  }
}

function sourceCandidates(
  source: string,
  file: FileRecord,
  pathScore: number,
  matcher: ReturnType<typeof queryMatcher>,
  isEntry: boolean,
  architectureOverview: boolean,
): Candidate[] {
  const { path, lines } = file;
  const best: Candidate[] = [];
  function add(start: number, end: number, score: number) {
    if (!score || start > lines || start < 1) return;
    const next = {
      path,
      startLine: start,
      endLine: Math.min(lines, end, start + maxExcerptLines - 1),
      score,
    };
    if (best.length === 3 && compareCandidates(next, best[2]) >= 0) return;
    const nearby = best.findIndex((candidate) => Math.abs(candidate.startLine - start) <= 4);
    if (nearby !== -1) {
      if (compareCandidates(next, best[nearby]) < 0) best[nearby] = next;
    } else best.push(next);
    best.sort(compareCandidates);
    if (best.length > 3) best.pop();
  }

  for (const symbol of [...file.symbols, ...file.exports]) {
    if (!validRange({ path, ...symbol }, lines)) continue;
    const score = matcher.score(splitIdentifier(symbol.name)) + matcher.score(symbol.name);
    if (score)
      add(
        symbol.startLine,
        Math.min(symbol.endLine, symbol.startLine + 4),
        pathScore + 4 * score + 10,
      );
  }

  const bodyHasMatch = matcher.hasMatch(source);
  const useStart =
    pathScore > 0 || (architectureOverview && (isEntry || /(?:^|\/)readme(?:\.|$)/i.test(path)));
  if (bodyHasMatch || useStart) {
    const bodyBase = pathScore + (isEntry ? 2 : 0);
    const maxBodyScore = bodyBase + 2 * matcher.maxScore;
    let firstText = 0;
    let line = 0;
    let previous: string | undefined;
    let score = 0;
    for (const text of linesOf(source, file)) {
      line++;
      if (firstText === 0 && text.trim()) firstText = line;
      if (!bodyHasMatch && firstText > 0) break;
      if (text !== previous) score = matcher.score(text);
      previous = text;
      if (score) add(line, line, bodyBase + 2 * score);
      if (best.length === 3 && best[2].score >= maxBodyScore && line >= best[2].startLine) break;
    }
    if (firstText && useStart) add(firstText, firstText, pathScore + (isEntry ? 9 : 3));
  }
  return best;
}

export function retrieveRepositoryContext(
  store: Store,
  analysis: ProjectAnalysis,
  question: string,
  options: { inputTokens: number; priorQuestions?: string[] },
): RepositoryContext {
  const snapshotId = analysis.project.id;
  const context: RepositoryContext = {
    snapshotId,
    excerpts: [],
    dependencies: [],
    estimatedTokens: 0,
  };
  if (!Number.isSafeInteger(options.inputTokens) || contextTokens(context) > options.inputTokens) {
    throw new RangeError('The input budget is too small for the repository context.');
  }

  const safeFiles = new Map(
    analysis.files.filter((file) => !isSensitiveAiPath(file.path)).map((file) => [file.path, file]),
  );
  const entryPaths = new Set(analysis.entryPoints.map((entry) => entry.path));
  const priorQuestions = options.priorQuestions ?? [];
  const matcher = queryMatcher(question, priorQuestions);
  const query = question.slice(0, 4_096).toLowerCase();
  const previous = priorQuestions
    .slice(-3)
    .map((prior) => prior.slice(0, 2_048))
    .join(' ')
    .toLowerCase();
  const architectureOverview =
    !matcher.hasTerms ||
    /\b(?:overview|architecture|structure|entry[\s-]*points?)\b|(?:обзор|архитектур|структур|точк\p{L}*\s+вход)/iu.test(
      query,
    );
  const eligible = new Set<string>();
  const primary: Candidate[] = [];

  for (const [path, source] of store.sourceEntries(snapshotId)) {
    const file = safeFiles.get(path);
    if (!file || !source.trim() || hasSensitiveAiSource(source)) continue;
    eligible.add(path);
    const normalized = path.toLowerCase();
    const explicit = query.includes(normalized) ? 65 : previous.includes(normalized) ? 19 : 0;
    const pathScore = explicit + 3 * matcher.score(splitIdentifier(path));
    primary.push(
      ...sourceCandidates(
        source,
        file,
        pathScore,
        matcher,
        entryPaths.has(path),
        architectureOverview,
      ),
    );
  }
  primary.sort(compareCandidates);

  const focus = new Map<string, number>();
  for (const candidate of primary) {
    if (!focus.has(candidate.path)) focus.set(candidate.path, candidate.score);
    if (focus.size === 8) break;
  }
  const relationships: Relationship[] = [];
  for (const edge of analysis.edges) {
    if (!eligible.has(edge.source) || !eligible.has(edge.target)) continue;
    const score = Math.max(focus.get(edge.source) ?? 0, focus.get(edge.target) ?? 0);
    if (!score) continue;
    const lines = safeFiles.get(edge.source)!.lines;
    const reference = edge.references.find(
      (ref) =>
        ref.path === edge.source &&
        validRange(ref, lines) &&
        ref.endLine - ref.startLine < maxExcerptLines,
    );
    if (reference)
      relationships.push({ reference, source: edge.source, target: edge.target, score });
  }
  relationships.sort(
    (a, b) =>
      b.score - a.score || comparePaths(a.source, b.source) || comparePaths(a.target, b.target),
  );
  const rankedEdges = relationships.slice(0, maxEdges);
  const candidates = [...primary];
  for (const edge of rankedEdges) {
    candidates.push({ ...edge.reference, score: 13 + Math.floor(edge.score / 2) });
    if (!focus.has(edge.target))
      candidates.push({
        path: edge.target,
        startLine: 1,
        endLine: 1,
        score: 10 + Math.floor(edge.score / 3),
      });
  }
  candidates.sort(compareCandidates);

  const selectedCounts = new Map<string, number>();
  const readSource = store.sourceReader(snapshotId);
  const excerptBudget =
    rankedEdges.length === 0
      ? options.inputTokens
      : options.inputTokens - Math.min(230, Math.floor(options.inputTokens * 0.1));
  for (const candidate of candidates.slice(0, 100)) {
    if (context.excerpts.length === maxExcerpts) break;
    const { path } = candidate;
    const count = selectedCounts.get(path) ?? 0;
    if (count >= 2 || context.excerpts.some((existing) => covers(existing, candidate))) continue;
    const file = safeFiles.get(path);
    const source = readSource(path);
    if (!file || source === undefined) continue;
    const id = `S${context.excerpts.length + 1}`;
    const excerpt = excerptFor(source, file, candidate, id, (value) => {
      if (context.excerpts.some((existing) => sameSpan(existing, value))) return false;
      context.excerpts.push(value);
      const fits = contextTokens(context) <= excerptBudget;
      context.excerpts.pop();
      return fits;
    });
    if (excerpt) {
      context.excerpts.push(excerpt);
      selectedCounts.set(path, count + 1);
    }
  }

  for (const { source, target, reference } of rankedEdges) {
    const evidence = context.excerpts.find((excerpt) => covers(excerpt, reference));
    if (!evidence) continue;
    context.dependencies.push({ source, target, evidence: evidence.id });
    if (contextTokens(context) > options.inputTokens) context.dependencies.pop();
  }
  contextTokens(context);
  return context;
}

export function verifyRepositoryCitations(
  store: Store,
  analysis: ProjectAnalysis,
  context: RepositoryContext,
  ids: readonly string[],
): RepositoryContextExcerpt[] {
  if (context.snapshotId !== analysis.project.id) return [];
  const files = new Map(analysis.files.map((file) => [file.path, file]));
  const excerpts = new Map<string, RepositoryContextExcerpt | undefined>();
  for (const excerpt of context.excerpts.slice(0, maxExcerpts)) {
    excerpts.set(excerpt.id, excerpts.has(excerpt.id) ? undefined : excerpt);
  }

  const verified: RepositoryContextExcerpt[] = [];
  const readSource = store.sourceReader(context.snapshotId);
  for (const id of new Set(ids.slice(0, 64))) {
    if (!/^S[1-9]\d{0,2}$/u.test(id)) continue;
    const excerpt = excerpts.get(id);
    if (!excerpt || isSensitiveAiPath(excerpt.path)) continue;
    const file = files.get(excerpt.path);
    if (
      !file ||
      !validRange(excerpt, file.lines) ||
      excerpt.endLine - excerpt.startLine >= maxExcerptLines
    )
      continue;
    const source = readSource(excerpt.path);
    if (source === undefined || hasSensitiveAiSource(source)) continue;
    const offsets = lineOffsets(source, file, excerpt.startLine, excerpt.endLine);
    if (offsets.length !== excerpt.endLine - excerpt.startLine + 1) continue;
    const expected = source.slice(offsets[0].start, offsets[offsets.length - 1].end);
    if (
      !expected.trim() ||
      expected !== excerpt.source ||
      Buffer.byteLength(expected, 'utf8') > maxExcerptBytes
    )
      continue;
    verified.push(excerpt);
  }
  return verified;
}
