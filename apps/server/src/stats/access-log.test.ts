import { describe, expect, it } from 'vitest';
import { caddyLine } from '../../test-support/caddy-log.ts';
import {
  LOOKOUT_USER_AGENT,
  caddyJson,
  clientIp,
  isBot,
  isPageView,
  pathOf,
  refererDomain,
  visitorKey,
} from './access-log.ts';

const TS = Date.parse('2026-11-26T10:00:00Z');

describe('caddyJson', () => {
  it('reads a request from a recorded Caddy line', () => {
    const line =
      '{"level":"info","ts":1795687200.123,"logger":"http.log.access.log0","msg":"handled request","request":{"remote_ip":"192.168.1.20","remote_port":"51234","client_ip":"192.168.1.20","proto":"HTTP/2.0","method":"GET","host":"shop.example","uri":"/products?id=4&token=abc","headers":{"User-Agent":["Mozilla/5.0 Firefox/133.0"],"Referer":["https://www.google.com/"]},"tls":{"resumed":false,"version":772,"cipher_suite":4865,"proto":"h2","server_name":"shop.example"}},"bytes_read":0,"user_id":"","duration":0.004512,"size":5120,"status":200,"resp_headers":{"Server":["Caddy"],"Content-Type":["text/html; charset=utf-8"]}}';
    expect(caddyJson.parse(line)).toEqual({
      entry: {
        ts: 1795687200123,
        host: 'shop.example',
        remoteIp: '192.168.1.20',
        method: 'GET',
        uri: '/products?id=4&token=abc',
        status: 200,
        durationMs: 4.512,
        contentType: 'text/html; charset=utf-8',
        userAgent: 'Mozilla/5.0 Firefox/133.0',
        referer: 'https://www.google.com/',
        cfConnectingIp: null,
      },
    });
  });

  it('skips Caddy’s own messages and counts nonsense as malformed', () => {
    expect(
      caddyJson.parse(
        '{"level":"info","ts":1795687200,"logger":"tls","msg":"certificate obtained"}',
      ),
    ).toEqual({ skip: true });
    expect(caddyJson.parse('not json')).toEqual({ malformed: true });
    expect(caddyJson.parse('[1,2]')).toEqual({ malformed: true });
    expect(
      caddyJson.parse(
        '{"ts":"yesterday","status":200,"request":{"host":"a","method":"GET","uri":"/"}}',
      ),
    ).toEqual({ malformed: true });
    expect(
      caddyJson.parse('{"ts":1,"status":"x","request":{"host":"a","method":"GET","uri":"/"}}'),
    ).toEqual({
      malformed: true,
    });
  });

  it('reads headers case-insensitively, and the client header Cloudflare adds', () => {
    const parsed = caddyJson.parse(
      caddyLine({
        ts: TS,
        host: 'CDN.Example',
        remoteIp: '127.0.0.1',
        cfConnectingIp: '203.0.113.9',
      }),
    );
    expect(parsed).toMatchObject({ entry: { host: 'cdn.example', cfConnectingIp: '203.0.113.9' } });
  });
});

describe('isBot', () => {
  it.each([
    ['Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', true],
    ['Mozilla/5.0 (compatible; bingbot/2.0)', true],
    ['curl/8.5.0', true],
    ['python-requests/2.32', true],
    ['Go-http-client/1.1', true],
    ['facebookexternalhit/1.1', true],
    ['', true],
    [null, true],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1',
      false,
    ],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0', false],
  ])('%s → %s', (agent, bot) => {
    expect(isBot(agent)).toBe(bot);
  });
});

describe('clientIp', () => {
  it('believes CF-Connecting-IP only from loopback, where a local tunnel connects from', () => {
    expect(clientIp({ remoteIp: '127.0.0.1', cfConnectingIp: '203.0.113.9' })).toBe('203.0.113.9');
    expect(clientIp({ remoteIp: '::1', cfConnectingIp: '2001:db8::1' })).toBe('2001:db8::1');
  });

  it('ignores a spoofed CF-Connecting-IP from anywhere else', () => {
    expect(clientIp({ remoteIp: '198.51.100.7', cfConnectingIp: '203.0.113.9' })).toBe(
      '198.51.100.7',
    );
    expect(clientIp({ remoteIp: '127.0.0.1', cfConnectingIp: 'not-an-ip' })).toBe('127.0.0.1');
  });

  it('has no visitor without a usable address', () => {
    expect(clientIp({ remoteIp: null, cfConnectingIp: null })).toBeNull();
    expect(clientIp({ remoteIp: 'garbage', cfConnectingIp: null })).toBeNull();
  });
});

describe('visitorKey', () => {
  it('counts an IPv6 /64 as one visitor', () => {
    expect(visitorKey('2001:db8:1:2::1')).toBe(visitorKey('2001:db8:1:2:ffff::9'));
    expect(visitorKey('2001:db8:1:2::1')).not.toBe(visitorKey('2001:db8:1:3::1'));
    expect(visitorKey('192.0.2.1')).not.toBe(visitorKey('192.0.2.2'));
  });
});

describe('pathOf', () => {
  it('strips the query string and fragment, which can carry tokens', () => {
    expect(pathOf('/reset?token=s3cret')).toBe('/reset');
    expect(pathOf('/a#b')).toBe('/a');
    expect(pathOf('/')).toBe('/');
    expect(pathOf('*')).toBe('/');
    expect(pathOf(`/${'x'.repeat(300)}`)).toHaveLength(200);
  });
});

describe('refererDomain', () => {
  it('keeps the domain only', () => {
    expect(refererDomain('https://www.google.com/search?q=lookout')).toBe('google.com');
    expect(refererDomain('http://news.example/a/b')).toBe('news.example');
    expect(refererDomain('android-app://com.slack')).toBeNull();
    expect(refererDomain('nonsense')).toBeNull();
    expect(refererDomain(null)).toBeNull();
  });
});

describe('isPageView', () => {
  it('is a successful GET answered with HTML', () => {
    expect(
      isPageView({ method: 'GET', status: 200, contentType: 'text/html; charset=utf-8' }),
    ).toBe(true);
    expect(isPageView({ method: 'GET', status: 200, contentType: 'application/json' })).toBe(false);
    expect(isPageView({ method: 'POST', status: 200, contentType: 'text/html' })).toBe(false);
    expect(isPageView({ method: 'GET', status: 404, contentType: 'text/html' })).toBe(false);
    expect(isPageView({ method: 'GET', status: 200, contentType: null })).toBe(false);
  });

  it('never counts Lookout’s own checks as anything (see TrafficRecorder)', () => {
    expect(LOOKOUT_USER_AGENT).toBe('Lookout (Hosted Site check)');
  });
});
