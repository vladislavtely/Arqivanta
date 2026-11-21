# Architecture

The browser asks Fastify to open a local folder, the sample, or a public GitHub repository. On Windows, the server can open the system folder dialog and resolve the folder the user selects. It runs an isolated TypeScript analysis worker and saves the resulting graph and source snapshot in SQLite. The web app reads graph and source data by snapshot ID. Download and AI routes use that same snapshot so source references consistently identify the file content that was analyzed.

| Package                               | Responsibility                                                      |
| ------------------------------------- | ------------------------------------------------------------------- |
| `apps/web`                            | React interface, React Flow canvas, source viewer and settings      |
| `apps/server`                         | Loopback API, request guards, worker deadlines and orchestration    |
| `packages/shared`                     | Shared types for files, source references, projects and edges       |
| `packages/core`                       | SQLite snapshots and context export                                 |
| `packages/analyzer`                   | Bounded file discovery and language routing                         |
| `packages/analyzer-typescript`        | JS/TS parsing and TypeScript module resolution                      |
| `packages/analyzer-python`            | Python syntax parsing and local module resolution                   |
| `packages/graph-engine`               | Dependency graph filtering and layout                               |
| `packages/ai-provider`                | Provider contract, bounded transport, consent and grounded requests |
| `packages/provider-ollama`            | Ollama model requests                                               |
| `packages/provider-openai-compatible` | OpenAI-compatible chat requests                                     |
| `packages/github-import`              | Public repository metadata and bounded snapshot extraction          |

The analyzer considers a relationship verified when a parsed module specifier resolves to a file in the repository snapshot. Package externals and specifiers with no confirmed target remain visible in import details. Edge references point to the importing file and declaration lines. Static output can’t establish runtime behavior for computed or conditional imports and custom build resolvers.

The analyzer loads a language parser only when the snapshot contains its source files. New snapshots store source text by project ID and path in SQLite. Earlier snapshots remain readable through their original source field. The graph caps the number of visible files and edges while keeping the complete snapshot available to search and exports.

Development serves the web app at `127.0.0.1:5173` and proxies `/api` to Fastify at port `4317`. The local production build serves both from Fastify. The desktop package is reserved for the future Tauri shell. The web application and analyzer run without cloud services.
