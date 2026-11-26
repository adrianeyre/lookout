import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
/** The pen-test round's tooling and probes: never built into the Image (see below). */
const PEN_TEST = `pen-test${path.sep}`;
const sources = readdirSync(srcDir, { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
  .filter((file) => !file.startsWith(PEN_TEST))
  .map((file) => ({ file, text: readFileSync(path.join(srcDir, file), 'utf8') }));

describe('architecture guards', () => {
  it('production code never imports the pen-test tooling, which the guards below skip', () => {
    expect(sources.length).toBeGreaterThan(20);
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/(from|import\()\s*['"][^'"]*pen-test\//);
    }
  });

  it('production code never imports the fake Docker or other test support', () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/(from|import\()\s*['"][^'"]*test-support/);
    }
  });

  it('no production code turns off TLS verification (ADR-0010)', () => {
    for (const { file, text } of sources) {
      const code = text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      expect(code, file).not.toMatch(/rejectUnauthorized\s*:\s*false/);
      expect(code, file).not.toMatch(/NODE_TLS_REJECT_UNAUTHORIZED/);
    }
  });

  it('the production entry point adds no certificate authorities for Hosted Site checks', () => {
    const main = sources.find(({ file }) => file === 'main.ts')!;
    expect(main.text).not.toMatch(/siteCa|siteChecker/);
  });

  it('no production code names /proc or /sys outside the Host root helper (ADR-0003)', () => {
    for (const { file, text } of sources) {
      // Comments may mention /proc; string literals may not. The one exception is Lookout's
      // own file handles (OWN_FD_DIR in host-root.ts, #110), which are not the Host's /proc.
      const code = text
        .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
        .replace(file === 'host-root.ts' ? /OWN_FD_DIR = '\/proc\/self\/fd'/ : /$^/, '');
      expect(code, file).not.toMatch(/['"`]\/(proc|sys)(\/|['"`])/);
    }
  });
});
