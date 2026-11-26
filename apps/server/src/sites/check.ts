import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import {
  checkServerIdentity,
  connect as tlsConnect,
  type ConnectionOptions,
  type TLSSocket,
} from 'node:tls';
import type { X509Certificate } from 'node:crypto';
import { siteStatusFor, type SiteCheck, type TlsCertificate } from '@lookout/shared';
import { INTERNAL_ADDRESS, isInternalAddress, isLocalName, publicLookup } from './address.ts';

/** Where checks connect when a Hosted Site is checked at the Host (ADR-0010). */
export const HOST_ADDRESS = '127.0.0.1';

/** The most response header bytes a check accepts; a larger response is an error. */
export const MAX_HEADER_BYTES = 16 * 1024;
/** The longest redirect target kept from a Location header. */
export const MAX_REDIRECT_LENGTH = 2048;
/** The longest certificate subject or issuer kept; they come from the site, untrusted. */
export const MAX_NAME_LENGTH = 256;

export interface CheckOptions {
  timeoutMs: number;
  slowMs: number;
  /** Connect to the Host itself (the default) or resolve the hostname through DNS. */
  checkPublic: boolean;
  /** Extra trusted certificate authorities, added to Node's own (tests only). */
  ca?: string[];
  now?: () => number;
}

/** Runs one check of a Hosted Site URL. Injected into the monitor so tests can fake it. */
export type SiteChecker = (url: string, options: CheckOptions) => Promise<SiteCheck>;

/** The parts of a certificate's distinguished name Lookout shows. */
function dnField(dn: string, field: string): string | null {
  for (const line of dn.split('\n')) {
    const [key, ...rest] = line.split('=');
    if (key === field) return rest.join('=').slice(0, MAX_NAME_LENGTH) || null;
  }
  return null;
}

const NOT_TRUST_ERRORS = new Set([
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
]);

/** The certificate details Lookout shows, from the handshake's peer certificate. */
export function certificateFrom(
  certificate: X509Certificate,
  hostname: string,
  verifyError: string | null,
): TlsCertificate {
  const hostnameMatches =
    (isIP(hostname) === 0
      ? certificate.checkHost(hostname, { subject: 'default' })
      : certificate.checkIP(hostname)) !== undefined;
  // Expiry and a hostname mismatch are reported as such, not as an untrusted issuer.
  const trusted = verifyError === null || NOT_TRUST_ERRORS.has(verifyError);
  return {
    subject: dnField(certificate.subject, 'CN'),
    issuer: dnField(certificate.issuer, 'O') ?? dnField(certificate.issuer, 'CN') ?? 'Unknown',
    validTo: Date.parse(certificate.validTo),
    hostnameMatches,
    trusted,
    error: verifyError,
  };
}

