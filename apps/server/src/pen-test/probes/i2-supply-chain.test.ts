/**
 * Pen-test scope issue I2 (#71): supply chain and publishing, probed by reading what this
 * repository ships: the workflows, Dependabot, pnpm's settings, the Dockerfile and the
 * Compose files (H12). The Project Website's half (H13, the published images and the
 * vendored Stageshow kit) is site/i2-website.test.ts. Findings are in
 * docs/pen-test/findings/I2.md. While a gap is open, an `it.fails` states the property that
 * should hold beside a `today_…` test pinning what happens now (PRD, "Checks every scope
 * issue carries"). GitHub's own settings (rules on main and tags, the github-pages
 * environment, GHCR) cannot be read from the tree; the findings note records them.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');
const WORKFLOW_DIR = '.github/workflows';
const workflows = readdirSync(path.join(ROOT, WORKFLOW_DIR))
  .filter((f) => f.endsWith('.yml'))
  .map((f) => ({ file: f, text: read(path.join(WORKFLOW_DIR, f)) }));

/** The workflow's jobs, each as its own block of text, by key. No YAML parser is needed. */
function jobs(text: string): Map<string, string> {
  const lines = text.split('\n');
  const start = lines.indexOf('jobs:');
  const found = new Map<string, string>();
  let key: string | null = null;
  let block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const match = /^ {2}([\w-]+):\s*$/.exec(line);
    if (match) {
      if (key) found.set(key, block.join('\n'));
      key = match[1]!;
      block = [];
    } else if (key) block.push(line);
  }
  if (key) found.set(key, block.join('\n'));
  return found;
}

/** The workflow's top-level `permissions:` block. */
function topPermissions(text: string): string {
  const match = /^permissions:\n((?: {2}.*\n)+)/m.exec(text);
  return match?.[1] ?? '';
}

