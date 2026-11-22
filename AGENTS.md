# Arqivanta development guide

Arqivanta helps developers understand unfamiliar codebases with local, reproducible static analysis. Maintain a fully functional workflow with AI disabled. Write public text, comments, accessible names, and contributor documentation in English.

## Architecture rules

- Keep browser code in `apps/web`, loopback HTTP and worker orchestration in `apps/server`, and reusable logic in the package that owns its responsibility.
- Put contracts used across packages in `packages/shared`. Use type-only imports where appropriate and explicit `.ts` extensions for relative server and package imports that run in Node.
- Treat analyzed source, archive entries, configuration and model responses as untrusted. Resolve module links against discovered files, keep source tied to its snapshot, and never execute source or install its dependencies.
- Keep AI off initially. Require consent before code leaves the machine. Keep credentials ephemeral and propagate actionable errors without echoing credentials or remote response bodies.
- Ground repository answers in bounded excerpts and verified import evidence from one immutable snapshot. Resolve model citation IDs against the submitted excerpts and the same snapshot before making them clickable. Keep generation read-only and cancel upstream work when the browser disconnects.
- Maintain strict TypeScript, use accessible React controls, and preserve verified path and line ranges across the explorer, API and exports.

## Workflow

Inspect the relevant implementation and roadmap. Land independent changes in the owning package, add coverage for changed behavior, run the relevant checks, and update progress, decisions, and known issues. Ask before external publication, paid services, or destructive actions. Preserve existing user files and history.

```sh
pnpm lint
pnpm format:check
pnpm test
pnpm build
pnpm test:e2e
```

Use the Playwright Chromium installed for the project or set `ARQIVANTA_TEST_BROWSER` to an installed browser channel. Verify the local import and graph against real fixtures and keep remote tests deterministic by default.

Use deterministic local provider fixtures for AI tests. They should cover consent, streaming, stop, and citation navigation without requiring a model or contacting an external service.
