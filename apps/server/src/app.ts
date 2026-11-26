import { existsSync } from 'node:fs';
import { once } from 'node:events';
import type { ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  CONTAINER_STATS_STREAM_PATH,
  DEFAULT_LOG_TAIL,
  FOLDER_SCAN_PATH,
  LIVE_STREAM_PATH,
  LOG_TAIL_OPTIONS,
  SITE_ID,
  actionRefusal,
  isContainerAction,
  isSecretField,
  isSelf,
  type ApiError,
  type ContainerAction,
  type ContainerActionResult,
  type ContainerDetail,
  type ContainersSnapshot,
  type ContainerStatsEvents,
  type DockerStatus,
  type EnvValue,
  type FolderScan,
  type HostedSite,
  type LiveEvents,
  type LogLine,
  type LogStreamEvents,
  type PasswordChange,
  MIN_PASSWORD_LENGTH,
  type SecretValue,
  type SessionInfo,
  type SitesSnapshot,
} from '@lookout/shared';
import { isIP } from 'node:net';
import { isAllowedOrigin } from './auth/origin.ts';
import { hashPassword, verifyPassword } from './auth/password.ts';
import { PasswordStore } from './auth/password-store.ts';
import { LoginRateLimiter } from './auth/rate-limit.ts';
import {
  SESSION_COOKIE,
  SessionStore,
  clearSessionCookieHeader,
  parseCookies,
  sessionCookieHeader,
  type Session,
} from './auth/session.ts';
import type { Config } from './config.ts';
import type { DockerClient } from './docker/client.ts';
import { EngineError, isOversized } from './docker/engine.ts';
import { detailOf, type InspectedContainer } from './docker/parse.ts';
import { publicSnapshot, secretValue } from './docker/secrets.ts';
import { StatsHub } from './docker/stats.ts';
import { ContainerStore } from './docker/store.ts';
import { HostRoot } from './host-root.ts';
import { FolderScanner } from './folders/scan.ts';
import type { BlockUnitProbe } from './metrics/block-size.ts';
import { DiskReader } from './metrics/disks.ts';
import { HostSampler } from './sampler.ts';
import type { SiteChecker } from './sites/check.ts';
import { SiteMonitor } from './sites/monitor.ts';
import { loadStaticFiles } from './static.ts';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Reachable without a session: the login page and endpoint, liveness, static assets. */
    public?: boolean;
    /** An HTML page: without a session it redirects to /login instead of returning 401. */
    page?: boolean;
  }
  interface FastifyRequest {
    session: Session | null;
  }
  interface FastifyInstance {
    /** Every route registered on the app, so tests can check each one is protected. */
    registeredRoutes: { method: string; url: string; public: boolean; page: boolean }[];
  }
}

export interface AppOptions {
  config: Config;
  docker: DockerClient;
  /** Directory of the built SPA. Defaults to apps/web/dist; skipped if it does not exist. */
  webDistDir?: string;
  /** How often SSE streams send a heartbeat and recheck their session. */
  heartbeatMs?: number;
  logger?: boolean | { level: string; stream?: NodeJS.WritableStream };
  /** Whether to start sampling Host Metrics. Off in unit tests that do not need it. */
  startSampler?: boolean;
  now?: () => number;
  /** Reads the Host's files. Defaults to one rooted at config.hostRoot. */
  hostRoot?: HostRoot;
  blockUnitProbe?: BlockUnitProbe;
  /** How long to wait before retrying an unreachable Docker. */
  dockerRetryMs?: number;
  /** How often Container stats are sent to the browser. */
  statsFlushMs?: number;
  /** How long a log stream gathers lines before sending them as one event. */
  logFlushMs?: number;
  /** Checks one Hosted Site; replaced in unit tests. */
  siteChecker?: SiteChecker;
  /** Extra certificate authorities Hosted Site checks trust (Playwright only). */
  siteCa?: string[];
  /** Whether to start checking Hosted Sites. Off in unit tests that do not need it. */
  startSiteMonitor?: boolean;
  /** Set false in tests that start scans themselves. */
  startFolderScanner?: boolean;
  /** How long after startup the first folder scan starts (default 30 s). */
  folderScanDelayMs?: number;
  /** Where the password is kept. Defaults to one opened from config (tests replace it). */
  passwordStore?: PasswordStore;
}

/** Most log lines sent in one event; a busier log is sent in several. */
const LOG_BATCH_LINES = 200;