describe('I2: the workflows (sound, pinned)', () => {
  it('reads every workflow, so the checks below have something to check', () => {
    expect(workflows.map((w) => w.file).sort()).toEqual([
      'ci.yml',
      'image.yml',
      'pages.yml',
      'pr-title.yml',
      'release.yml',
    ]);
  });

  it('pins every third-party action to a full commit SHA', () => {
    for (const { file, text } of workflows) {
      for (const [, ref] of text.matchAll(/uses:\s*(\S+)/g)) {
        if (ref!.startsWith('./')) continue;
        expect(ref, `${file}: ${ref}`).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
      }
    }
  });

  it('checks out with persist-credentials: false everywhere', () => {
    for (const { file, text } of workflows) {
      const checkouts = text.split('actions/checkout@').slice(1);
      for (const after of checkouts) {
        expect(after.slice(0, 400), file).toMatch(/persist-credentials: false/);
      }
    }
  });

  it('starts every workflow read-only', () => {
    for (const { file, text } of workflows) {
      const top = topPermissions(text);
      expect(top, file).not.toBe('');
      expect(top, file).not.toMatch(/write/);
    }
  });

  it('grants packages: write to the Image job and its two callers only', () => {
    const granted: string[] = [];
    for (const { file, text } of workflows) {
      for (const [name, block] of jobs(text)) {
        if (/packages: write/.test(block)) granted.push(`${file}:${name}`);
      }
    }
    expect(granted.sort()).toEqual(['image.yml:publish', 'release.yml:edge', 'release.yml:image']);
    // The callers only hand the grant to the reusable Image workflow; they run no steps.
    const release = jobs(workflows.find((w) => w.file === 'release.yml')!.text);
    for (const caller of ['edge', 'image']) {
      expect(release.get(caller)).toMatch(/uses: \.\/\.github\/workflows\/image\.yml/);
      expect(release.get(caller)).not.toMatch(/steps:/);
    }
  });

  it('grants pages: write only to the Pages deploy job, and id-token: write only there and to the Image job and its callers (#126)', () => {
    const pages = jobs(workflows.find((w) => w.file === 'pages.yml')!.text);
    expect(pages.get('deploy')).toMatch(/pages: write/);
    expect(pages.get('deploy')).not.toMatch(/run:|actions\/checkout|pnpm/);
    // The Image job signs its provenance attestation (OIDC); release.yml's edge and image
    // jobs only call it, and a called workflow gets no more than its caller grants.
    const signers = new Set([
      'pages.yml:deploy',
      'image.yml:publish',
      'release.yml:edge',
      'release.yml:image',
    ]);
    for (const { file, text } of workflows) {
      for (const [name, block] of jobs(text)) {
        if (file !== 'pages.yml' || name !== 'deploy') {
          expect(block, `${file}:${name}`).not.toMatch(/pages: write/);
        }
        if (!signers.has(`${file}:${name}`)) {
          expect(block, `${file}:${name}`).not.toMatch(/id-token: write|attestations: write/);
        }
      }
    }
  });

  it('never runs on pull_request_target, and releases only after a push to main', () => {
    for (const { file, text } of workflows) {
      expect(text, file).not.toMatch(/pull_request_target/);
    }
    const release = workflows.find((w) => w.file === 'release.yml')!.text;
    expect(release).toMatch(/branches: \[main\]/);
    const releaseJobs = jobs(release);
    for (const job of ['edge', 'gate']) {
      expect(releaseJobs.get(job)).toMatch(/github\.event\.workflow_run\.event == 'push'/);
      expect(releaseJobs.get(job)).toMatch(/workflow_run\.conclusion == 'success'/);
    }
    expect(releaseJobs.get('release')).toMatch(/needs: \[edge, gate\]/);
  });

  it("writes the Image job's build cache only from main: image.yml is never triggered by a pull request", () => {
    const image = workflows.find((w) => w.file === 'image.yml')!.text;
    expect(image).toMatch(/^on:\n {2}workflow_call:/m);
    expect(image).toMatch(/cache-to: type=gha/);
    // Only release.yml calls it, and release.yml runs only on CI's push to main.
    const callers = workflows.filter((w) => w.text.includes('./.github/workflows/image.yml'));
    expect(callers.map((w) => w.file)).toEqual(['release.yml']);
  });

  it('scans the Image with Trivy, pinned by digest, and checks it is non-root', () => {
    const ci = workflows.find((w) => w.file === 'ci.yml')!.text;
    expect(ci).toMatch(/aquasec\/trivy:[\d.]+@sha256:[0-9a-f]{64}/);
    expect(ci).toMatch(/test "\$\(id -u\)" != 0/);
  });
});

describe('I2: pnpm runs no dependency code at install (sound)', () => {
  const pkg = JSON.parse(read('package.json')) as {
    packageManager: string;
    pnpm?: Record<string, unknown>;
  };
  const workspace = read('pnpm-workspace.yaml');

  it('is pnpm 10 or later, which runs no dependency build script unless one is allowed', () => {
    const major = Number(/^pnpm@(\d+)\./.exec(pkg.packageManager)?.[1]);
    expect(major).toBeGreaterThanOrEqual(10);
  });

  it('allows no dependency to run a build script, anywhere pnpm reads settings', () => {
    const allowing =
      /onlyBuiltDependencies|allowBuilds|dangerouslyAllowAllBuilds|neverBuiltDependencies|enable-pre-post-scripts/;
    expect(workspace).not.toMatch(allowing);
    expect(JSON.stringify(pkg.pnpm ?? {})).not.toMatch(allowing);
    let npmrc = '';
    try {
      npmrc = read('.npmrc');
    } catch {
      // No .npmrc: nothing to allow builds from.
    }
    expect(npmrc).not.toMatch(allowing);
  });

  it('installs from the frozen lockfile in every workflow and in the Dockerfile', () => {
    for (const { file, text } of workflows) {
      for (const [, command] of text.matchAll(/run: (pnpm install.*)/g)) {
        expect(command, file).toMatch(/--frozen-lockfile/);
      }
    }
    for (const [, command] of read('Dockerfile').matchAll(/RUN (pnpm install.*)/g)) {
      expect(command).toMatch(/--frozen-lockfile/);
    }
  });
});

