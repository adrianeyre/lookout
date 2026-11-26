/**
 * Keeps the pen-test round off the Project Website (docs/product-requirements-document/
 * pen-testing.md, the privacy note at its top). The PRD and everything under docs/pen-test/
 * name exploit chains; no file the site publishes may be one of them, or contain text from
 * them. Used by site/privacy.test.ts (what site/build.ts would publish, in `pnpm test`) and
 * by `pnpm site:check` (what it did publish, in site/dist).
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The round's private documents, relative to the repository root. */
export const PRIVATE_PATHS = ['docs/product-requirements-document/pen-testing.md', 'docs/pen-test'];

/** Lines shorter than this, or with fewer words, are too common to mean anything. */
const MIN_LINE_LENGTH = 40;
const MIN_WORDS = 6;

export interface PrivateText {
  /** SHA-256 of every private file, to catch a copy of any file, text or not. */
  hashes: Map<string, string>;
  /** Distinctive lines from the private files, each with the file it came from. */
  lines: Map<string, string>;
}

async function filesUnder(target: string): Promise<string[]> {
  if (!existsSync(target)) return [];
  if (!(await stat(target)).isDirectory()) return [target];
  const entries = await readdir(target, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/**
 * Text as it reads once rendered or copied: HTML tags and Markdown marks dropped, spacing
 * collapsed, lower case. The marks are deleted rather than spaced, as rendering deletes them.
 */
export function normalise(text: string): string {
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/[`*_#>|[\]()]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Reads the private documents: the PRD and everything under docs/pen-test/. */
export async function readPrivateText(root = REPO_ROOT): Promise<PrivateText> {
  const hashes = new Map<string, string>();
  const lines = new Map<string, string>();
  for (const relative of PRIVATE_PATHS) {
    for (const file of await filesUnder(path.join(root, relative))) {
      const name = path.relative(root, file);
      const content = await readFile(file);
      hashes.set(sha256(content), name);
      for (const line of content.toString('utf8').split(/\r?\n/)) {
        const text = normalise(line);
        if (text.length >= MIN_LINE_LENGTH && text.split(' ').length >= MIN_WORDS) {
          lines.set(text, name);
        }
      }
    }
  }
  return { hashes, lines };
}

/** What a published file leaks from the private documents, as readable reasons. */
export function leaksIn(name: string, content: Buffer, secret: PrivateText): string[] {
  const reasons: string[] = [];
  const copy = secret.hashes.get(sha256(content));
  if (copy) reasons.push(`${name} is a copy of ${copy}`);
  const text = normalise(content.toString('utf8'));
  for (const [line, from] of secret.lines) {
    if (text.includes(line)) {
      reasons.push(`${name} contains text from ${from}: "${line.slice(0, 60)}…"`);
      break;
    }
  }
  return reasons;
}

/** Every leak in the files given (absolute paths), named relative to `base`. */
export async function leaksInFiles(
  files: string[],
  base = REPO_ROOT,
  secret?: PrivateText,
): Promise<string[]> {
  const privateText = secret ?? (await readPrivateText());
  const reasons: string[] = [];
  for (const file of files) {
    reasons.push(...leaksIn(path.relative(base, file), await readFile(file), privateText));
  }
  return reasons;
}

/** Every leak anywhere under a directory, such as the built site/dist. */
export async function leaksInDirectory(dir: string): Promise<string[]> {
  return leaksInFiles(await filesUnder(dir), dir);
}

/**
 * The repository files the site is built from besides the verbatim copies: its own
 * sources, which Vite bundles, and what build.ts reads into the page.
 */
export async function siteSourceFiles(root = REPO_ROOT): Promise<string[]> {
  const site = path.join(root, 'site');
  const own = (await filesUnder(site)).filter((file) => {
    const relative = path.relative(site, file);
    return (
      !relative.startsWith(`dist${path.sep}`) && !relative.startsWith(`node_modules${path.sep}`)
    );
  });
  return [...own, path.join(root, 'CHANGELOG.md'), path.join(root, 'package.json')].filter((file) =>
    existsSync(file),
  );
}
