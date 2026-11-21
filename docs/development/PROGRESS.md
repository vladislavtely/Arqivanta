# Development progress

**Current milestone** — Milestone 6, release preparation for v0.1.

| Milestone              | Status on 2026-11-22                                                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 0. Foundation          | pnpm workspace, TypeScript, linting, formatting, unit and browser tests, documentation and CI workflow are in place.               |
| 1. Local application   | The loopback app opens a local folder or bundled example and lists recent snapshots from SQLite.                                   |
| 2. Analysis            | TypeScript AST analysis captures imports, exports, symbols, entry points, diagnostics, and local edges with source locations.      |
| 3. Exploration         | The file explorer, source viewer and architecture map work with actual analyzer output.                                            |
| 4. Optional AI         | Ollama and OpenAI-compatible providers use bounded excerpts, explicit remote consent, and verified source ranges.                  |
| 5. GitHub import       | The importer resolves and downloads public commit snapshots within fixed limits. SQLite caches analyses by repository URL and SHA. |
| 6. Release preparation | Context exports, release documentation, and local verification are in place. Hosted CI and publication approval are pending.       |

## Verification

- Windows passed lint, formatting, production build, all 30 Vitest tests, and all three Playwright scenarios in Chrome. The browser scenarios cover local import, graph-to-source navigation, export, a narrow viewport, and AI consent.
- Ubuntu under WSL installed from the frozen lockfile, passed lint and all 30 Vitest tests, and built the app.
- The public `sindresorhus/yocto-queue` import parsed eight files and resolved two local dependencies. A second import of the same commit reused its cached snapshot.
- The locally installed Ollama model `qwen2.5-coder:3b` explained three lines from the bundled example. Arqivanta returned the corresponding snapshot path and line range. OpenAI-compatible behavior was checked with deterministic fixtures.
- **Browse folders** opens the native Windows folder dialog from Overview and starts analysis after selection. A live Chrome session verified the native selection flow. Automated coverage also checks cancellation, the address field, and the unavailable-picker fallback.
- The Windows picker now creates its dialog with per-monitor DPI awareness. A Win32 probe verified that windows inherit Per-Monitor V2 at 144 DPI and that the original thread context is restored afterward.

Run the GitHub Actions matrix against the intended release commit after publication is authorized. Verify macOS, confirm the maintainer’s private reporting channel, and tag v0.1 after the checks pass. See [known issues](KNOWN_ISSUES.md) for current limits.

## Large projects and Python

- Analysis now loads separate JS/TS and Python parsers as needed, searches a bounded local filesystem snapshot, and indexes source text by file in SQLite. Explorer pages and graph limits keep the browser view bounded while preserving full-snapshot search and exports.
- On the Windows synthetic benchmark, median analysis time for 2,000 files fell from 3.47 to 1.72 seconds across three runs of each version. Median time for 100 SQLite source reads fell from 84.1 to 0.4 milliseconds. Peak process RSS on the same workload was approximately 137 MiB before and 136 MiB after. The new analysis measurement includes loading the language adapter on demand.
- A full API import processed 10,000 generated TypeScript files and 9,999 dependency edges in 7.72 seconds, with no reported diagnostics. These results describe the generated workloads. Real repositories vary with source size, module resolution, storage, and hardware.
- A CPU profile of the generated 5,000-file fixture sampled about 435 milliseconds inside TypeScript parsing and AST extraction during a 3.31-second analysis. Use profiles from real repositories to choose a native acceleration target.
- Windows passed lint, formatting, the production build, all 34 Vitest tests, and all six Chrome scenarios. The browser suite covers a large file tree, graph limits and search, Python imports, and the selected-file graph scope.

## Architecture Map clarity

- Dense snapshots open in a folder overview with one directed link per pair of connected folders. Users can inspect cross-folder imports or open a folder to see its files. Reciprocal connection counts are offset for readability.
- Selecting a file or folder highlights outgoing imports with a solid cyan stroke and incoming imports with a dashed amber stroke. File focus shows only direct imports and importers. Nodes can be dragged within the active layout and reset to automatic positions.
- A generated snapshot with 138 files and 404 dependencies showed three folders and three directional folder connections. Browser coverage verifies dragging, resetting, folder navigation, and both import directions.
