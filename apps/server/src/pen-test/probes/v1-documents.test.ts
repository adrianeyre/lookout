/**
 * Pen-test scope issue V1 (#72): documents against code. Every claim the v1 and v1.1
 * security reviews, the ADRs and the README's security section make is checked against
 * the code as it is. Findings are in docs/pen-test/findings/V1.md.
 *
 * Where a document said something the code did not do, a `today_…` test pinned what the
 * code does, and an `it.fails` reads the document and states what it should say (or what
 * the code should do). Each behavioural probe has a positive control beside it, so it
 * cannot pass either way.
 */
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { X509Certificate } from 'node:crypto';
import type { ContainerSummary } from '@lookout/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { walkFilesystem } from '../../folders/scan.ts';
import { MAX_NAME_LENGTH, certificateFrom } from '../../sites/check.ts';
import { discoverSites } from '../../sites/discovery.ts';
import {
  HOST,
  ORIGIN,
  TEST_PASSWORD,
  makeWebDist,
  startProbeApp,
  type ProbeApp,
} from './harness.ts';

const REPO = fileURLToPath(new URL('../../../../../', import.meta.url));
const doc = (relative: string) => readFileSync(path.join(REPO, relative), 'utf8');

const REVIEW_V1 = 'docs/security-review-v1.md';
const REVIEW_V11 = 'docs/security-review-v1.1.md';
const ADR = (name: string) => `docs/architectural-decision-record/${name}`;
const ADR_0003 = ADR('0003-deploy-as-container-with-host-access.md');
const ADR_0008 = ADR('0008-single-password-private-network.md');
const ADR_0010 = ADR('0010-hosted-sites-checked-from-the-host.md');
const ADR_0011 = ADR('0011-optional-docker-socket-proxy.md');

/** The README's "## Security" section, up to the next level-2 heading. */
function readmeSecurity(): string {
  const readme = doc('README.md');
  const start = readme.indexOf('\n## Security');
  const end = readme.indexOf('\n## ', start + 1);
  return readme.slice(start, end);
}

/** The text of a document's "Accepted risks" section. */
function acceptedRisks(relative: string): string {
  const text = doc(relative);
  const start = text.indexOf('## Accepted risks');
  const end = text.indexOf('\n## ', start + 1);
  return text.slice(start, end === -1 ? undefined : end);
}

/** The row of a review's checklist table for item `n`. */
function checklistRow(relative: string, n: number): string {
  return doc(relative)
    .split('\n')
    .find((line) => line.startsWith(`| ${n} |`))!;
}

/** Words that record when an accepted risk stops being true. */
const RECORDS_AN_END =
  /stops? being true|no longer (holds|true)|revisit(ed)? (when|if|on|by)|until \d/i;

const apps: ProbeApp[] = [];
async function start(...args: Parameters<typeof startProbeApp>): Promise<ProbeApp> {
  const probe = await startProbeApp(...args);
  apps.push(probe);
  return probe;
}
afterEach(async () => {
  for (const probe of apps.splice(0)) await probe.close();
});

const sessionStatus = async (probe: ProbeApp, cookie: string) =>
  (await probe.app.inject({ url: '/api/session', headers: { cookie, host: HOST } })).statusCode;

describe('V1 the documents are where the probes expect them', () => {
  it('every document V1 reads exists and has the sections the probes slice', () => {
    expect(checklistRow(REVIEW_V1, 4)).toMatch(/path traversal/);
    expect(checklistRow(REVIEW_V11, 3)).toMatch(/Label trust/);
    expect(acceptedRisks(REVIEW_V1)).toMatch(/No TLS in Lookout itself/);
    expect(acceptedRisks(REVIEW_V11)).toMatch(/loopback/);
    expect(readmeSecurity()).toMatch(/What protects it/);
    for (const adr of [ADR_0003, ADR_0008, ADR_0010, ADR_0011]) expect(doc(adr)).toMatch(/^---/);
  });
});

describe('V1 v1 review item 4 and ADR-0003: what Lookout reads from the Host', () => {
  async function hostTree(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), 'lookout-v1-host-'));
    // Outside /home and /root, which the walk never enters since #107.
    await mkdir(path.join(root, 'srv', 'alice', 'private-notes'), { recursive: true });
    // Two files of a size, so no one child dominates and the folder itself is a candidate.
    for (const name of ['a.txt', 'b.txt']) {
      await writeFile(path.join(root, 'srv', 'alice', 'private-notes', name), 'x'.repeat(65_536));
    }
    await mkdir(path.join(root, 'srv'), { recursive: true });
    await writeFile(path.join(root, 'srv', 'a.txt'), 'y'.repeat(512));
    return root;
  }

  it('the Largest folders walk lists folder names under a Host mount point, beyond statfs, as the v1 review and ADR-0003 now say (regression)', async () => {
    const root = await hostTree();
    const { candidates, walked } = await walkFilesystem(root, '/');
    // Positive control: the walk saw the tree at all.
    expect(walked).toBeGreaterThan(0);
    // The folder names of the Host's filesystem, which the browser is then sent.
    expect(candidates.map((c) => c.path)).toContain('/srv/alice/private-notes');
  });

  it("the v1 review and ADR-0003 say Lookout lists the Host's folders, not only statfs", () => {
    expect(checklistRow(REVIEW_V1, 4)).not.toMatch(/only `statfs`ed, never read/);
    expect(doc(ADR_0003)).toMatch(/folder|directory|walk/i);
  });
});

