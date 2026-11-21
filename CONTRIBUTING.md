# Contributing to Arqivanta

Start with the [README](README.md) and [roadmap](docs/roadmap/ROADMAP.md). Use the lockfile to install the workspace and run `pnpm dev`. The bundled Field Notes project provides a small offline repository for testing changes.

Keep contributions focused and include the motivation and verification commands when proposing a change. Add a small source fixture for analyzer changes and state which module resolution rules it covers. Keep network tests deterministic by mocking public GitHub or provider responses. When adding a provider, document where credentials and source are sent and test the consent boundary.

Run `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm build`, and relevant Playwright tests before review. For UI changes, check keyboard navigation and a narrow viewport. Use English in code comments, user-facing strings, documentation and review discussions. See [AGENTS.md](AGENTS.md) for package ownership and architecture rules.

Follow our [code of conduct](CODE_OF_CONDUCT.md). For security reports, see [SECURITY.md](SECURITY.md).
