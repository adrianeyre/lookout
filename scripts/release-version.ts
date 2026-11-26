/**
 * A local semantic-release plugin (.releaserc.json) that writes the release's version into
 * the root package.json, which @semantic-release/git then commits. The web footer and the
 * site read the version from there.
 *
 * It replaces @semantic-release/npm, whose prepare step runs `npm version`: npm 11 refuses
 * that here, because package.json's devEngines.packageManager requires pnpm (onFail: error).
 * Lookout publishes nothing to npm, so writing the field is all that step needs to do.
 *
 * It uses nothing but Node: no package manager runs beside the release token.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

interface PrepareContext {
  cwd?: string;
  nextRelease: { version: string };
  logger: { log: (message: string, ...args: unknown[]) => void };
}

/** package.json's text with `version` set, keeping its two-space layout and final newline. */
export function withVersion(text: string, version: string): string {
  const pkg = JSON.parse(text) as Record<string, unknown>;
  pkg.version = version;
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

export function prepare(_pluginConfig: unknown, context: PrepareContext): void {
  const file = path.join(context.cwd ?? process.cwd(), 'package.json');
  const version = context.nextRelease.version;
  context.logger.log('Write version %s to %s', version, file);
  writeFileSync(file, withVersion(readFileSync(file, 'utf8'), version));
}
