import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

export interface StaticFile {
  body: Buffer;
  contentType: string;
  cacheControl: string;
}

/**
 * Loads the built SPA into memory. It is small (well under a megabyte), and holding it
 * avoids any path handling at request time.
 */
export async function loadStaticFiles(distDir: string): Promise<Map<string, StaticFile>> {
  const files = new Map<string, StaticFile>();
  const entries = await readdir(distDir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const absolute = path.join(entry.parentPath, entry.name);
    const urlPath = '/' + path.relative(distDir, absolute).split(path.sep).join('/');
    files.set(urlPath, {
      body: await readFile(absolute),
      contentType: CONTENT_TYPES[path.extname(entry.name)] ?? 'application/octet-stream',
      // Vite fingerprints everything under /assets, so those can be cached forever.
      cacheControl: urlPath.startsWith('/assets/')
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    });
  }
  return files;
}
