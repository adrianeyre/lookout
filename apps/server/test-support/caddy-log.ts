/**
 * Caddy JSON access log lines for tests and the e2e server, in the shape Caddy 2 writes with
 * `log { format json }`: one object per request. Never part of the Image.
 */
export interface CaddyRequest {
  ts: number;
  host: string;
  uri?: string;
  method?: string;
  status?: number;
  /** Seconds, as Caddy writes it. */
  duration?: number;
  remoteIp?: string;
  userAgent?: string | null;
  referer?: string;
  contentType?: string | null;
  cfConnectingIp?: string;
}

export const BROWSER =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export function caddyLine(request: CaddyRequest): string {
  const headers: Record<string, string[]> = { Accept: ['text/html,application/xhtml+xml'] };
  const userAgent = request.userAgent === undefined ? BROWSER : request.userAgent;
  if (userAgent !== null) headers['User-Agent'] = [userAgent];
  if (request.referer) headers.Referer = [request.referer];
  if (request.cfConnectingIp) headers['Cf-Connecting-Ip'] = [request.cfConnectingIp];
  const contentType =
    request.contentType === undefined ? 'text/html; charset=utf-8' : request.contentType;
  const respHeaders: Record<string, string[]> = { Server: ['Caddy'] };
  if (contentType !== null) respHeaders['Content-Type'] = [contentType];
  const remote = request.remoteIp ?? '192.168.1.20';
  return JSON.stringify({
    level: 'info',
    ts: request.ts / 1000,
    logger: 'http.log.access.log0',
    msg: 'handled request',
    request: {
      remote_ip: remote,
      remote_port: '51234',
      client_ip: remote,
      proto: 'HTTP/2.0',
      method: request.method ?? 'GET',
      host: request.host,
      uri: request.uri ?? '/',
      headers,
      tls: {
        resumed: false,
        version: 772,
        cipher_suite: 4865,
        proto: 'h2',
        server_name: request.host,
      },
    },
    bytes_read: 0,
    user_id: '',
    duration: request.duration ?? 0.0045,
    size: 5120,
    status: request.status ?? 200,
    resp_headers: respHeaders,
  });
}

/** Lines joined as a file holds them, each ending in a newline. */
export function caddyLog(requests: CaddyRequest[]): string {
  return requests.map((r) => `${caddyLine(r)}\n`).join('');
}
