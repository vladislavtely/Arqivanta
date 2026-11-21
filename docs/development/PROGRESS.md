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

Run the GitHub Actions matrix against the intended release commit after publication is authorized. Verify macOS, confirm the maintainer’s private reporting channel, and tag v0.1 after the checks pass. See [known issues](KNOWN_ISSUES.md) for current limits.
