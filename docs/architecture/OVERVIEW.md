# Architecture

The browser sends a local folder path, a sample selection, or a public GitHub URL to Fastify. The server resolves the input, runs an isolated TypeScript analysis worker, and saves the resulting graph and source snapshot in SQLite. The web app reads graph and source data by snapshot ID. Download and AI routes use that same snapshot so source references consistently identify the file content that was analyzed.

| Package                               | Responsibility                                                      |
| ------------------------------------- | ------------------------------------------------------------------- |
| `apps/web`                            | React interface, React Flow canvas, source viewer and settings      |
| `apps/server`                         | Loopback API, request guards, worker deadlines and orchestration    |
| `packages/shared`                     | Shared types for files, source references, projects and edges       |
| `packages/core`                       | SQLite snapshots and context export                                 |
| `packages/analyzer-typescript`        | Bounded file discovery, AST facts and module resolution             |
| `packages/graph-engine`               | Dependency graph filtering and layout                               |
| `packages/ai-provider`                | Provider contract, bounded transport, consent and grounded requests |
| `packages/provider-ollama`            | Ollama model requests                                               |
| `packages/provider-openai-compatible` | OpenAI-compatible chat requests                                     |
| `packages/github-import`              | Public repository metadata and bounded snapshot extraction          |

The analyzer considers a relationship verified when a parsed module specifier resolves to a file in the repository snapshot. Package externals and specifiers with no confirmed target remain visible in import details. Edge references point to the importing file and declaration lines. Static output can’t establish runtime behavior for computed or conditional imports and custom build resolvers.

Development serves the web app at `127.0.0.1:5173` and proxies `/api` to Fastify at port `4317`. The local production build serves both from Fastify. The desktop package is reserved for the future Tauri shell. The web application and analyzer run without cloud services.
