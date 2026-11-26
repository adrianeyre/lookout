import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { fixture } from '../../test/helpers.ts';
import { certificateFrom, checkSite, errorText, type CheckOptions } from './check.ts';

const tls = (name: string) => readFileSync(fixture(`tls/${name}`), 'utf8');
const CA = tls('ca.pem');

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

/** A local server; returns its port and the requests it received. */
async function serve(handler: Handler, options?: { https?: { key: string; cert: string } }) {
  const requests: IncomingMessage[] = [];
  const wrapped: Handler = (request, response) => {
    requests.push(request);
    handler(request, response);
  };
  const server = options?.https ? createHttpsServer(options.https, wrapped) : createServer(wrapped);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, requests };
}

const OPTIONS: CheckOptions = { timeoutMs: 2000, slowMs: 500, checkPublic: false };

describe('checkSite: up, slow and down', () => {
  it.each([
    [200, 'up'],
    [204, 'up'],
    [401, 'up'],
    [403, 'up'],
    [404, 'up'],
    [499, 'up'],
    [500, 'down'],
    [502, 'down'],
    [503, 'down'],
  ] as const)('a %i response is %s', async (code, status) => {
    const { port } = await serve((_request, response) => response.writeHead(code).end());
    const check = await checkSite(`http://shop.example:${port}/`, OPTIONS);
    expect(check).toMatchObject({
      status,
      statusCode: code,
      error: null,
      redirect: null,
      tls: null,
    });
    expect(check.responseMs).toBeGreaterThanOrEqual(0);
  });

  it('is up for a 3xx, which it does not follow, and shows where it goes', async () => {
    const { port, requests } = await serve((_request, response) =>
      response.writeHead(301, { location: 'https://shop.example/' }).end(),
    );
    const check = await checkSite(`http://shop.example:${port}/`, OPTIONS);
    expect(check).toMatchObject({
      status: 'up',
      statusCode: 301,
      redirect: 'https://shop.example/',
    });
    expect(requests).toHaveLength(1);
  });

  it('connects to the Host, sending the hostname, path and query in the request', async () => {
    const { port, requests } = await serve((_request, response) => response.end());
    await checkSite(`http://shop.example:${port}/status?full=1`, OPTIONS);
    expect(requests[0]!.headers.host).toBe(`shop.example:${port}`);
    expect(requests[0]!.method).toBe('GET');
    expect(requests[0]!.url).toBe('/status?full=1');
  });

  it('is slow past the slow threshold, and down past the timeout', async () => {
    const { port } = await serve((_request, response) => {
      setTimeout(() => response.end(), 150);
    });
    const slow = await checkSite(`http://shop.example:${port}/`, { ...OPTIONS, slowMs: 50 });
    expect(slow).toMatchObject({ status: 'slow', statusCode: 200 });
    expect(slow.responseMs).toBeGreaterThan(50);

    const timedOut = await checkSite(`http://shop.example:${port}/`, {
      ...OPTIONS,
      timeoutMs: 100,
    });
    expect(timedOut).toMatchObject({
      status: 'down',
      statusCode: null,
      error: 'Timed out after 100 ms',
      responseMs: null,
    });
  });

  it('is down when the connection is refused', async () => {
    const { port } = await serve(() => undefined);
    await new Promise<void>((resolve) => {
      const server = servers.pop()!;
      server.close(() => resolve());
    });
    const check = await checkSite(`http://shop.example:${port}/`, OPTIONS);
    expect(check).toMatchObject({ status: 'down', error: 'Connection refused', statusCode: null });
  });

  it('is down when DNS fails, for a Hosted Site checked through its public URL', async () => {
    const check = await checkSite('http://lookout-test.invalid/', {
      ...OPTIONS,
      checkPublic: true,
    });
    expect(check).toMatchObject({ status: 'down', error: 'DNS lookup failed' });
  });

  it('never reads the body: a huge response is not downloaded', async () => {
    let written = 0;
    let closed = false;
    const { port } = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      const chunk = Buffer.alloc(64 * 1024);
      const pump = () => {
        while (!closed && written < 256 * 1024 * 1024) {
          written += chunk.length;
          if (!response.write(chunk)) return void response.once('drain', pump);
        }
        response.end();
      };
      response.on('close', () => {
        closed = true;
      });
      pump();
    });
    const check = await checkSite(`http://shop.example:${port}/`, OPTIONS);
    expect(check.status).toBe('up');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(closed).toBe(true);
    // Only what the kernel buffers was ever sent, not the 256 MiB body.
    expect(written).toBeLessThan(32 * 1024 * 1024);
  });

  it('refuses oversized response headers', async () => {
    const { port } = await serve((_request, response) =>
      response.writeHead(200, { 'x-big': 'x'.repeat(32 * 1024) }).end(),
    );
    const check = await checkSite(`http://shop.example:${port}/`, OPTIONS);
    expect(check).toMatchObject({ status: 'down', error: 'Response headers too large' });
  });

  it('keeps at most 2 KiB of a redirect target', async () => {
    const { port } = await serve((_request, response) =>
      response.writeHead(302, { location: `/${'a'.repeat(4000)}` }).end(),
    );
    const check = await checkSite(`http://shop.example:${port}/`, OPTIONS);
    expect(check.redirect).toHaveLength(2048);
  });
});