describe('V1 v1 review, accepted risks: sessions live in memory (H5)', () => {
  it('"restarting Lookout signs everyone out" is now true: a cookie from before a restart is refused', async () => {
    const before = await start();
    const cookie = await before.signIn();
    // Positive control: the cookie works where it was issued.
    expect(await sessionStatus(before, cookie)).toBe(200);
    const restarted = await start();
    expect(await sessionStatus(restarted, cookie)).toBe(401);
  });

  it('the README\'s "end when Lookout restarts or the password changes" holds for a password change', async () => {
    const before = await start();
    const cookie = await before.signIn();
    expect(await sessionStatus(before, cookie)).toBe(200);
    // Same process state but a different hash: what recreating with a new password gives.
    const other = await start({
      config: {
        passwordHash:
          '$argon2id$v=19$m=8192,t=1,p=1$b3RoZXItc2FsdA$b3RoZXItaGFzaC1mb3ItdjEtcHJvYmU',
      },
    });
    expect(await sessionStatus(other, cookie)).toBe(401);
  });
});

describe('V1 v1 review, accepted risks: "the cookie becomes Secure automatically" (H7)', () => {
  const signIn = (probe: ProbeApp, headers: Record<string, string>) =>
    probe.app.inject({
      method: 'POST',
      url: '/api/login',
      headers: { origin: ORIGIN, host: HOST, ...headers },
      payload: { password: TEST_PASSWORD },
    });

  it('a proxy that sends no X-Forwarded-Proto (nginx by default) gets no Secure cookie, as the v1 review now says (regression)', async () => {
    const probe = await start();
    const plain = await signIn(probe, {});
    expect(plain.statusCode).toBe(204);
    expect(String(plain.headers['set-cookie'])).not.toMatch(/;\s*Secure/);
    // Positive control: with the header the cookie is Secure.
    const forwarded = await signIn(probe, { 'x-forwarded-proto': 'https' });
    expect(String(forwarded.headers['set-cookie'])).toMatch(/;\s*Secure/);
  });

  it('a proxy that reaches Lookout by a name not in LOOKOUT_HOSTNAMES gets 421, as the README says', async () => {
    const probe = await start();
    const response = await signIn(probe, {
      host: 'lookout.proxy.example',
      origin: 'https://lookout.proxy.example',
      'x-forwarded-proto': 'https',
    });
    expect(response.statusCode).toBe(421);
    // Positive control: the listed name is answered.
    expect((await signIn(probe, { 'x-forwarded-proto': 'https' })).statusCode).toBe(204);
  });

  it('the v1 review says what makes the cookie Secure (X-Forwarded-Proto or LOOKOUT_SECURE_COOKIE)', () => {
    const risk = acceptedRisks(REVIEW_V1);
    expect(risk).not.toMatch(/becomes `Secure` automatically/);
    expect(risk).toMatch(/X-Forwarded-Proto|LOOKOUT_SECURE_COOKIE/);
  });
});

describe('V1 README: "answers only on its own addresses and LOOKOUT_HOSTNAMES"', () => {
  it('any IP address in Host is answered, as the README now says (regression)', async () => {
    const probe = await start();
    const foreignIp = await probe.app.inject({ url: '/healthz', headers: { host: '203.0.113.9' } });
    expect(foreignIp.statusCode).toBe(200);
    // Positive control: a name not listed is refused.
    const name = await probe.app.inject({ url: '/healthz', headers: { host: 'evil.example' } });
    expect(name.statusCode).toBe(421);
  });

  it('the README says which Host headers Lookout answers (any IP address, localhost, LOOKOUT_HOSTNAMES)', () => {
    expect(readmeSecurity()).not.toMatch(/answers only on its own addresses/);
  });
});

