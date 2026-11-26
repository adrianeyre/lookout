import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** What a fake Hosted Site does when it is checked. */
export type FakeSiteMode = 'ok' | 'error' | 'slow' | 'refuse';

export const FAKE_SITE_MODES: readonly FakeSiteMode[] = ['ok', 'error', 'slow', 'refuse'];

export interface FakeSiteOptions {
  port: number;
  /** Serve https with this key and certificate. */
  tls?: { key: string; cert: string };
  /** How long a "slow" response takes. */
  slowMs: number;
}

/**
 * A website for Playwright to check, on 127.0.0.1 (where Hosted Site checks connect):
 * answers 200, answers 503, answers slowly, or refuses connections (it stops listening).
 * Lives outside src/ and is excluded from the Image.
 */
export class FakeSite {
  readonly #options: FakeSiteOptions;
  readonly #server: Server;
  #mode: FakeSiteMode = 'ok';
  #listening = false;
  /** How many requests it has answered. */
  requests = 0;

  constructor(options: FakeSiteOptions) {
    this.#options = options;
    const handler = (_request: unknown, response: import('node:http').ServerResponse) => {
      this.requests += 1;
      const send = (code: number) =>
        response.writeHead(code, { 'content-type': 'text/plain' }).end(`fake site ${code}\n`);
      if (this.#mode === 'error') return send(503);
      if (this.#mode === 'slow') return void setTimeout(() => send(200), this.#options.slowMs);
      send(200);
    };
    this.#server = options.tls ? createHttpsServer(options.tls, handler) : createServer(handler);
  }

  get mode(): FakeSiteMode {
    return this.#mode;
  }

  async setMode(mode: FakeSiteMode): Promise<void> {
    this.#mode = mode;
    if (mode === 'refuse') await this.#close();
    else await this.#listen();
  }

  async start(): Promise<void> {
    await this.#listen();
  }

  async stop(): Promise<void> {
    await this.#close();
  }

  async #listen(): Promise<void> {
    if (this.#listening) return;
    await new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(this.#options.port, '127.0.0.1', () => {
        this.#server.off('error', reject);
        resolve();
      });
    });
    this.#listening = true;
  }

  async #close(): Promise<void> {
    if (!this.#listening) return;
    this.#listening = false;
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }
}

/**
 * A self-signed certificate for `hostname` that expires in `days` days, made with the
 * openssl CLI (Node cannot create certificates). The certificate is its own trust anchor.
 */
export function makeCertificate(hostname: string, days: number): { key: string; cert: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'lookout-cert-'));
  try {
    const key = path.join(dir, 'key.pem');
    const cert = path.join(dir, 'cert.pem');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:P-256',
        '-nodes',
        '-keyout',
        key,
        '-out',
        cert,
        '-days',
        String(days),
        '-subj',
        `/O=Lookout E2E/CN=${hostname}`,
        '-addext',
        `subjectAltName=DNS:${hostname}`,
      ],
      { stdio: 'ignore' },
    );
    return { key: readFileSync(key, 'utf8'), cert: readFileSync(cert, 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
