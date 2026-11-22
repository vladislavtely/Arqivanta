# Arqivanta

**Understand any codebase. Use any AI. Own your data.**

Arqivanta is a local-first explorer for JavaScript, TypeScript, and Python repositories. Read source files, follow imports from a dependency map, inspect entry points, and export context for coding agents. Repository analysis and exploration work offline.

## Run locally

Install Node.js 24.15 or newer and pnpm 11.25.0, then run the following from the workspace.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm start
```

Open [http://127.0.0.1:4317](http://127.0.0.1:4317). On Windows, choose **Browse folders**, navigate to a project in the Windows folder dialog, and choose **Select folder**. Analysis starts automatically. You can also enter an absolute folder path, choose **Open example** to explore Field Notes, or use **Import from GitHub** with a public `https://github.com/owner/repository` URL. For development, run `pnpm dev` and open [http://127.0.0.1:5173](http://127.0.0.1:5173).

On Windows, an already built app can also be started with `node .\apps\server\src\index.ts` if the terminal cannot find pnpm.

## Explore a snapshot

- **Explorer** includes a searchable file tree, numbered source, imports and exports, symbols, related files, and analysis diagnostics. Select an import to follow a resolved link. Large file trees show 250 files per page while search covers the full snapshot.
- **Architecture Map** shows statically resolved local dependencies. Dense maps open in **Folders**, where a single link summarizes imports between two folders. Open a folder to see its files. Choose **Focus on file** to see its direct imports and importers. Outgoing links are solid and incoming links are dashed. Drag nodes to rearrange the view and use **Reset layout** to restore their positions.
- **Code Routes** follows direct calls from named functions and recognized Fastify or FastAPI routes. Select a call site or definition to highlight its source range. Save a trace, refresh the working folder, then review and update the saved steps that changed. The initial code analysis is sufficient to use these tools offline with AI disabled.
- **Compare changes** in Code Routes compares the open snapshot with a previous snapshot from the same project or with local Git HEAD. Refresh the snapshot to include recent working folder edits. The report shows changed files, functions, routes, import links, and evidence chains for potentially affected callers and importers. The test filter identifies test files reached through import links.
- **Export Center** exports Markdown or JSON with file paths, entry points, verified edges and line ranges, and dependency notes. Exports omit source bodies.
- **Repository AI Assistant** answers questions using excerpts and resolved imports from the current snapshot. The **Explain a file** tab still supports a selected file and optional line range.

On large snapshots, the map shows up to 350 files and 1,200 dependencies at a time. Its counts show when the view is limited. Search operates on all files in the current scope, and the explorer and exports use the full snapshot. The analyzer scans up to 10,000 supported files or 32 MiB of source, subject to its safety and time limits.

Use **Refresh snapshot** to analyze an open local folder again. Source hashes let the analyzer reuse unchanged file parses. It then resolves relationships against the new file list so added and removed modules are reflected. Open a local folder again to enable refresh for snapshots created before this feature.

Open `examples/python-tasks` as a local project to try Python analysis. Arqivanta finds local imports, top-level functions and classes, and conventional entry files from `.py` and `.pyi` source.

## Connect a model

1. Open an analyzed project, then choose **Repository AI Assistant** and enable AI.
2. For Ollama, start the local server with a model already installed and use `http://127.0.0.1:11434`. For LM Studio, start its local server with a chat-capable model and select **OpenAI-compatible** with `http://127.0.0.1:1234/v1`. For another compatible service, enter its base URL and an API key if required. [Ollama API](https://docs.ollama.com/api/tags) · [LM Studio compatibility](https://lmstudio.ai/docs/developer/openai-compat)
3. Choose **Discover models** to test the connection and select a model, or enter the installed model ID manually. Set the context window to fit your model. Configure the model's context length in the inference server as needed for OpenAI-compatible endpoints.
4. Open **Ask Repository** and ask about a file, symbol, entry point, dependency, or feature. **Preview context** shows the proposed excerpts locally. Select a file path and line range shown next to a cited statement to open those lines in the explorer. Use **Stop response** to interrupt generation.

If local inference starts slowly, try a context window of 4,096 or 8,192 tokens. A larger window can increase memory use in Ollama. Repository chat allows a slow stream to continue as long as the provider sends data and reports a timeout after two minutes without data. [Ollama context length](https://docs.ollama.com/context-length)

Search uses paths, symbol names, source text and resolved dependencies. It recognizes common questions about startup, authentication, databases and imports in Russian as well as English. Precise file and symbol names help when the repository uses domain-specific terms. Compare generated answers with their source references.

## Local data and outbound requests

Arqivanta opens repositories read-only and takes bounded snapshots. It skips conventional secret paths, ignored files, symlinks, and dependency and build directories. Treat the local SQLite cache as source code. It stores the latest 16 analyzed snapshots in `.arqivanta/projects.sqlite` by default. Set `ARQIVANTA_DATA_DIR` to choose another location.

GitHub imports use the public default-branch commit and record its SHA. AI starts off. Testing a model connection sends a model-list request and the configured API key, if any. Asking a question sends the question, a short history of prior questions, and the selected excerpts and import evidence to the configured provider. File explanation sends part of one file. Remote discovery and inference each require explicit consent. Use a trusted loopback server to keep inference on your machine and check whether it can forward requests. API keys and conversations stay in memory in the current browser session. See [security](SECURITY.md) for the trust model and limits.

## Development

Run `pnpm lint`, `pnpm format:check`, `pnpm test`, and `pnpm build`. After a build, install a Playwright browser with `pnpm exec playwright install chromium` and run `pnpm test:e2e`. Set `ARQIVANTA_TEST_BROWSER=chrome` to use an installed copy of Google Chrome. Set `ARQIVANTA_TEST_PORT` if port `4321` is in use.

Use `node scripts/benchmark-analysis.mjs 2000` to measure analysis, storage, and 100 source reads on a generated project. Use `node scripts/benchmark-analysis.mjs 10000 --api` to measure a full import through the API worker. Use `--refresh` to measure the import and a subsequent refresh after editing one file.

See [architecture](docs/architecture/OVERVIEW.md), [roadmap](docs/roadmap/ROADMAP.md), [progress](docs/development/PROGRESS.md), and [contributing](CONTRIBUTING.md).

Arqivanta is licensed under the [MIT License](LICENSE).
