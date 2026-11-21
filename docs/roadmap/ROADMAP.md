# Roadmap

| Milestone              | Acceptance criteria                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0. Foundation          | Install from the lockfile. Typecheck, lint, format, test and build locally. Provide contributor and security documentation and CI.               |
| 1. Local application   | Launch on loopback, choose a readable local folder and see real project metadata. Bundle a repository that works offline.                        |
| 2. Static analysis     | Discover supported source safely. Report deterministic imports, exports, symbols, entries, diagnostics and resolved edges with source locations. |
| 3. Exploration         | Search and filter files, inspect numbered source, and navigate a pan-and-zoom graph linked to the explorer.                                      |
| 4. Optional AI         | Configure a model, cite the submitted file range, reject unapproved remote requests and keep credentials ephemeral.                              |
| 5. GitHub import       | Import a bounded public snapshot, retain its SHA and use the local cache for repeated analysis.                                                  |
| 6. Release preparation | Export Markdown and JSON. Verify the critical user flow and exercise CI on Windows, macOS and Linux. Prepare publication for operator approval.  |

After release, evaluate native desktop folder selection with Tauri, broader language support, and more precise module resolution for larger monorepos and build systems.
