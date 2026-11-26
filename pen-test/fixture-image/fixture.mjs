// One program for every pen-test fixture (docs/pen-test/fixtures.md). Everything it serves
// or prints is synthetic. The first argument picks what it does; any other arguments are
// ignored, so a fixture can carry made-up secrets in its command line.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect } from 'node:net';
import { lookup } from 'node:dns/promises';

const [mode = 'idle', ...args] = process.argv.slice(2);
const idle = () => setInterval(() => undefined, 1 << 30);

const modes = {
  /** Does nothing, for ever. The victim and the Compose Project's web Container. */
  idle,

  /** Exits at once with the given code: the stopped Container that can be removed. */
  exit: () => process.exit(Number(args[0] ?? 0)),

  /** A healthy Hosted Site on the given port. */
  site: () => {
    const port = Number(args[0] ?? 8080);
    createServer((_request, response) =>
      response.writeHead(200, { 'content-type': 'text/plain' }).end('pen-test fixture site\n'),
    ).listen(port, '0.0.0.0');
  },

  /** A Hosted Site whose certificate expired in January 2024. */
  'expired-tls': () => {
    const port = Number(args[0] ?? 8443);
    const host = args[1] ?? 'expired.pen-test.example';
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
        '/tmp/key.pem',
        '-out',
        '/tmp/cert.pem',
        '-not_before',
        '20240101000000Z',
        '-not_after',
        '20240201000000Z',
        '-subj',
        `/O=Lookout pen-test fixture/CN=${host}`,
        '-addext',
        `subjectAltName=DNS:${host}`,
      ],
      { stdio: 'ignore' },
    );
    const tls = { key: readFileSync('/tmp/key.pem'), cert: readFileSync('/tmp/cert.pem') };
    createHttpsServer(tls, (_request, response) =>
      response.writeHead(200, { 'content-type': 'text/plain' }).end('expired\n'),
    ).listen(port, '0.0.0.0');
  },

  /** A Hosted Site that redirects to the given internal address. */
  redirect: () => {
    const port = Number(args[0] ?? 8080);
    const location = args[1] ?? 'http://169.254.169.254/latest/meta-data/';
    createServer((_request, response) => response.writeHead(302, { location }).end()).listen(
      port,
      '0.0.0.0',
    );
  },

  /**
   * The Hostile Container's logs: markup, terminal escapes, bidirectional and control
   * characters, then one long line with no newline, then nothing. Sizes are modest; the
   * values that would exhaust memory are X1's, generated only on demand.
   */
  'hostile-logs': () => {
    const lines = [
      '<img src=x onerror="alert(document.domain)">',
      '<script>fetch("/api/containers").then(r=>r.text()).then(alert)</script>',
      '\u001b[31mred\u001b[0m \u001b[2J\u001b[H cleared screen',
      '\u001b]8;;https://evil.pen-test.example/\u0007a terminal link\u001b]8;;\u0007',
      'bidi: ‮gnp.exe‬ and ⁦isolate⁩',
      'control: NUL[\u0000] BEL[\u0007] BS[\u0008] DEL[\u007f]',
      '[x](javascript:alert(1)) **markdown** `code`',
    ];
    for (const line of lines) process.stdout.write(`${line}\n`);
    process.stderr.write('stderr: <b>bold?</b>\n');
    const bytes = Number(args[0] ?? 256 * 1024);
    process.stdout.write('L'.repeat(bytes));
    idle();
  },

  /**
   * Exits 0 only if this network namespace cannot reach the internet: no TCP to public
   * addresses and no public DNS. Used by the isolation probe, from inside the deployment.
   */
  'egress-check': async () => {
    const tcp = (host, port) =>
      new Promise((resolve) => {
        const socket = connect({ host, port, timeout: 3000 });
        const done = (reached) => {
          socket.destroy();
          resolve(reached);
        };
        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false));
        socket.once('error', () => done(false));
      });
    // All at once, so a namespace with no way out answers in one timeout.
    const targets = [
      ['1.1.1.1', 443],
      ['8.8.8.8', 53],
      ['140.82.112.3', 443],
    ];
    const dns = lookup('example.com').then(
      async ({ address }) => ((await tcp(address, 443)) ? [`example.com (${address}):443`] : []),
      () => [], // No DNS: as it should be.
    );
    const results = await Promise.all([
      ...targets.map(async ([host, port]) => ((await tcp(host, port)) ? [`${host}:${port}`] : [])),
      dns,
    ]);
    const reached = results.flat();
    if (reached.length > 0) {
      console.log(`REACHED ${reached.join(', ')}`);
      process.exit(1);
    }
    console.log('isolated');
  },
};

const run = modes[mode];
if (!run) {
  console.error(`unknown fixture mode ${mode}`);
  process.exit(2);
}
await run();