describe('V1 H4: ADR-0010, v1.1 review item 3 and the README on label trust', () => {
  const imageLabelled: ContainerSummary = {
    id: 'c'.repeat(64),
    name: 'innocent-app',
    image: 'publisher/innocent-app:1',
    state: 'running',
    health: null,
    composeProject: null,
    // As Docker merges them from the Image's LABEL lines: the operator wrote none of these.
    labels: {
      'lookout.url':
        'http://169.254.169.254/latest/meta-data/,http://127.0.0.1:2375/containers/json',
      'lookout.check': 'public',
    },
  } as unknown as ContainerSummary;

  it("labels the operator never wrote (an Image's LABELs) no longer reach internal addresses (#103) (regression)", () => {
    const { sites } = discoverSites([imageLabelled], ['https://operator.example/']);
    const byUrl = new Map(sites.map((s) => [s.url, s]));
    // Found, so the Websites page can say why, but refused: never checked.
    expect(byUrl.get('http://169.254.169.254/latest/meta-data/')?.refusal).toBeTruthy();
    expect(byUrl.get('http://127.0.0.1:2375/containers/json')?.refusal).toBeTruthy();
    // Positive control: the operator's own site is there and is checked.
    expect(byUrl.get('https://operator.example/')?.refusal).toBeFalsy();
  });

  it('ADR-0010, the v1.1 review and the README do not rest on "whoever labels a Container controls Docker"', () => {
    const adr = doc(ADR_0010);
    expect(adr).not.toMatch(/Anyone who can label a Container already controls Docker/);
    expect(checklistRow(REVIEW_V11, 3)).not.toMatch(
      /whoever controls a Container's labels already controls Docker/,
    );
    expect(readmeSecurity()).not.toMatch(/only reach what you configured/);
    // An Image's LABELs are named as a source of labels.
    expect(adr).toMatch(/Image'?s? (LABEL|label)/);
  });
});

describe('V1 ADRs and reviews that accept a risk record when it stops being true', () => {
  const accepting = {
    [ADR_0003]: 'Docker socket access is root-equivalent on the Host',
    [ADR_0008]: 'reachable over LAN/VPN behind one password',
    [ADR_0010]: 'labels choose what Lookout checks',
    // Since #101 the loopback is closed; what ADR-0011 still accepts is the query (#102).
    [ADR_0011]: 'the proxy cannot see the query of a remove',
    [`${REVIEW_V1} (accepted risks)`]: 'four accepted risks',
    [`${REVIEW_V11} (accepted risks)`]: 'three accepted risks, and item 3',
  };
  const text = (key: string) =>
    key.endsWith('(accepted risks)') ? acceptedRisks(key.split(' ')[0]!) : doc(key);

  it('every one of them records an end, dated or conditioned (#131) (regression)', () => {
    for (const key of Object.keys(accepting)) expect(text(key), key).toMatch(RECORDS_AN_END);
    // Negative control: text with no end does not match the pattern.
    expect('Accepted, by design.').not.toMatch(RECORDS_AN_END);
  });

  for (const [key, risk] of Object.entries(accepting)) {
    it(`${key} records when "${risk}" stops being true`, () => {
      expect(text(key)).toMatch(RECORDS_AN_END);
    });
  }
});

describe('V1 v1.1 review, findings fixed: certificate names are cut to 256 characters', () => {
  it('keeps at most 256 characters of a subject and issuer from an untrusted certificate', () => {
    const long = 'a'.repeat(10_000);
    const fakeCertificate = (subject: string) =>
      ({
        subject,
        issuer: `O=${long}\nCN=issuer`,
        validTo: 'Jan  1 00:00:00 2030 GMT',
        checkHost: () => undefined,
        checkIP: () => undefined,
      }) as unknown as X509Certificate;
    const summary = certificateFrom(fakeCertificate(`CN=${long}`), 'site.example', null);
    expect(MAX_NAME_LENGTH).toBe(256);
    expect(summary.subject).toHaveLength(256);
    expect(summary.issuer).toHaveLength(256);
    // Positive control: a short name is kept whole.
    const short = fakeCertificate('CN=site.example');
    expect(certificateFrom(short, 'site.example', null).subject).toBe('site.example');
  });
});

describe('V1 Good and to confirm: static files are read into memory at start', () => {
  it('serves only what was in the build at start, with no path handling per request', async () => {
    const dist = await makeWebDist();
    const probe = await start({ webDistDir: dist });
    const cookie = await probe.signIn();
    const get = (url: string) =>
      probe.app.inject({ url, headers: { cookie, host: HOST } }).then((r) => r.statusCode);
    // Positive control: a built asset is served.
    expect(await get('/assets/index-abc123.js')).toBe(200);
    // A file written after start is never served, so nothing is read from disk per request.
    await writeFile(path.join(dist, 'assets', 'late.js'), 'late');
    expect(await get('/assets/late.js')).toBe(404);
    // Path tricks never reach a file outside the map.
    for (const url of [
      '/assets/../index.html',
      '/assets/%2e%2e/index.html',
      '/assets/..%2findex.html',
      '/assets//index-abc123.js',
      '/../../../../etc/passwd',
      '/assets/index-abc123.js/',
    ]) {
      expect(await get(url), url).toBe(404);
    }
  });
});