/** Container IDs and names: Docker allows [a-zA-Z0-9][a-zA-Z0-9_.-]* for names. */
const CONTAINER_REF = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

/** Everything the SPA needs, and nothing else: no inline script, no other origin, no frames. */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** What a failed Container Action answers when Docker itself said nothing (#92). */
export const DOCKER_ACTION_FAILED = 'Docker could not complete the action';

/**
 * Docker's own message from a failed Engine API call, for the UI to show (FR-27). Only an
 * EngineError carrying Docker's JSON error body counts: Node's connection errors, a socket
 * proxy's plain-text refusal and anything else get the fixed text, so no internal address or
 * component name reaches the browser (#92).
 */
export function dockerErrorMessage(error: unknown): string {
  if (error instanceof EngineError) {
    const message = error.json?.message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return DOCKER_ACTION_FAILED;
}

/** The security headers on every response, streams included (v1 security review, #88). */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': CONTENT_SECURITY_POLICY,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};

/**
 * Whether Lookout answers to this Host header (#87): an IP address (which DNS rebinding cannot
 * forge, since a rebound page's Host is the attacker's name), localhost, or a name the operator
 * listed in LOOKOUT_HOSTNAMES. Anything else is refused before any route.
 */
export function isAllowedHost(host: string | undefined, hostnames: readonly string[]): boolean {
  // A Host is a name or address and an optional port: nothing that URL parsing would
  // reinterpret, such as user info (evil.example@lookout.test).
  if (!host || /[@/\\?#\s]/.test(host)) return false;
  let hostname: string;
  try {
    // new URL() lower-cases the name and checks any port is a number.
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return false;
  }
  const bare = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (isIP(bare) !== 0) return true;
  return bare === 'localhost' || hostnames.includes(bare);
}

/**
 * Whether the browser reached Lookout over HTTPS: directly, or through a reverse proxy that
 * says so in X-Forwarded-Proto (#86). The header is only ever used to add Secure to the
 * cookie, which can only make it stricter: a browser on plain HTTP ignores a Secure cookie,
 * so a forged header only breaks the forger's own sign-in.
 */
export function cameOverHttps(request: Pick<FastifyRequest, 'protocol' | 'headers'>): boolean {
  if (request.protocol === 'https') return true;
  const forwarded = request.headers['x-forwarded-proto'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0];
  return first?.trim().toLowerCase() === 'https';
}

/** Open event streams one session may hold at once (#118, X1b). */
export const MAX_STREAMS_PER_SESSION = 8;
/** Open event streams Lookout holds at once, from every session together (#118, X1b). */
export const MAX_STREAMS = 32;
/** What a refused stream is told to wait before trying again. */
const STREAM_RETRY_AFTER_SECONDS = 5;
/** Bytes a stream may hold for a browser that is not reading, then it is closed (#119, X1b). */
export const MAX_STREAM_BACKLOG_BYTES = 1024 * 1024;

interface EventStream<Events> {
  send<E extends keyof Events & string>(event: E, data: Events[E]): boolean;
  /** Aborted when the browser goes away, the session ends, or the server shuts down. */
  signal: AbortSignal;
  raw: ServerResponse;
  close(): void;
}

export const DEFAULT_WEB_DIST = fileURLToPath(new URL('../../web/dist/', import.meta.url));

/** Page routes served by the SPA. */
const PAGES = ['/', '/containers', '/containers/:id', '/websites', '/settings'];

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const { config, docker } = options;
  const now = options.now ?? Date.now;
  const heartbeatMs = options.heartbeatMs ?? 15_000;

  const app = Fastify({
    logger:
      options.logger === undefined || options.logger === false
        ? false
        : {
            ...(typeof options.logger === 'object' ? options.logger : {}),
            // Belt and braces: request logs never include bodies, but cookies and
            // authorization headers must never be logged either.
            redact: [
              'req.headers.cookie',
              'req.headers.authorization',
              'res.headers["set-cookie"]',
            ],
          },
    trustProxy: false,
    bodyLimit: 16 * 1024,
    routerOptions: {
      // Above anything Node accepts in a request line (16 KiB of headers), so a long path
      // parameter reaches the route's own checks and their closed-set answers rather than
      // Fastify's 414, which echoes the path before the session hook (#93).
      maxParamLength: 32 * 1024,
    },
    // A URL Fastify cannot route (a bad escape such as %zz, or an over-long parameter) gets a
    // closed-set answer that gives nothing away, with the same headers as any other (#93).
    frameworkErrors: (_error, request, reply) => {
      const signedIn = sessions.verify(parseCookies(request.headers.cookie).get(SESSION_COOKIE));
      const [status, body]: [number, ApiError] = signedIn
        ? [404, { error: 'Not found' }]
        : [401, { error: 'Not signed in' }];
      const text = JSON.stringify(body);
      reply.raw.writeHead(status, {
        ...SECURITY_HEADERS,
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(text),
      });
      reply.raw.end(text);
    },
  });

  const routes: FastifyInstance['registeredRoutes'] = [];
  app.decorate('registeredRoutes', routes);
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (method === 'HEAD') continue;
      routes.push({
        method,
        url: route.url,
        public: route.config?.public === true,
        page: route.config?.page === true,
      });
    }
  });

  const passwords =
    options.passwordStore ??
    (await PasswordStore.open(config.passwordHash, config.dataDir ?? null, app.log));
  // The password hash is part of the signing key, so a new password means a new store, and
  // every session from before it ends (#80).
  const sessionsFor = (passwordHash: string) =>
    new SessionStore(config.sessionSecret, config.sessionIdleMs, now, {
      passwordHash,
      maxLifetimeMs: config.sessionMaxMs,
    });
  let sessions = sessionsFor(passwords.hash);
  // Figures from the pen-testing PRD's limits pre-condition: 5 failures per 15 minutes per
  // address (IPv6 by /64), at most 10,000 addresses held and 4 password checks at once.
  const limiter = new LoginRateLimiter(5, 15 * 60_000, now, {
    maxKeys: 10_000,
    maxConcurrent: 4,
  });
  const hostRoot = options.hostRoot ?? new HostRoot(config.hostRoot);
  const sampler = new HostSampler(hostRoot, {
    intervalMs: config.sampleIntervalMs,
    liveWindowMinutes: config.liveWindowMinutes,
    log: app.log,
    ...(options.blockUnitProbe ? { blockUnitProbe: options.blockUnitProbe } : {}),
  });
  const store = new ContainerStore(docker, {
    log: app.log,
    ...(options.dockerRetryMs !== undefined ? { retryMs: options.dockerRetryMs } : {}),
  });
  const statsHub = new StatsHub(docker, store, options.statsFlushMs);
  const siteMonitor = new SiteMonitor({
    urls: config.sites,
    intervalMs: config.siteCheckIntervalMs,
    timeoutMs: config.siteTimeoutMs,
    slowMs: config.siteSlowMs,
    tls: { warnDays: config.tlsWarnDays, criticalDays: config.tlsCriticalDays },
    liveWindowMs: config.liveWindowMinutes * 60_000,
    log: app.log,
    now,
    ...(options.siteChecker ? { checker: options.siteChecker } : {}),
    ...(options.siteCa ? { ca: options.siteCa } : {}),
  });
  // The Host's largest folders: each real filesystem Disk space lists, walked now and then.
  const diskReader = new DiskReader(hostRoot, options.blockUnitProbe);
  const folderScanner = new FolderScanner({
    hostRoot,
    disks: () => diskReader.read(),
    intervalHours: config.folderScanHours,
    ...(options.folderScanDelayMs !== undefined ? { firstDelayMs: options.folderScanDelayMs } : {}),
    now,
    log: app.log,
  });
  // Container Hosted Sites follow the Container list, which follows Docker events.
  store.subscribe((snapshot) => siteMonitor.updateContainers(snapshot));
  const logFlushMs = options.logFlushMs ?? 50;
  const settings: LiveEvents['settings'] = {
    thresholds: { warnPercent: config.warnPercent, criticalPercent: config.criticalPercent },
    sampleIntervalMs: config.sampleIntervalMs,
    liveWindowMinutes: config.liveWindowMinutes,
  };
  const isSecure = (request: FastifyRequest) => config.secureCookie || cameOverHttps(request);

  app.decorateRequest('session', null);

  // DNS rebinding: answer only on Lookout's own names, before anything else (#87).
  app.addHook('onRequest', async (request, reply) => {
    if (!isAllowedHost(request.headers.host, config.hostnames)) {
      request.log.warn({ host: request.headers.host }, 'Request for another host refused');
      return reply
        .code(421)
        .send({ error: 'Lookout does not answer to this host name' } satisfies ApiError);
    }
  });

  // CSRF: state-changing requests must come from this origin (FR-34).
  app.addHook('onRequest', async (request, reply) => {
    if (!isAllowedOrigin(request.method, request.headers.origin, request.headers.host)) {
      return reply.code(403).send({ error: 'Cross-origin request refused' } satisfies ApiError);
    }
  });

  // Every route needs a session unless it is explicitly public (FR-29).
  app.addHook('onRequest', async (request, reply) => {
    const session = sessions.verify(parseCookies(request.headers.cookie).get(SESSION_COOKIE));
    request.session = session;
    const routeConfig = request.routeOptions.config;
    if (routeConfig.public) return;
    if (!session) {
      if (routeConfig.page) return reply.redirect('/login', 302);
      return reply.code(401).send({ error: 'Not signed in' } satisfies ApiError);
    }
    const refreshed = sessions.refresh(session);
    if (refreshed) {
      reply.header(
        'set-cookie',
        sessionCookieHeader(refreshed, {
          secure: isSecure(request),
          maxAgeSeconds: sessions.maxAgeSeconds(session),
        }),
      );
    }
  });

  // Security headers on every response (v1 security review). The SPA loads only its own
  // script and stylesheet; Vite inlines small images as data: URIs.
  app.addHook('onSend', async (_request, reply) => {
    reply.headers(SECURITY_HEADERS);
    // Nothing is kept in a browser cache unless its route says so: the SPA's hashed assets
    // and its index page set their own. This does not depend on how the path was spelled,
    // so /%61pi/containers is no-store like /api/containers (#90).
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
  });

  app.get('/healthz', { config: { public: true } }, async () => ({ status: 'ok' }));

  app.post<{ Body: unknown }>(
    '/api/login',
    {
      config: { public: true },
      schema: {
        body: {
          type: 'object',
          required: ['password'],
          additionalProperties: false,
          properties: { password: { type: 'string', minLength: 1, maxLength: 1024 } },
        },
      },
    },
    async (request, reply) => {
      const ip = request.ip;
      // A check is reserved before it runs, so parallel guesses count against the limit as
      // they start, and only a few 19 MiB Argon2id checks run at once (#81).
      const attempt = limiter.begin(ip);
      if ('retryAfterSeconds' in attempt) {
        return reply
          .code(429)
          .header('retry-after', String(attempt.retryAfterSeconds))
          .send({ error: 'Too many failed attempts. Try again later.' } satisfies ApiError);
      }
      const { password } = request.body as { password: string };
      let correct = false;
      try {
        correct = await verifyPassword(password, passwords.hash);
      } finally {
        attempt.finish(correct);
      }
      if (!correct) {
        request.log.warn({ ip }, 'Failed login');
        return reply.code(401).send({ error: 'Incorrect password' } satisfies ApiError);
      }
      const { cookie, session } = sessions.create();
      return reply
        .header(
          'set-cookie',
          sessionCookieHeader(cookie, {
            secure: isSecure(request),
            maxAgeSeconds: sessions.maxAgeSeconds(session),
          }),
        )
        .code(204)
        .send();
    },
  );

  app.post('/api/logout', async (request, reply) => {
    if (request.session) sessions.revoke(request.session);
    return reply
      .header('set-cookie', clearSessionCookieHeader(isSecure(request)))
      .code(204)
      .send();
  });

  app.get('/api/session', async (): Promise<SessionInfo> => ({
    authenticated: true,
    passwordChangeable: passwords.changeable,
  }));

  // Change the password from Settings. The current password is checked like a sign-in, under
  // the same per-address limit, so a session left open is not enough to change it.
  app.post<{ Body: unknown }>(
    '/api/password',
    {
      schema: {
        body: {
          type: 'object',
          required: ['currentPassword', 'newPassword'],
          additionalProperties: false,
          properties: {
            currentPassword: { type: 'string', minLength: 1, maxLength: 1024 },
            newPassword: { type: 'string', minLength: 1, maxLength: 1024 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!passwords.changeable) {
        return reply.code(409).send({
          error:
            'Set LOOKOUT_DATA_DIR (and give it a volume) to change the password here, or put a new LOOKOUT_PASSWORD_HASH in .env.',
        } satisfies ApiError);
      }
      const { currentPassword, newPassword } = request.body as PasswordChange;
      if (newPassword.length < MIN_PASSWORD_LENGTH) {
        return reply.code(400).send({
          error: `Use a new password of at least ${MIN_PASSWORD_LENGTH} characters.`,
        } satisfies ApiError);
      }
      const ip = request.ip;
      const attempt = limiter.begin(ip);
      if ('retryAfterSeconds' in attempt) {
        return reply
          .code(429)
          .header('retry-after', String(attempt.retryAfterSeconds))
          .send({ error: 'Too many failed attempts. Try again later.' } satisfies ApiError);
      }
      let correct = false;
      try {
        correct = await verifyPassword(currentPassword, passwords.hash);
      } finally {
        attempt.finish(correct);
      }
      if (!correct) {
        request.log.warn({ ip }, 'Failed password change');
        // 403, not 401: the session is still good, only the current password was wrong.
        return reply
          .code(403)
          .send({ error: 'The current password is incorrect' } satisfies ApiError);
      }
      try {
        await passwords.change(await hashPassword(newPassword));
      } catch (error) {
        request.log.error({ err: error }, 'Could not save the new password');
        return reply
          .code(500)
          .send({ error: 'The new password could not be saved' } satisfies ApiError);
      }
      request.log.info({ ip }, 'Password changed; every other session has ended');
      // Every session ends with the old password, but whoever changed it stays signed in.
      sessions = sessionsFor(passwords.hash);
      const { cookie, session } = sessions.create();
      return reply
        .header(
          'set-cookie',
          sessionCookieHeader(cookie, {
            secure: isSecure(request),
            maxAgeSeconds: sessions.maxAgeSeconds(session),
          }),
        )
        .code(204)
        .send();
    },
  );

  app.get('/api/docker/status', async (): Promise<DockerStatus> => ({
    available: await docker.ping(),
  }));

  // Open SSE streams never finish on their own, so shutdown ends them explicitly.
  const liveStreams = new Set<ServerResponse>();
  app.addHook('preClose', async () => {
    for (const stream of liveStreams) stream.end();
  });

  // Open streams per session, and in all (#118): each holds a connection, and a log stream a
  // Docker follow request too.
  const streamsBySession = new Map<string, number>();
  let openStreams = 0;

  /**
   * Takes over the response as a Server-Sent Events stream (ADR-0006), or answers 429 and
   * returns null when the session, or Lookout, already has as many open as it may (#118).
   */
  function openEventStream<Events>(
    request: FastifyRequest,
    reply: FastifyReply,
  ): EventStream<Events> | null {
    const sid = request.session?.sid ?? '';
    const mine = streamsBySession.get(sid) ?? 0;
    if (mine >= MAX_STREAMS_PER_SESSION || openStreams >= MAX_STREAMS) {
      request.log.warn({ session: mine, open: openStreams }, 'Stream refused: too many open');
      void reply
        .code(429)
        .header('retry-after', String(STREAM_RETRY_AFTER_SECONDS))
        .send({ error: 'Too many open streams' } satisfies ApiError);
      return null;
    }
    streamsBySession.set(sid, mine + 1);
    openStreams += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      openStreams -= 1;
      const left = (streamsBySession.get(sid) ?? 1) - 1;
      if (left > 0) streamsBySession.set(sid, left);
      else streamsBySession.delete(sid);
    };

    reply.hijack();
    const raw = reply.raw;
    liveStreams.add(raw);
    // A hijacked reply skips onSend, so the stream sets the security headers itself (#88).
    raw.writeHead(200, {
      ...(reply.getHeaders() as Record<string, string>),
      ...SECURITY_HEADERS,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    raw.write(`retry: 2000\n\n`);

    const controller = new AbortController();
    const cookie = parseCookies(request.headers.cookie).get(SESSION_COOKIE);
    const heartbeat = setInterval(() => {
      // Close the stream once its session is revoked or idle-expired; the browser then
      // reconnects, gets 401, and returns to the login page.
      if (!sessions.verify(cookie)) {
        raw.end();
        return;
      }
      raw.write(`: heartbeat\n\n`);
    }, heartbeatMs);

    const cleanup = () => {
      clearInterval(heartbeat);
      liveStreams.delete(raw);
      release();
      controller.abort();
    };
    raw.on('close', cleanup);
    raw.on('finish', cleanup);

    // A browser that stops reading must not make Lookout hold every event for it (#119). What
    // a route sends as it opens (the Live Window, the Container list) is allowed on top; from
    // the next tick on, a backlog past MAX_STREAM_BACKLOG_BYTES ends the stream, and the
    // browser's EventSource reconnects once it reads again.
    let allowance = Number.POSITIVE_INFINITY;
    setImmediate(() => {
      allowance = raw.writableLength + MAX_STREAM_BACKLOG_BYTES;
    });

    const stream: EventStream<Events> = {
      send(event, data) {
        if (raw.writableEnded || raw.destroyed) return true;
        if (raw.writableLength > allowance) {
          request.log.warn(
            { backlog: raw.writableLength },
            'Stream closed: the browser is not reading it',
          );
          raw.destroy();
          return true;
        }
        return raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      },
      signal: controller.signal,
      raw,
      close: () => raw.end(),
    };
    return stream;
  }

  app.get(LIVE_STREAM_PATH, async (request, reply) => {
    const stream = openEventStream<LiveEvents>(request, reply);
    if (!stream) return reply;
    stream.send('settings', settings);
    // A newly connected browser gets the Live Window so far, then live samples (FR-13).
    stream.send('window', sampler.window.snapshot());
    if (sampler.latest) stream.send('host', sampler.latest);
    stream.send('containers', publicSnapshot(store.snapshot));
    stream.send('sites', siteMonitor.snapshot);
    const unsubscribeSites = siteMonitor.subscribe((snapshot) => stream.send('sites', snapshot));
    stream.send('folders', folderScanner.snapshot);
    const unsubscribeFolders = folderScanner.subscribe((scan) => stream.send('folders', scan));
    const unsubscribeHost = sampler.subscribe((sample) => stream.send('host', sample));
    const unsubscribeContainers = store.subscribe((snapshot) =>
      stream.send('containers', publicSnapshot(snapshot)),
    );
    stream.signal.addEventListener('abort', () => {
      unsubscribeHost();
      unsubscribeContainers();
      unsubscribeSites();
      unsubscribeFolders();
    });
  });

  // Label values that look like secrets are masked in every list and stream event (#91).
  app.get('/api/containers', async (): Promise<ContainersSnapshot> =>
    publicSnapshot(store.snapshot),
  );

  app.get(CONTAINER_STATS_STREAM_PATH, async (request, reply) => {
    const stream = openEventStream<ContainerStatsEvents>(request, reply);
    if (!stream) return reply;
    const unsubscribe = statsHub.subscribe((stats) => stream.send('stats', stats));
    stream.signal.addEventListener('abort', unsubscribe);
  });

  const dockerUnavailable = (reply: FastifyReply) =>
    reply.code(503).send({ error: 'Docker unavailable' } satisfies ApiError);
  const containerNotFound = (reply: FastifyReply) =>
    reply.code(404).send({ error: 'No such Container' } satisfies ApiError);

  /** Inspects the Container a route names, replying 404 or 503 itself when it cannot. */
  async function findContainer(
    id: string,
    reply: FastifyReply,
  ): Promise<InspectedContainer | null> {
    if (!CONTAINER_REF.test(id)) {
      await containerNotFound(reply);
      return null;
    }
    let container: InspectedContainer | null;
    try {
      container = await docker.inspectContainer(id);
    } catch {
      await dockerUnavailable(reply);
      return null;
    }
    if (!container) await containerNotFound(reply);
    // Listed so the operator sees it, but nothing was read from it to act on (#116).
    else if (isOversized(container)) {
      await reply.code(502).send({
        error: "Docker's answer for this Container is too large to read",
      } satisfies ApiError);
      return null;
    }
    return container;
  }

  app.get<{ Params: { id: string } }>('/api/containers/:id', async (request, reply) => {
    const container = await findContainer(request.params.id, reply);
    if (!container) return reply;
    // Names only: values are revealed one at a time below (FR-20).
    return detailOf(container) satisfies ContainerDetail;
  });

  app.get<{ Params: { id: string; name: string } }>(
    '/api/containers/:id/env/:name',
    async (request, reply) => {
      const container = await findContainer(request.params.id, reply);
      if (!container) return reply;
      // Lookout's own Containers hold its session secret and password hash (#79).
      if (isSelf(container)) return refuseSelfReveal(request, reply, container);
      // Docker uses the last definition of a repeated variable.
      const variable = container.env.findLast((v) => v.name === request.params.name);
      if (!variable) {
        return reply.code(404).send({ error: 'No such environment variable' } satisfies ApiError);
      }
      request.log.info({ container: container.name, variable: variable.name }, 'Revealed env');
      return reply
        .header('cache-control', 'no-store')
        .send({ name: variable.name, value: variable.value } satisfies EnvValue);
    },
  );

  /** A reveal on a lookout.self Container: refused like a Container Action on it (#79). */
  function refuseSelfReveal(
    request: FastifyRequest,
    reply: FastifyReply,
    container: InspectedContainer,
  ) {
    request.log.warn({ container: container.name }, 'Reveal on own Container refused');
    return reply
      .code(403)
      .send({ error: "Lookout never reveals its own Container's secrets" } satisfies ApiError);
  }

  // One masked value from the command, entrypoint, labels or mounts, revealed and logged on
  // its own, like an environment value (#91). Only masked items can be asked for.
  app.get<{ Params: { id: string; field: string; key: string } }>(
    '/api/containers/:id/secrets/:field/:key',
    async (request, reply) => {
      const { field, key } = request.params;
      const noSuchValue = () =>
        reply.code(404).send({ error: 'No such masked value' } satisfies ApiError);
      if (!isSecretField(field) || key.length > 1024) return noSuchValue();
      const container = await findContainer(request.params.id, reply);
      if (!container) return reply;
      if (isSelf(container)) return refuseSelfReveal(request, reply, container);
      const value = secretValue(container, field, key);
      if (value === null) return noSuchValue();
      request.log.info({ container: container.name, field, key }, 'Revealed secret');
      return reply
        .header('cache-control', 'no-store')
        .send({ field, key, value } satisfies SecretValue);
    },
  );

  const runAction: Record<ContainerAction, (id: string) => Promise<void>> = {
    start: (id) => docker.startContainer(id),
    stop: (id) => docker.stopContainer(id),
    restart: (id) => docker.restartContainer(id),
    remove: (id) => docker.removeContainer(id),
  };

  // Container Actions (FR-23 to FR-27). The Origin check and session hooks above already
  // apply; the state and self checks here are the server's own, not just hidden buttons.
  app.post<{ Params: { id: string; action: string }; Body: unknown }>(
    '/api/containers/:id/actions/:action',
    async (request, reply) => {
      const { action } = request.params;
      if (!isContainerAction(action)) {
        return reply.code(404).send({ error: 'No such Container Action' } satisfies ApiError);
      }
      const body = request.body;
      const confirmName =
        typeof body === 'object' && body !== null && 'confirmName' in body
          ? body.confirmName
          : undefined;
      const container = await findContainer(request.params.id, reply);
      if (!container) return reply;

      const refusal = actionRefusal(container, action);
      if (refusal !== null) {
        const self = isSelf(container);
        request.log.warn({ container: container.name, action }, 'Container Action refused');
        return reply.code(self ? 403 : 409).send({ error: refusal } satisfies ApiError);
      }
      // Remove is destructive: the typed name is checked here as well as in the dialog.
      if (action === 'remove' && confirmName !== container.name) {
        return reply
          .code(400)
          .send({ error: "Type the Container's name to confirm removal" } satisfies ApiError);
      }

      request.log.info({ container: container.name, action }, 'Container Action');
      try {
        await runAction[action](container.id);
      } catch (error) {
        const message = dockerErrorMessage(error);
        request.log.warn({ container: container.name, action, error: message }, 'Action failed');
        return reply.code(502).send({ error: message } satisfies ApiError);
      }
      return { action, containerId: container.id } satisfies ContainerActionResult;
    },
  );

  app.get<{ Params: { id: string }; Querystring: { tail?: string } }>(
    '/api/containers/:id/logs',
    async (request, reply) => {
      const tail = Number(request.query.tail ?? DEFAULT_LOG_TAIL);
      if (!(LOG_TAIL_OPTIONS as readonly number[]).includes(tail)) {
        return reply
          .code(400)
          .send({ error: `tail must be one of ${LOG_TAIL_OPTIONS.join(', ')}` } satisfies ApiError);
      }
      const container = await findContainer(request.params.id, reply);
      if (!container) return reply;

      const stream = openEventStream<LogStreamEvents>(request, reply);
      if (!stream) return reply;
      stream.send('reset', { tail });
      void (async () => {
        let batch: LogLine[] = [];
        let timer: NodeJS.Timeout | undefined;
        const flush = () => {
          clearTimeout(timer);
          timer = undefined;
          if (batch.length === 0) return true;
          const lines = batch;
          batch = [];
          return stream.send('lines', lines);
        };
        try {
          // The Docker log request shares the stream's signal, so closing the detail view
          // closes it too (FR-22).
          for await (const line of docker.logs(
            container.id,
            { tail, follow: true },
            stream.signal,
          )) {
            batch.push(line);
            if (batch.length >= LOG_BATCH_LINES) {
              // A fast log waits for the browser rather than buffering without limit.
              if (!flush() && !stream.signal.aborted) {
                await once(stream.raw, 'drain', { signal: stream.signal }).catch(() => undefined);
              }
            } else {
              timer ??= setTimeout(flush, logFlushMs);
            }
          }
          flush();
          stream.send('end', {});
        } catch (error) {
          if (!stream.signal.aborted) request.log.warn({ err: error }, 'Log stream failed');
        } finally {
          clearTimeout(timer);
          stream.close();
        }
      })();
    },
  );

  app.get('/api/sites', async (): Promise<SitesSnapshot> => siteMonitor.snapshot);

  // "Check now" (PRD §14). It takes a Hosted Site ID, never a URL, so it can only reach what
  // operator config already names (ADR-0010). The Origin check above makes it CSRF-safe.
  app.post<{ Params: { id: string } }>('/api/sites/:id/check', async (request, reply) => {
    const unknown = () => reply.code(404).send({ error: 'No such Hosted Site' } satisfies ApiError);
    const { id } = request.params;
    if (!SITE_ID.test(id)) return unknown();
    const outcome = await siteMonitor.checkNow(id);
    if (outcome.result === 'unknown') return unknown();
    if (outcome.result === 'limited') {
      return reply
        .code(429)
        .header('retry-after', String(Math.ceil(outcome.retryAfterMs / 1000)))
        .send({ error: 'This Hosted Site was checked moments ago' } satisfies ApiError);
    }
    return outcome.site satisfies HostedSite;
  });

  app.get('/api/folders', async (): Promise<FolderScan> => folderScanner.snapshot);

  // "Scan now". It takes nothing, so it can only walk what Disk space lists; one scan runs at
  // a time. The Origin check above makes it CSRF-safe.
  app.post(FOLDER_SCAN_PATH, async (_request, reply) => {
    if (folderScanner.scanNow().result === 'busy') {
      return reply.code(409).send({ error: 'A scan is already running' } satisfies ApiError);
    }
    return reply.code(202).send(folderScanner.snapshot satisfies FolderScan);
  });

  const distDir = options.webDistDir ?? DEFAULT_WEB_DIST;
  if (existsSync(distDir)) {
    const files = await loadStaticFiles(distDir);
    const index = files.get('/index.html');
    if (!index) throw new Error(`${distDir} has no index.html`);

    for (const [urlPath, file] of files) {
      if (urlPath === '/index.html') continue;
      app.get(urlPath, { config: { public: true } }, async (_request, reply) =>
        reply.type(file.contentType).header('cache-control', file.cacheControl).send(file.body),
      );
    }

    const sendIndex = async (_request: FastifyRequest, reply: FastifyReply) =>
      reply.type(index.contentType).header('cache-control', 'no-cache').send(index.body);
    for (const page of PAGES) app.get(page, { config: { page: true } }, sendIndex);
    app.get('/login', { config: { public: true } }, async (request, reply) =>
      request.session ? reply.redirect('/', 302) : sendIndex(request, reply),
    );
  } else {
    app.log.warn({ distDir }, 'Built SPA not found; serving the API only');
  }

  app.setNotFoundHandler(async (_request, reply) =>
    reply.code(404).send({ error: 'Not found' } satisfies ApiError),
  );

  if (options.startSampler !== false) {
    app.addHook('onReady', async () => sampler.start());
    app.addHook('onClose', async () => sampler.stop());
  }
  app.addHook('onReady', async () => store.start());
  app.addHook('onClose', async () => store.stop());
  if (options.startSiteMonitor !== false) {
    app.addHook('onReady', async () => siteMonitor.start());
    app.addHook('onClose', async () => siteMonitor.stop());
  }
  if (options.startFolderScanner !== false) {
    app.addHook('onReady', async () => folderScanner.start());
  }
  app.addHook('onClose', async () => folderScanner.stop());

  return app;
}
