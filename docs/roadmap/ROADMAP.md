# Roadmap

| Milestone              | Acceptance criteria                                                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0. Foundation          | Install from the lockfile. Typecheck, lint, format, test and build locally. Provide contributor and security documentation and CI.                 |
| 1. Local application   | Launch on loopback, choose a readable local folder and see real project metadata. Bundle a repository that works offline.                          |
| 2. Static analysis     | Discover supported source safely. Report deterministic imports, exports, symbols, entries, diagnostics and resolved edges with source locations.   |
| 3. Exploration         | Search and filter files, inspect numbered source, and navigate a pan-and-zoom graph linked to the explorer.                                        |
| 4. Optional AI         | Configure a model, cite the submitted file range, reject unapproved remote requests and keep credentials ephemeral.                                |
| 5. GitHub import       | Import a bounded public snapshot, retain its SHA and use the local cache for repeated analysis.                                                    |
| 6. Release preparation | Export Markdown and JSON. Verify the critical user flow and exercise CI on Windows, macOS and Linux. Prepare publication for operator approval.    |
| 7. Repository AI       | Discover local models, retrieve bounded snapshot evidence, stream and stop answers, and open verified line ranges in the explorer.                 |
| 8. Code Routes         | Trace direct calls, inspect evidence, save steps, refresh unchanged parses, and compare analyzed files and relationships against a prior revision. |
| 9. Map navigation      | Expand groups in place, inspect the verified imports behind each connection, and return to the preceding map view.                                 |

## Next priorities

1. Add path finding between two files and a directional view for transitive importers.
2. Extend route detection with more framework forms, then test recall and evidence quality on real projects.
3. Evaluate retrieval and refresh quality on larger projects and improve module resolution in monorepos.
4. Add additional language parsers through the same discovery and snapshot pipeline. Choose the next language based on the repositories users want to explore.
5. Profile large real repositories and compare native parsers or indexing components where CPU use or memory limits dominate.
