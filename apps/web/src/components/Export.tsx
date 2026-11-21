import type { ProjectAnalysis } from '@arqivanta/shared';
import { Braces, Download, FileCode2, FileText, GitBranch, Network } from 'lucide-react';
import { projectRoute } from '../api';
import { plural } from './ui';

export function Export({ analysis }: { analysis: ProjectAnalysis }) {
  const source = projectRoute(analysis.project.id);
  return (
    <div className="page workbench-page settings-page">
      <header className="workbench-header">
        <div>
          <h1>Export Center</h1>
          <p>Download repository context for coding agents, documentation, and review.</p>
        </div>
      </header>
      <section className="panel export-overview" aria-label="Export snapshot">
        <div>
          <h2>{analysis.project.name}</h2>
          <p>
            The export includes the directory structure, module relationships, entry points, and
            verified source references.
          </p>
        </div>
        <div className="export-metrics">
          <span>
            <FileCode2 size={16} /> {plural(analysis.files.length, 'file')}
          </span>
          <span>
            <Network size={16} /> {plural(analysis.edges.length, 'dependency')}
          </span>
          <span>
            <GitBranch size={16} /> {plural(analysis.entryPoints.length, 'entry point')}
          </span>
        </div>
      </section>
      <div className="settings-grid">
        <section className="panel settings-panel">
          <span className="feature-icon">
            <FileText size={20} aria-hidden="true" />
          </span>
          <h2>Markdown</h2>
          <p>A readable project brief you can share with an agent or add to your notes.</p>
          <a className="button primary" href={`/api${source}/export?format=markdown`} download>
            <Download size={16} aria-hidden="true" /> Download Markdown
          </a>
        </section>
        <section className="panel settings-panel">
          <span className="feature-icon secondary">
            <Braces size={20} aria-hidden="true" />
          </span>
          <h2>JSON</h2>
          <p>Structured repository context for scripts, tools, and automated workflows.</p>
          <a className="button" href={`/api${source}/export?format=json`} download>
            <Download size={16} aria-hidden="true" /> Download JSON
          </a>
        </section>
      </div>
    </div>
  );
}
