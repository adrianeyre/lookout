/**
 * W1 (#64) against the pen-test deployment: the Host header and DNS rebinding, the SSE
 * responses' headers, and the SPA in a real browser: no CSP violation on any page and the
 * Hostile Container's values shown as text. The in-process half is w1-browser.test.ts and
 * apps/web/src/pen-test-w1.test.tsx.
 */
import { request } from 'node:http';
import { chromium, type Browser } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type Deployment } from './deployment-harness.ts';

let deployment: Deployment;
beforeAll(async () => {
  deployment = await connect();
});

/** A raw request with any Host header, as a browser sends after a DNS rebinding. */
function raw(
  path: string,
  options: { method?: string; host: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; headers: Record<string, string | string[] | undefined> }> {
  const url = new URL(deployment.credentials.url);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: url.hostname,
        port: url.port,
        path,
        method: options.method ?? 'GET',
        headers: { host: options.host, ...options.headers },
        setHost: false,
      },
      (response) => {
        response.resume();
        resolve({ status: response.statusCode ?? 0, headers: response.headers });
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

describe('W1 H6: DNS rebinding', () => {
  for (const host of ['evil.example', 'evil.example:7780', 'lookout.attacker.lan']) {
    it(`refuses sign-in and the API to a rebound name (Host: ${host}) (regression)`, async () => {
      const login = await raw('/api/login', {
        method: 'POST',
        host,
        headers: { origin: `http://${host}`, 'content-type': 'application/json' },
        body: JSON.stringify({ password: deployment.credentials.password }),
      });
      expect(login.status).toBe(421);
      expect(login.headers['set-cookie']).toBeUndefined();
      const containers = await raw('/api/containers', { host });
      expect(containers.status).toBe(421);
    });
  }
});

describe('W1: headers on the live streams', () => {
  it('the SSE responses carry the CSP, nosniff and no-store (regression)', async () => {
    const response = await deployment.api('/api/stream', { signal: AbortSignal.timeout(5000) });
    expect(response.status).toBe(200);
    await response.body?.cancel();
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it('sends the security headers on pages and API answers', async () => {
    for (const path of ['/login', '/api/containers', '/api/does-not-exist']) {
      const response = await deployment.api(path);
      expect(response.headers.get('content-security-policy'), path).toContain("default-src 'self'");
      expect(response.headers.get('x-content-type-options'), path).toBe('nosniff');
    }
  });
});

describe('W1: the SPA in a real browser', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser.close();
  });

  it('shows every page with no CSP violation, and the Hostile Container as text', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const violations: string[] = [];
    const dialogs: string[] = [];
    page.on('console', (message) => {
      if (/Content Security Policy/i.test(message.text())) violations.push(message.text());
    });
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    // A string, as the server's TypeScript has no DOM types.
    await page.addInitScript(`
      document.addEventListener('securitypolicyviolation', (event) => {
        console.log('Content Security Policy violation: ' + event.violatedDirective);
      });
    `);
    const base = deployment.credentials.url;
    await page.goto(`${base}/login`);
    await page.getByLabel(/password/i).fill(deployment.credentials.password);
    await page.keyboard.press('Enter');
    await page.waitForURL(`${base}/`);

    const hostile = await deployment.idOf('hostile.container_-..x');
    for (const path of ['/', '/containers', `/containers/${hostile}`, '/websites', '/settings']) {
      await page.goto(`${base}${path}`);
      await page.waitForLoadState('networkidle').catch(() => undefined);
      await page.waitForTimeout(1500);
    }

    // On the Hostile Container's page: its markup is text, never an element.
    await page.goto(`${base}/containers/${hostile}`);
    // The detail is fetched again once the stream's first snapshot arrives; wait for it to
    // render rather than for a fixed time.
    await page.getByText('Container ID').first().waitFor({ timeout: 30_000 });
    expect(await page.locator('img[src="x"]').count()).toBe(0);
    expect(await page.locator('script:not([src])').count()).toBe(0);
    expect(await page.content()).toContain('&lt;img src=x onerror=');

    expect(violations).toEqual([]);
    expect(dialogs).toEqual([]);
    await context.close();
  });
});
