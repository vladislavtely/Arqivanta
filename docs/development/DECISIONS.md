# Development decisions

## Local web application first

React and Fastify provide a shared application workflow across operating systems. Development uses Vite, and the production build serves the compiled UI from Fastify. Node 24 runs erasable server TypeScript and supplies SQLite directly. This keeps desktop shell work and native database dependencies out of the first implementation.

## Resolve from an indexed snapshot

The analyzer uses the TypeScript Compiler API to parse source and locate module references. Discovery enforces filesystem boundaries before parsing. Module resolution consults the in-memory index, which preserves reproducibility and keeps repository configuration from expanding filesystem scope. A worker enforces a hard deadline and a heap limit around analysis.

## Keep source with the graph

SQLite stores the recent analyses and their source snapshots together. This preserves line references if a local file changes or a downloaded archive is removed. GitHub cache keys include the repository URL and commit SHA. The service keeps 16 snapshots to bound retained data. Exports contain source references and graph metadata.

## Treat AI as an explicit action

Providers share a bounded request contract. Explanations use one excerpt and expose its verified line range separately from model-generated text. The browser holds provider settings and credentials only for the current session. Sending code to remote inference requires an explicit setting.
