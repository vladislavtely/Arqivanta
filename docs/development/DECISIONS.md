# Development decisions

## Local web application first

React and Fastify provide a shared application workflow across operating systems. Development uses Vite, and the production build serves the compiled UI from Fastify. Node 24 runs erasable server TypeScript and supplies SQLite directly. This keeps desktop shell work and native database dependencies out of the first implementation.

## Resolve from an indexed snapshot

The analyzer uses separate syntax parsers for JS/TS and Python. Discovery enforces filesystem boundaries before parsing and reads eligible files in bounded batches. Module resolution consults the in-memory index, which preserves reproducibility and keeps repository configuration from expanding filesystem scope. A worker enforces a hard deadline and a heap limit around analysis.

## Measure before adding native components

On the generated large-project benchmark, filesystem reads and snapshot lookup were the first bottlenecks. The scanner now reads concurrently and SQLite indexes source lookups. Use the benchmark to evaluate future incremental indexing, parsing, and module-resolution work. A native Rust component is a candidate when profile data identifies a CPU or memory bottleneck and compatibility tests can measure its effect.

## Keep source with the graph

SQLite stores the recent analyses and their source snapshots together. This preserves line references if a local file changes or a downloaded archive is removed. GitHub cache keys include the repository URL and commit SHA. The service keeps 16 snapshots to bound retained data. Exports contain source references and graph metadata.

## Project a bounded architecture map

Index the folder tree and verified edges once per snapshot. In the grouped view, each file resolves to a visible file node or its nearest visible folder. Aggregate directed dependencies between these endpoints and keep references to the original file edges for the inspector. Cap the graph passed to React Flow and page the evidence list separately. Defer graph search rendering so the input stays responsive. [Nx workspace graph](https://nx.dev/docs/features/explore-graph) · [React Flow performance](https://reactflow.dev/learn/advanced-use/performance)

## Treat AI as an explicit action

Providers share a bounded request contract. Explanations use one excerpt and expose its verified range. Repository chat uses deterministic lexical and one-hop dependency retrieval over the current snapshot. Each selected excerpt receives an ID scoped to that question. The server verifies claimed IDs against the submitted ranges, and the explorer opens the immutable snapshot. The browser keeps settings, credentials, and chat in memory. Each remote discovery or generation request requires consent.

## Trace from source and compare immutable revisions

Record call expressions and framework registrations during each language parser's syntax pass. Resolve direct bindings against the analyzed import graph. Keep an explicit unresolved state for dispatch that cannot be linked from the available syntax. Compare snapshots through bounded reverse traversals so each affected result includes its reason. Preserve source ranges by snapshot and allow saved individual steps to retain the version last reviewed.

Reuse complete syntax records by versioned content hash. Rebuild resolution from the current snapshot's file set to account for new files, deletions and configuration edits. Keep raw Git reads constrained to supported source within the selected working folder's subtree. [TypeScript Compiler API](https://github.com/Microsoft/TypeScript/wiki/Using-the-Compiler-API) · [GitHub stack graphs](https://github.blog/open-source/introducing-stack-graphs/) · [Git tree listings](https://git-scm.com/docs/git-ls-tree)
