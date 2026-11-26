import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/** openssl's time format, as `openssl ca -startdate/-enddate` take it: YYYYMMDDHHMMSSZ. */
const opensslTime = (ms: number) =>
  new Date(ms)
    .toISOString()
    .replace(/[-:T]/g, '')
    .replace(/\.\d+Z$/, 'Z');

/**
 * A self-signed certificate for `hostname` that expires in `days` days, made with the
 * openssl CLI (Node cannot create certificates). The certificate is its own trust anchor.
 *
 * It was issued `lifetimeDays` before it expires (90 by default, like Let's Encrypt's), so it
 * is an ordinary certificate near its end rather than a short-lived one, which Lookout judges
 * by its lifetime instead. `openssl ca` backdates it: `req -not_before` needs OpenSSL 3.4.
 */
export function makeCertificate(
  hostname: string,
  days: number,
  lifetimeDays = 90,
): { key: string; cert: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'lookout-cert-'));
  try {
    const key = path.join(dir, 'key.pem');
    const csr = path.join(dir, 'cert.csr');
    const cert = path.join(dir, 'cert.pem');
    const config = path.join(dir, 'ca.cnf');
    writeFileSync(path.join(dir, 'index.txt'), '');
    writeFileSync(path.join(dir, 'serial'), '01\n');
    writeFileSync(
      config,
      [
        '[ca]',
        'default_ca = fixture',
        '[fixture]',
        `database = ${path.join(dir, 'index.txt')}`,
        `new_certs_dir = ${dir}`,
        `serial = ${path.join(dir, 'serial')}`,
        'default_md = sha256',
        'policy = any',
        'copy_extensions = copy',
        'unique_subject = no',
        'x509_extensions = extensions',
        '[any]',
        'organizationName = optional',
        'commonName = supplied',
        '[extensions]',
        'basicConstraints = CA:TRUE',
        'subjectKeyIdentifier = hash',
        '',
      ].join('\n'),
    );
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    execFileSync(
      'openssl',
      [
        'req',
        '-new',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:P-256',
        '-nodes',
        '-keyout',
        key,
        '-out',
        csr,
        '-subj',
        `/O=Lookout E2E/CN=${hostname}`,
        '-addext',
        `subjectAltName=DNS:${hostname}`,
      ],
      { stdio: 'ignore' },
    );
    execFileSync(
      'openssl',
      [
        'ca',
        '-batch',
        '-notext',
        '-config',
        config,
        '-selfsign',
        '-keyfile',
        key,
        '-in',
        csr,
        '-out',
        cert,
        '-startdate',
        opensslTime(now - (lifetimeDays - days) * DAY),
        '-enddate',
        opensslTime(now + days * DAY),
      ],
      { stdio: 'ignore' },
    );
    return { key: readFileSync(key, 'utf8'), cert: readFileSync(cert, 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