describe('I2: what Hosts pull (H12)', () => {
  const compose = read('compose.yaml');
  const proxy = read('compose.socket-proxy.yaml');
  const dependabot = read('.github/dependabot.yml');
  const image = read('.github/workflows/image.yml');
  const readme = read('README.md');
  const lookoutImage = /image:\s*(ghcr\.io\/adrianeyre\/lookout\S*)/.exec(compose)?.[1] ?? '';

  it('pins the Dockerfile base and the socket proxy by digest', () => {
    const froms = [...read('Dockerfile').matchAll(/^FROM (\S+)/gm)].map((m) => m[1]!);
    const external = froms.filter((f) => f.includes(':'));
    expect(external.length).toBeGreaterThan(0);
    for (const from of external) expect(from).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(proxy).toMatch(/image: wollomatic\/socket-proxy:[\d.]+@sha256:[0-9a-f]{64}/);
  });

  it("pins Lookout's own Image by digest in compose.yaml, or lets Dependabot move it", () => {
    const pinned = /@sha256:[0-9a-f]{64}$/.test(lookoutImage);
    const tracked = !/dependency-name: ghcr\.io\/adrianeyre\/lookout/.test(dependabot);
    expect(pinned || tracked).toBe(true);
  });

  it('compose.yaml pulls the X.Y tag, which Dependabot now moves to each new minor release (regression)', () => {
    expect(lookoutImage).toMatch(/^ghcr\.io\/adrianeyre\/lookout:\d+\.\d+$/);
    expect(dependabot).not.toMatch(/dependency-name: ghcr\.io\/adrianeyre\/lookout/);
    expect(dependabot).toMatch(/package-ecosystem: docker-compose/);
  });

  it('signs or attests every Image it pushes, and the README says how to verify one', () => {
    const attests =
      /actions\/attest-build-provenance@[0-9a-f]{40}|sigstore\/cosign-installer@|cosign sign/;
    expect(image).toMatch(attests);
    expect(image).toMatch(/id-token: write/);
    expect(image).toMatch(/subject-digest: \$\{\{ steps\.push\.outputs\.digest \}\}/);
    expect(readme).toMatch(/gh attestation verify|cosign verify/);
  });

  it('provenance and an SBOM are attached, and the provenance is signed for a Host to verify (regression)', () => {
    expect(image).toMatch(/provenance: mode=max/);
    expect(image).toMatch(/sbom: true/);
    expect(image).toMatch(/push-to-registry: true/);
    expect(readme).toMatch(/gh attestation verify/);
  });
});

describe('I2: what runs beside the release token', () => {
  const release = jobs(read('.github/workflows/release.yml')).get('release')!;
  const releaserc = JSON.parse(read('.releaserc.json')) as { plugins: unknown[] };
  const githubPlugin = releaserc.plugins.find(
    (p) =>
      p === '@semantic-release/github' || (Array.isArray(p) && p[0] === '@semantic-release/github'),
  );
  const githubOptions = (Array.isArray(githubPlugin) ? githubPlugin[1] : {}) as Record<
    string,
    unknown
  >;

  it('grants semantic-release only contents: write, with comments on issues and pull requests turned off', () => {
    expect(release).not.toMatch(/issues: write|pull-requests: write/);
    expect(githubOptions.successComment).toBe(false);
    expect(githubOptions.failComment).toBe(false);
  });

  it('semantic-release and its dependencies run with contents: write alone (regression)', () => {
    expect(release).toMatch(/contents: write/);
    expect(release).not.toMatch(/issues: write/);
    expect(release).not.toMatch(/pull-requests: write/);
    expect(release).toMatch(/pnpm install --frozen-lockfile/);
    expect(release).toMatch(/pnpm exec semantic-release/);
    expect(githubOptions.releasedLabels).toBe(false);
  });
});
