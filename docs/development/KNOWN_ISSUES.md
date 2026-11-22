# Known issues and limits

- The native folder dialog requires an interactive Windows session. Absolute path entry is available on other platforms and when the dialog cannot open.
- Analysis covers JS, TS, and Python syntax and a small set of project metadata. Computed imports, runtime loaders, package-manager links, and bundler-specific aliases may remain unresolved. Python follows relative imports and common repository-root and `src` layouts. Custom `sys.path`, installed packages, and package metadata entry points are outside the current Python resolver.
- Ignore rules and sensitive-name filters use conventions. Review excerpts before sending them to any model and review exports before sharing them.
- Repository AI search is lexical and depends on overlap with source text, symbols, paths, and verified imports. General questions can miss relevant files. Source coverage is bounded by the current analysis and context window.
- Context sizing uses a conservative UTF-8 estimate. Keep the configured window within the model's actual limits. OpenAI-compatible endpoints may require a separate context-length setting on the inference server.
- A source citation confirms an excerpt and line range from the snapshot. Generated interpretations still require review.
- Code Routes recognizes direct calls to unique named functions and common literal Fastify and FastAPI registrations. Dynamic dispatch, some registration helpers, namespace and barrel calls, runtime router prefixes, and callbacks outside supported forms may remain unresolved. Use source links to inspect branch conditions and registration context.
- Git comparison requires Git in PATH and a committed HEAD. It compares analyzed source within the selected folder. Worktree-specific exclusions and coverage limits can affect which paths appear in each snapshot.
- Related tests are inferred from test paths in import chains. Historical code remains available while its snapshot is cached.
- Large repositories can reach scanning or graph limits. Review the diagnostics or open a smaller subfolder if appropriate.
- Public GitHub imports use anonymous API access and the default branch. API limits, Git submodules and Git LFS can affect what is available for analysis.
- The Windows browser suite uses installed Chrome in the development environment. The Repository AI Assistant changes have local verification. Hosted CI will run when the changes are published.
