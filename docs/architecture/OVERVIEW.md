# Architecture

The browser asks Fastify to open a local folder, the sample, or a public GitHub repository. On Windows, the server can open the system folder dialog and resolve the folder the user selects. It runs an isolated TypeScript analysis worker and saves the resulting graph and source snapshot in SQLite. The web app reads graph and source data by snapshot ID. Download and AI routes use that same snapshot so source references consistently identify the file content that was analyzed.

| Package                               | Responsibility                                                      |
| ------------------------------------- | ------------------------------------------------------------------- |
| `apps/web`                            | React interface, graph, source viewer and repository chat           |
| `apps/server`                         | Loopback API, analyzer worker and streaming AI orchestration        |
| `packages/shared`                     | Shared types for files, source references, projects and edges       |
| `packages/core`                       | SQLite snapshots, context export, retrieval and citation checks     |
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

## Audit before repository chat

- The existing file explanation route reads an immutable SQLite snapshot, clamps an excerpt to a fixed line and character budget, and attaches a reference to the range it sent. The browser has opt-in settings, an explanation form, and a numbered source viewer. These are the entry points to extend.
- Snapshots already contain file paths, symbol and export locations, entry points, and directed dependency edges with import locations. Source lookup is indexed by snapshot ID and path. Repository-wide content search and relevance ranking are new capabilities.
- Both adapters share a bounded HTTP transport with deadlines, loopback handling, HTTPS and public-address checks for remote endpoints, and redirect rejection. The existing completion interface buffers one JSON response. Model discovery and incremental response parsing can reuse the transport checks.
- Credentials and consent live in memory. The server enforces consent for remote endpoints and checks Ollama model metadata for cloud forwarding. Repository text and model output are untrusted. Any new clickable reference must be resolved by Arqivanta against the same snapshot and restricted to the submitted context.

## Repository assistant request flow

1. The browser opts in and can discover model IDs with a separate request. Previewing context only reads the selected SQLite snapshot.
2. Core ranks matches from paths, symbols, entry points and source text, then considers nearby dependencies. A directed edge is included only when a selected excerpt covers the import that established it. Core caps excerpts and estimates the token cost from their serialized UTF-8 size.
3. The server places the question and evidence in a JSON payload, reserves space for the model's answer, and sends the payload with separate system instructions. Ollama streams newline-delimited JSON. OpenAI-compatible services stream Server-Sent Events. Arqivanta forwards text as newline-delimited JSON to the browser, cancels inference on disconnect and enforces a two-minute inactivity timeout and a response size limit on the provider stream.
4. At completion, the server resolves citation IDs against the submitted excerpts and rechecks paths, ranges and text in the same snapshot. The UI shows verified paths and line ranges inline next to the claims that cite them. The explorer opens the cited file and highlights the referenced range.

## Code routes and change impact

The TypeScript and Python adapters record direct call sites and supported HTTP registrations alongside imports and symbols. Module resolution maps imports to analyzed files. Core uses these records to resolve calls to unique definitions in the same snapshot. Each route step carries its own source location. The walk stops at repeated definitions or its depth and step limits. Ambiguous targets retain a link to the expression in the source.

Refresh hashes the working folder's eligible source files. A prior parse is reusable when its path, raw bytes and parser version match and the original parse completed without diagnostics or truncation. The analyzer rebuilds import relationships from the current file set. The server stores the local working folder path in SQLite for refresh and groups saved traces by workspace identity.

Git comparison resolves HEAD once, reads eligible blobs by immutable object ID, then analyzes a temporary bounded snapshot. It uses read-only Git commands and raw blob reads. Core compares both analyzed snapshots and traverses reverse imports and direct calls to find shortest evidence chains. Test paths are recognized by common naming conventions. Saved traces keep evidence hashes and snapshot IDs so individual steps can be revalidated and updated across revisions.
