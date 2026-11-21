import { useState } from 'react';
import type { ProjectSummary } from '@arqivanta/shared';
import {
  BookOpen,
  Box,
  FileCode2,
  Folder,
  FolderOpen,
  Github,
  GitCommitHorizontal,
  GitFork,
  LockKeyhole,
} from 'lucide-react';
import { ErrorNotice, Loading, plural } from './ui';

export type ProjectInput = { path: string } | { url: string } | { example: true };

type HomeProps = {
  projects: ProjectSummary[];
  pending: string | null;
  error: string | null;
  onImport: (input: ProjectInput, message: string) => void;
  onOpen: (project: ProjectSummary) => void;
};

const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

export function Home({ projects, pending, error, onImport, onOpen }: HomeProps) {
  const [folder, setFolder] = useState('');
  const [url, setUrl] = useState('');
  const busy = pending !== null;

  return (
    <div className="page home-page">
      <header className="page-intro">
        <div className="hero-icon" aria-hidden="true">
          <Box size={31} strokeWidth={1.55} />
        </div>
        <h1>Explore your codebase</h1>
        <p>Understand any codebase. Use any AI. Own your data.</p>
      </header>

      <div className="import-grid">
        <section className="panel import-panel" aria-labelledby="local-title">
          <span className="feature-icon">
            <FolderOpen size={20} aria-hidden="true" />
          </span>
          <h2 id="local-title">Open a local project</h2>
          <p>Analyze JavaScript and TypeScript source directly from a folder on this machine.</p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (folder.trim()) onImport({ path: folder.trim() }, 'Analyzing local project…');
            }}
          >
            <label htmlFor="project-folder">Project folder</label>
            <input
              id="project-folder"
              value={folder}
              onChange={(event) => setFolder(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="Absolute path on this computer"
              required
              maxLength={4096}
            />
            <button className="button primary" type="submit" disabled={busy || !folder.trim()}>
              <FolderOpen size={16} aria-hidden="true" /> Analyze folder
            </button>
          </form>
        </section>

        <section className="panel import-panel" aria-labelledby="github-title">
          <span className="feature-icon secondary">
            <Github size={20} aria-hidden="true" />
          </span>
          <h2 id="github-title">Import from GitHub</h2>
          <p>Download a snapshot of a public repository and analyze it on this machine.</p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (url.trim())
                onImport({ url: url.trim() }, 'Downloading and analyzing GitHub repository…');
            }}
          >
            <label htmlFor="github-url">Repository URL</label>
            <input
              id="github-url"
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="https://github.com/owner/repository"
              required
              maxLength={2048}
            />
            <button className="button" type="submit" disabled={busy || !url.trim()}>
              <Github size={16} aria-hidden="true" /> Import repository
            </button>
          </form>
        </section>
      </div>

      <section className="panel example-panel" aria-labelledby="example-title">
        <span className="feature-icon secondary">
          <BookOpen size={20} aria-hidden="true" />
        </span>
        <div>
          <h2 id="example-title">Try the example project</h2>
          <p>Explore a small TypeScript project bundled with Arqivanta.</p>
        </div>
        <button
          className="button"
          type="button"
          disabled={busy}
          onClick={() => onImport({ example: true }, 'Analyzing the example project…')}
        >
          Open example
        </button>
      </section>

      {pending && <Loading>{pending}</Loading>}
      {error && <ErrorNotice message={error} />}

      <section className="recent" aria-labelledby="recent-title">
        <div className="section-heading">
          <h2 id="recent-title">Recent projects</h2>
          {projects.length > 0 && <span>{plural(projects.length, 'saved project')}</span>}
        </div>
        {projects.length === 0 ? (
          <div className="recent-empty">
            <Folder size={17} aria-hidden="true" /> Projects you analyze will appear here.
          </div>
        ) : (
          <ul className="panel project-list">
            {projects.map((item) => (
              <li key={item.id}>
                <button type="button" onClick={() => onOpen(item)} disabled={busy}>
                  <span className="feature-icon secondary">
                    {item.origin === 'github' ? <Github size={17} /> : <Folder size={17} />}
                  </span>
                  <span className="recent-name">
                    <strong>{item.name}</strong>
                    <span>
                      {item.origin === 'example'
                        ? 'Example project'
                        : item.origin === 'github'
                          ? 'GitHub repository'
                          : 'Local project'}
                    </span>
                  </span>
                  <span className="recent-stat">
                    <FileCode2 size={14} /> {plural(item.fileCount, 'file')}
                  </span>
                  <span className="recent-stat">
                    <GitFork size={14} /> {plural(item.edgeCount, 'dependency')}
                  </span>
                  {item.commitSha && (
                    <span className="recent-stat recent-sha">
                      <GitCommitHorizontal size={14} /> {item.commitSha.slice(0, 7)}
                    </span>
                  )}
                  <time className="recent-date" dateTime={item.createdAt}>
                    {dateFormatter.format(new Date(item.createdAt))}
                  </time>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <footer className="home-footer">
        <LockKeyhole size={14} aria-hidden="true" /> Analysis runs locally. AI explanations are off
        by default.
      </footer>
    </div>
  );
}
