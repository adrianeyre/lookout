import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepare, withVersion } from './release-version.ts';

const PACKAGE = `{
  "name": "lookout",
  "version": "1.0.0",
  "private": true,
  "devEngines": {
    "packageManager": { "name": "pnpm", "version": "12.23.0", "onFail": "error" }
  }
}
`;

describe('the release-version plugin', () => {
  it('sets the version and leaves every other field as it was', () => {
    const next = JSON.parse(withVersion(PACKAGE, '1.2.3')) as Record<string, unknown>;
    expect(next).toEqual({ ...(JSON.parse(PACKAGE) as Record<string, unknown>), version: '1.2.3' });
  });

  it('writes two-space JSON with a final newline, as Prettier leaves it', () => {
    const text = withVersion(PACKAGE, '1.2.3');
    expect(text).toContain('\n  "version": "1.2.3",\n');
    expect(text.endsWith('}\n')).toBe(true);
  });

  it('writes the version into package.json in the release cwd', () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'release-version-'));
    try {
      writeFileSync(path.join(cwd, 'package.json'), PACKAGE);
      prepare({}, { cwd, nextRelease: { version: '2.0.0' }, logger: { log: () => {} } });
      const pkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')) as {
        version: string;
      };
      expect(pkg.version).toBe('2.0.0');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
