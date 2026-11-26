/**
 * The vendored Stageshow kit is the copy published upstream, unmodified (site/stageshow/README.md,
 * pen-test finding #130): every file matches SHA256SUMS, and no file is added or removed.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT = fileURLToPath(new URL('./stageshow/', import.meta.url));

async function sums(): Promise<Map<string, string>> {
  const text = await readFile(path.join(KIT, 'SHA256SUMS'), 'utf8');
  return new Map(
    text
      .trim()
      .split('\n')
      .map((line) => {
        const [hash, file] = line.split(/ {2}/) as [string, string];
        return [file, hash];
      }),
  );
}

describe('the vendored Stageshow kit', () => {
  it('matches SHA256SUMS file for file', async () => {
    const expected = await sums();
    expect(expected.size).toBeGreaterThan(100);
    for (const [file, hash] of expected) {
      const actual = createHash('sha256')
        .update(await readFile(path.join(KIT, file)))
        .digest('hex');
      expect(actual, file).toBe(hash);
    }
  });

  it('has no file in kit/ that SHA256SUMS does not list', async () => {
    const expected = await sums();
    const files = (await readdir(path.join(KIT, 'kit'), { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(KIT, path.join(entry.parentPath, entry.name)));
    for (const file of files) expect(expected.has(file), file).toBe(true);
    expect(files).toHaveLength([...expected.keys()].filter((f) => f.startsWith('kit/')).length);
  });
});