/** A short message for a failed check, without internal detail. */
export function errorText(error: unknown, timeoutMs: number): string {
  const code = (error as { code?: unknown } | null)?.code;
  switch (code) {
    case INTERNAL_ADDRESS:
      return 'Not checked: public mode never connects to an internal address';
    case 'LOOKOUT_TIMEOUT':
      return `Timed out after ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 100) / 10} s` : `${timeoutMs} ms`}`;
    case 'ECONNREFUSED':
      return 'Connection refused';
    case 'ECONNRESET':
      return 'Connection reset';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'EAI_NODATA':
    case 'EAI_NONAME':
      return 'DNS lookup failed';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return 'Host unreachable';
    case 'EPROTO':
      return 'TLS handshake failed';
    case 'HPE_HEADER_OVERFLOW':
      return 'Response headers too large';
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return "TLS: certificate doesn't match the hostname";
    default:
      if (
        typeof code === 'string' &&
        /CERT|SSL|TLS|SELF_SIGNED|ISSUER|SIGNATURE|UNABLE_TO_VERIFY|CHAIN/.test(code)
      ) {
        return `TLS: ${code}`;
      }
      return typeof code === 'string' ? code : 'Check failed';
  }
}

/**
 * Checks a Hosted Site with one GET (PRD §14, ADR-0010).
 *
 * - At the Host by default: connects to 127.0.0.1 on the URL's port, sending the site's
 *   hostname as the Host header and the TLS SNI, so hairpin NAT and split DNS don't matter.
 * - Redirects are not followed. Only the status line and headers are read; the body is
 *   never read, and the connection is closed as soon as the headers arrive.
 * - TLS verification is always on. A certificate that fails it is still described, but
 *   the request is never sent over that connection and the Hosted Site is down.
 * - In public mode it never connects to an internal address (#103): an IP literal is
 *   refused outright, and a name is checked on every address DNS returns, at connect time,
 *   so rebinding cannot slip one through.
 */
export const checkSite: SiteChecker = (url, options) => {
  const now = options.now ?? Date.now;
  const target = new URL(url);
  const https = target.protocol === 'https:';
  const hostname = target.hostname.replace(/^\[|\]$/g, '');
  const port = Number(target.port || (https ? 443 : 80));
  const address = options.checkPublic ? hostname : HOST_ADDRESS;
  const started = now();
  const startedAt = performance.now();

  return new Promise<SiteCheck>((resolve) => {
    let certificate: TlsCertificate | null = null;
    let settled = false;
    let request: ClientRequest | undefined = undefined;

    const finish = (check: Omit<SiteCheck, 'timestamp' | 'tls'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request?.destroy();
      resolve({ ...check, timestamp: started, tls: certificate });
    };

    const fail = (error: unknown) => {
      finish({
        status: 'down',
        statusCode: null,
        error: errorText(error, options.timeoutMs),
        responseMs: null,
        redirect: null,
      });
    };

    const timer = setTimeout(
      () => fail(Object.assign(new Error('timeout'), { code: 'LOOKOUT_TIMEOUT' })),
      options.timeoutMs,
    );

    if (
      options.checkPublic &&
      (isLocalName(hostname) || (isIP(hostname) !== 0 && isInternalAddress(hostname)))
    ) {
      fail(Object.assign(new Error('internal address'), { code: INTERNAL_ADDRESS }));
      return;
    }
    // Public mode resolves through a lookup that drops internal addresses (#103).
    const lookup = options.checkPublic ? { lookup: publicLookup } : {};

    /** Opens the TLS connection ourselves, to read the certificate even when it fails. */
    const createConnection = (): TLSSocket => {
      const tlsOptions: ConnectionOptions = {
        host: address,
        port,
        // SNI must be a hostname, never an IP address.
        ...(isIP(hostname) === 0 ? { servername: hostname } : {}),
        rejectUnauthorized: true,
        ...lookup,
        ...(options.ca ? { ca: options.ca } : {}),
        // The certificate must match the site's own hostname, not the address dialled.
        checkServerIdentity: (_address, cert) => checkServerIdentity(hostname, cert),
      };
      const socket = tlsConnect(tlsOptions);
      // A failed verification destroys the socket before any event exposes the handshake,
      // so describe the certificate on the way out; nothing is ever sent over it.
      const destroy = socket.destroy.bind(socket);
      socket.destroy = (error?: Error) => {
        captureCertificate(socket, error);
        return destroy(error);
      };
      socket.once('secureConnect', () => captureCertificate(socket));
      return socket;
    };

    const captureCertificate = (socket: TLSSocket, error?: Error) => {
      if (certificate !== null) return;
      let peer: X509Certificate | undefined;
      try {
        peer = socket.getPeerX509Certificate();
      } catch {
        peer = undefined;
      }
      if (!peer) return;
      const code = (error as { code?: unknown } | undefined)?.code;
      const verifyError = socket.authorized
        ? null
        : typeof code === 'string'
          ? code
          : String(socket.authorizationError);
      certificate = certificateFrom(peer, hostname, verifyError);
    };

    const requestOptions = {
      method: 'GET',
      host: address,
      port,
      path: `${target.pathname}${target.search}`,
      headers: {
        host: target.host,
        'user-agent': 'Lookout (Hosted Site check)',
        accept: '*/*',
        connection: 'close',
      },
      maxHeaderSize: MAX_HEADER_BYTES,
      ...lookup,
      // No shared Agent: each check opens, and closes, its own connection. Node uses
      // createConnection only when no agent is given.
      ...(https ? { createConnection } : { agent: false as const }),
    };

    try {
      request = (https ? httpsRequest : httpRequest)(
        requestOptions,
        (response: IncomingMessage) => {
          const responseMs = Math.round(performance.now() - startedAt);
          const statusCode = response.statusCode ?? 0;
          const location = response.headers.location;
          // The body is never read: destroying the response closes the connection.
          response.destroy();
          finish({
            status: siteStatusFor(statusCode, responseMs, options.slowMs),
            statusCode,
            error: null,
            responseMs,
            redirect:
              statusCode >= 300 && statusCode < 400 && typeof location === 'string'
                ? location.slice(0, MAX_REDIRECT_LENGTH)
                : null,
          });
        },
      );
      request.on('error', fail);
      request.end();
    } catch (error) {
      fail(error);
    }
  });
};
