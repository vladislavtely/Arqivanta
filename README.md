# Arqivanta

**Understand any codebase. Use any AI. Own your data.**

Arqivanta is a local-first explorer for JavaScript and TypeScript repositories. Read source files, follow imports and exports from a dependency map, inspect entry points, and export context for coding agents. Repository analysis and exploration work offline.

## Run locally

Install Node.js 24.15 or newer and pnpm 11.25.0, then run the following from the workspace.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm start
```

Open [http://127.0.0.1:4317](http://127.0.0.1:4317). Choose **Open example** to explore Field Notes, or enter the absolute path to a local project folder. Use **Import from GitHub** for a public `https://github.com/owner/repository` URL. For development, run `pnpm dev` and open [http://127.0.0.1:5173](http://127.0.0.1:5173).

## Explore a snapshot

- **Explorer** includes a searchable file tree, numbered source, imports and exports, symbols, related files, and analysis diagnostics. Select an import to follow a resolved link.
- **Architecture Map** shows statically resolved local dependencies. Pan, zoom, filter, and select a file to inspect its relationships and open its source.
- **Export Center** exports Markdown or JSON with file paths, entry points, verified edges and line ranges, and dependency notes. Exports omit source bodies.
- **AI Settings** is optional. Enable it, enter an Ollama or OpenAI-compatible endpoint and installed model name, then request an explanation for a file. A loopback Ollama server typically listens at `http://127.0.0.1:11434`. An OpenAI-compatible API base typically includes `/v1`. The explanation includes the range Arqivanta provided as context. Review generated text against the source.

## Local data and outbound requests

Arqivanta opens repositories read-only and takes bounded snapshots. It skips conventional secret paths, ignored files, symlinks, and dependency and build directories. Treat the local SQLite cache as source code. It stores the latest 16 analyzed snapshots in `.arqivanta/projects.sqlite` by default. Set `ARQIVANTA_DATA_DIR` to choose another location.

Outbound requests occur when you import a public repository or request an AI explanation. GitHub imports use the public default-branch commit and record its SHA. For AI, inspect the selected file and endpoint before approving a request. Use a trusted local inference server when you need to keep code on your machine, and check whether the server can forward requests. AI starts off and API keys stay in the current session. See [security](SECURITY.md) for the trust model and limits.

## Development

Run `pnpm lint`, `pnpm format:check`, `pnpm test`, and `pnpm build`. After a build, install a Playwright browser with `pnpm exec playwright install chromium` and run `pnpm test:e2e`. Set `ARQIVANTA_TEST_BROWSER=chrome` to use an installed copy of Google Chrome. Set `ARQIVANTA_TEST_PORT` if port `4321` is in use.

See [architecture](docs/architecture/OVERVIEW.md), [roadmap](docs/roadmap/ROADMAP.md), [progress](docs/development/PROGRESS.md), and [contributing](CONTRIBUTING.md).

Arqivanta is licensed under the [MIT License](LICENSE).
