# Known issues and limits

- The native folder dialog requires an interactive Windows session. Absolute path entry is available on other platforms and when the dialog cannot open.
- Analysis covers JS, TS, and Python syntax and a small set of project metadata. Computed imports, runtime loaders, package-manager links, and bundler-specific aliases may remain unresolved. Python follows relative imports and common repository-root and `src` layouts. Custom `sys.path`, installed packages, and package metadata entry points are outside the current Python resolver.
- Ignore rules and sensitive-name filters use conventions. Review excerpts before sending them to any model and review exports before sharing them.
- Large repositories can reach scanning or graph limits. Review the diagnostics or open a smaller subfolder if appropriate.
- Public GitHub imports use anonymous API access and the default branch. API limits, Git submodules and Git LFS can affect what is available for analysis.
- The Windows browser suite uses installed Chrome in the development environment. Hosted CI validation on macOS is pending.
