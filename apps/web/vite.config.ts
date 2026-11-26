import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { renderChangelog } from '../../packages/shared/src/changelog.ts';

const REPO_URL = 'https://github.com/adrianeyre/lookout';

/**
 * The version the footer shows: a release build's own (Dockerfile, LOOKOUT_VERSION), or else the
 * root package.json's, which semantic-release bumps on every release.
 */
export function lookoutVersion(): string {
  const fromBuild = process.env.VITE_LOOKOUT_VERSION;
  if (fromBuild) return fromBuild;
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    version?: string;
  };
  return pkg.version ?? '0.0.0';
}

/** The footer's Changelog, from CHANGELOG.md, built in: the dashboard may have no internet. */
function changelogHtml(): string {
  let markdown = '';
  try {
    markdown = readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8');
  } catch {
    // No CHANGELOG.md: the modal says there has been no release yet.
  }
  return renderChangelog(markdown, `${REPO_URL}/releases`).html;
}

export default defineConfig({
  plugins: [react()],
  define: {
    'import.meta.env.VITE_LOOKOUT_VERSION': JSON.stringify(lookoutVersion()),
    'import.meta.env.VITE_LOOKOUT_CHANGELOG_HTML': JSON.stringify(changelogHtml()),
  },
  server: {
    port: 5173,
    strictPort: true,
    // The API and SSE stream come from Fastify in development (ADR-0007). The Host header is
    // kept so the server's Origin check sees the same origin the browser does.
    proxy: {
      '/api': { target: 'http://127.0.0.1:7777', changeOrigin: false },
      '/healthz': { target: 'http://127.0.0.1:7777', changeOrigin: false },
    },
  },
  build: {
    target: 'es2023',
    sourcemap: false,
  },
});
