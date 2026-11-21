# Known issues and limits

- Local folder selection uses an absolute path. A native folder dialog is planned with the desktop shell.
- Analysis covers JS and TS syntax and a small set of project metadata. Computed imports, runtime loaders, package-manager links, and bundler-specific aliases may remain unresolved. The graph describes static relationships within the selected snapshot.
- Ignore rules and sensitive-name filters use conventions. Review excerpts before sending them to any model and review exports before sharing them.
- Large repositories can reach scanning or graph limits. Review the diagnostics or open a smaller subfolder if appropriate.
- Public GitHub imports use anonymous API access and the default branch. API limits, Git submodules and Git LFS can affect what is available for analysis.
- The Windows browser suite uses installed Chrome in the development environment. Hosted CI validation on macOS is pending.
