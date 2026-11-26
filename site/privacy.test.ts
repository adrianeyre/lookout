import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { verbatimFiles } from './build.ts';
import {
  PRIVATE_PATHS,
  REPO_ROOT,
  leaksInDirectory,
  leaksInFiles,
  readPrivateText,
  siteSourceFiles,
} from './privacy.ts';

const prd = path.join(REPO_ROOT, PRIVATE_PATHS[0]!);
const penTestReadme = path.join(REPO_ROOT, 'docs/pen-test/README.md');

describe('the pen-test round stays off the Project Website', () => {
  it('reads the private documents, so the check has something to look for', async () => {
    const secret = await readPrivateText();
    const sources = new Set(secret.lines.values());
    expect(sources).toContain('docs/product-requirements-document/pen-testing.md');
    expect(sources).toContain('docs/pen-test/README.md');
    expect(secret.lines.size).toBeGreaterThan(100);
  });

  it('publishes nothing from them among the files site/build.ts copies', async () => {
    const files = (await verbatimFiles()).map((file) => file.source);
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      expect(path.relative(REPO_ROOT, file)).not.toMatch(/pen-test/);
    }
    expect(await leaksInFiles(files)).toEqual([]);
  });

  it('builds the page from nothing that contains them', async () => {
    expect(await leaksInFiles(await siteSourceFiles())).toEqual([]);
  });

  it('fails when a file from docs/pen-test/ is added to what the site publishes', async () => {
    const files = [...(await verbatimFiles()).map((file) => file.source), penTestReadme];
    const leaks = await leaksInFiles(files);
    expect(leaks.length).toBeGreaterThan(0);
    expect(leaks[0]).toContain('docs/pen-test/README.md is a copy of docs/pen-test/README.md');
  });

  it('fails when the PRD is published, whole or in part, in a built site', async () => {
    const dist = await mkdtemp(path.join(tmpdir(), 'lookout-site-leak-'));
    await writeFile(path.join(dist, 'index.html'), '<!doctype html><p>Nothing private.</p>');
    expect(await leaksInDirectory(dist)).toEqual([]);

    const line = (await readFile(prd, 'utf8'))
      .split('\n')
      .find((l) => l.startsWith('`GET /api/containers/:id/env/:name`'))!;
    // Rendered as HTML, with its Markdown marks gone.
    await writeFile(
      path.join(dist, 'notes.html'),
      `<p>${line.replaceAll('`', '').replaceAll('**', '')}</p>`,
    );
    expect(await leaksInDirectory(dist)).toEqual([
      expect.stringContaining(
        'notes.html contains text from docs/product-requirements-document/pen-testing.md',
      ),
    ]);
  });
});