describe('checkSite: TLS', () => {
  const leaf = { key: tls('leaf-key.pem'), cert: tls('leaf.pem') };

  it('reads the certificate from the handshake, sending the hostname as SNI', async () => {
    let servername: string | undefined;
    const { port } = await serve(
      (request, response) => {
        servername = (request.socket as unknown as { servername?: string }).servername;
        response.end();
      },
      { https: leaf },
    );
    const check = await checkSite(`https://secure.example:${port}/`, { ...OPTIONS, ca: [CA] });
    expect(servername).toBe('secure.example');
    expect(check).toMatchObject({
      status: 'up',
      statusCode: 200,
      tls: {
        subject: 'secure.example',
        issuer: 'Lookout Test CA',
        validTo: Date.parse('2036-01-01T00:00:00Z'),
        hostnameMatches: true,
        trusted: true,
        error: null,
      },
    });
  });

  it('never disables verification: an untrusted certificate is shown, the site is down, and no request is sent', async () => {
    const { port, requests } = await serve((_request, response) => response.end(), {
      https: leaf,
    });
    const check = await checkSite(`https://secure.example:${port}/`, OPTIONS);
    expect(check).toMatchObject({
      status: 'down',
      statusCode: null,
      error: 'TLS: UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      tls: { subject: 'secure.example', trusted: false, error: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' },
    });
    expect(requests).toHaveLength(0);
  });

  it('stays verified even when NODE_TLS_REJECT_UNAUTHORIZED=0 is set', async () => {
    const { port, requests } = await serve((_request, response) => response.end(), {
      https: leaf,
    });
    const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try {
      const check = await checkSite(`https://secure.example:${port}/`, OPTIONS);
      expect(check).toMatchObject({ status: 'down', tls: { trusted: false } });
      expect(requests).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
    }
  });

  it("is down when the certificate doesn't match the hostname", async () => {
    const { port, requests } = await serve((_request, response) => response.end(), {
      https: leaf,
    });
    const check = await checkSite(`https://other.example:${port}/`, { ...OPTIONS, ca: [CA] });
    expect(check).toMatchObject({
      status: 'down',
      error: "TLS: certificate doesn't match the hostname",
      tls: { hostnameMatches: false, trusted: true, error: 'ERR_TLS_CERT_ALTNAME_INVALID' },
    });
    expect(requests).toHaveLength(0);
  });

  it('is down when the certificate has expired', async () => {
    const { port } = await serve((_request, response) => response.end(), {
      https: { key: tls('leaf-expired-key.pem'), cert: tls('leaf-expired.pem') },
    });
    const check = await checkSite(`https://secure.example:${port}/`, { ...OPTIONS, ca: [CA] });
    expect(check).toMatchObject({
      status: 'down',
      error: 'TLS: CERT_HAS_EXPIRED',
      tls: {
        validTo: Date.parse('2021-01-01T00:00:00Z'),
        trusted: true,
        error: 'CERT_HAS_EXPIRED',
      },
    });
  });
});

describe('certificateFrom', () => {
  it('describes a fixture certificate', () => {
    const certificate = new X509Certificate(tls('leaf.pem'));
    expect(certificateFrom(certificate, 'www.secure.example', null)).toEqual({
      subject: 'secure.example',
      issuer: 'Lookout Test CA',
      validFrom: Date.parse(certificate.validFrom),
      validTo: Date.parse('2036-01-01T00:00:00Z'),
      hostnameMatches: true,
      trusted: true,
      error: null,
    });
    expect(certificateFrom(certificate, 'shop.example', null).hostnameMatches).toBe(false);
    expect(
      certificateFrom(certificate, 'secure.example', 'SELF_SIGNED_CERT_IN_CHAIN').trusted,
    ).toBe(false);
  });
});

describe('errorText', () => {
  it.each([
    [{ code: 'LOOKOUT_TIMEOUT' }, 10_000, 'Timed out after 10 s'],
    [{ code: 'LOOKOUT_TIMEOUT' }, 2500, 'Timed out after 2.5 s'],
    [{ code: 'ECONNREFUSED' }, 0, 'Connection refused'],
    [{ code: 'EAI_AGAIN' }, 0, 'DNS lookup failed'],
    [{ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }, 0, 'TLS: DEPTH_ZERO_SELF_SIGNED_CERT'],
    [{ code: 'EPROTO' }, 0, 'TLS handshake failed'],
    [new Error('boom'), 0, 'Check failed'],
  ])('%j → %s', (error, timeoutMs, text) => {
    expect(errorText(error, timeoutMs)).toBe(text);
  });
});
