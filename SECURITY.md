# Security

Report suspected vulnerabilities privately to a project maintainer. Once a public repository has a private reporting channel, use it. Include the Arqivanta version, impact, and minimal steps or a synthetic fixture. Keep real source, tokens, and personal data out of reports.

## Local trust model

The HTTP server binds to `127.0.0.1`. It checks Host, Origin and browser fetch metadata and accepts JSON for state-changing API requests. The service trusts processes already running on the same machine. Use it on your own workstation. Analysis opens the supplied local folder explicitly and runs in a bounded worker. The analyzer reads files as text and resolves dependency edges from its in-memory index. It treats linked, ignored and conventional sensitive paths as out of scope.

GitHub fetching uses a constrained public GitHub URL and records the resolved SHA. It allows at most 24 MiB compressed, 96 MiB unpacked, and 10,000 paths. Analysis limits include 10,000 files, 384 KiB per file, 32 MiB of source, and 100,000 directory entries per snapshot. Filesystem reads use bounded concurrent batches and retain the same path and link checks. Source views and context exports read the cached snapshot by ID. The cache contains source text and remains on your disk. Use operating-system account protections and choose an appropriate data directory.

An AI request sends up to 120 lines and 10,000 characters of one selected file and its relative path to the configured provider. The server requires consent for remote inference and blocks redirects. For Ollama, model metadata is checked before sending source without remote consent. A trusted loopback service can still forward traffic. Check its configuration and avoid sending code with embedded secrets. Arqivanta does not collect telemetry.
