# Security

Report suspected vulnerabilities privately to a project maintainer. Once a public repository has a private reporting channel, use it. Include the Arqivanta version, impact, and minimal steps or a synthetic fixture. Keep real source, tokens, and personal data out of reports.

## Local trust model

The HTTP server binds to `127.0.0.1`. It checks Host, Origin and browser fetch metadata and accepts JSON for state-changing API requests. The service trusts processes already running on the same machine. Use it on your own workstation. Analysis opens the supplied local folder explicitly and runs in a bounded worker. The analyzer reads files as text and resolves dependency edges from its in-memory index. It treats linked, ignored and conventional sensitive paths as out of scope.

GitHub fetching uses a constrained public GitHub URL and records the resolved SHA. It allows at most 24 MiB compressed, 96 MiB unpacked, and 10,000 paths. Analysis limits include 10,000 files, 384 KiB per file, 32 MiB of source, and 100,000 directory entries per snapshot. Filesystem reads use bounded concurrent batches and retain the same path and link checks. Source views and context exports read the cached snapshot by ID. The cache contains source text and remains on your disk. Use operating-system account protections and choose an appropriate data directory.

## AI requests

AI is off until enabled. Model discovery sends provider credentials if configured and no repository context. Previewing context is a local SQLite operation. Asking about a repository sends the question, up to three prior questions, and a bounded collection of excerpts and resolved imports from the current snapshot. A single-file explanation sends up to 120 lines and 10,000 characters. The AI source filter skips conventional sensitive paths and source that matches common credential patterns. Review context before sending it because these checks cannot detect every secret.

Each remote provider action requires explicit consent. The server requires HTTPS and public addresses for remote traffic, rejects redirects, and checks Ollama model metadata before allowing unconsented requests to a loopback model. A trusted loopback service can still forward traffic. Check its configuration. Keys are kept in memory and are used for provider authentication. Arqivanta does not collect telemetry.

Repository text is data supplied to the model. The assistant exposes no execution tools and does not write to the repository. Model output is rendered as text. Citation links are created from application-verified ranges in the submitted snapshot. A citation establishes that the cited range exists in the provided context. Review the range to confirm that it substantiates the model's claim.
