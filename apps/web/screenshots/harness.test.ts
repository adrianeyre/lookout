import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONTAINERS, DETAIL, HOST } from './fixtures.ts';

const source = (name: string) => readFileSync(path.join(import.meta.dirname, name), 'utf8');

describe('screenshot harness (PRD WEB-6)', () => {
  it('cannot read Docker or a Host: no server code, no real EventSource, no Node APIs', () => {
    for (const file of ['harness.tsx', 'fixtures.ts']) {
      const text = source(file);
      expect(text, file).not.toMatch(/from ['"][^'"]*apps\/server|from ['"]\.\.\/\.\.\/server/);
      expect(text, file).not.toMatch(/from ['"]node:/);
      expect(text, file).not.toMatch(/new EventSource\(/);
      expect(text, file).not.toMatch(/dockerode|docker\.sock|\/proc\//);
    }
  });

  it('answers every request itself', () => {
    const harness = source('harness.tsx');
    expect(harness).toMatch(/window\.fetch = /);
    expect(harness).toMatch(/EventSourceContext\.Provider value=\{createEventSource\}/);
    expect(harness).toMatch(/createEventSource\s*\}\)/);
    // The capture script blocks anything that is not the harness itself.
    expect(source('capture.ts')).toMatch(/route\.abort\(\)/);
  });

  it('uses only made-up names and documentation-safe values', () => {
    expect(HOST.overview.hostname).toBe('lighthouse');
    for (const container of CONTAINERS) {
      expect(container.image).not.toMatch(/adrianeyre\/(?!lookout)/);
    }
    // Environment values are never part of the fixtures, only names.
    expect(JSON.stringify(DETAIL)).not.toMatch(/"env":/);
  });
});
