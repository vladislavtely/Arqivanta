import type { ReactNode } from 'react';
import { CircleAlert, FolderOpen, LoaderCircle } from 'lucide-react';

export function ErrorNotice({ message }: { message: string }) {
  return (
    <div className="error-notice" role="alert">
      <CircleAlert size={17} aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}

export function Loading({ children }: { children: ReactNode }) {
  return (
    <div className="loading" role="status">
      <LoaderCircle className="spinner" size={18} aria-hidden="true" />
      {children}
    </div>
  );
}

export function NoProject({ onOpen }: { onOpen: () => void }) {
  return (
    <section className="empty-view">
      <span className="feature-icon">
        <FolderOpen size={22} aria-hidden="true" />
      </span>
      <h2>Open a repository</h2>
      <p>Select a local project, import a public GitHub repository, or try the bundled example.</p>
      <button type="button" className="button primary" onClick={onOpen}>
        Open a repository
      </button>
    </section>
  );
}

export function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function plural(count: number, noun: string): string {
  const pluralNoun = noun === 'dependency' ? 'dependencies' : `${noun}s`;
  return `${count.toLocaleString()} ${count === 1 ? noun : pluralNoun}`;
}
