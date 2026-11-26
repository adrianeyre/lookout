/**
 * Applies the fixture plan (plan.ts) to the pen-test deployment's throwaway daemon:
 * `pnpm pen-test:seed`. Seeding is idempotent: every fixture Container is removed and made
 * again from the plan, and the fixture Host root is copied afresh, so reseeding after a
 * destructive probe restores the same set. The shipped Containers (Lookout and the proxy)
 * are only checked: `pnpm pen-test:up` starts them.
 */
import path from 'node:path';
import {
  REPO_ROOT,
  dindContainer,
  dindDocker,
  docker,
  inDind,
  runningConfiguration,
} from '../deployment.ts';
import {
  FIXTURE_IMAGE,
  FIXTURE_LABEL,
  PLAN,
  type FixtureContainer,
  type PenTestPlan,
} from './plan.ts';

const lines = (text: string | null) =>
  (text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

/** A health check that always fails, for the Flagged Container. */
const FAILING_HEALTH = [
  '--health-cmd',
  'exit 1',
  '--health-interval',
  '1s',
  '--health-retries',
  '1',
];

function createArgs(fixture: FixtureContainer): string[] {
  const args = ['--name', fixture.name, '--label', `${FIXTURE_LABEL}=${fixture.handle}`];
  for (const [key, value] of Object.entries(fixture.labels))
    args.push('--label', `${key}=${value}`);
  for (const [key, value] of Object.entries(fixture.env)) args.push('--env', `${key}=${value}`);
  for (const port of fixture.ports) {
    args.push('--publish', `127.0.0.1:${port.hostPort}:${port.containerPort}`);
  }
  for (const mount of fixture.mounts) args.push('--volume', `${mount.source}:${mount.target}:ro`);
  if (fixture.state === 'unhealthy') args.push(...FAILING_HEALTH);
  if (fixture.entrypoint) args.push('--entrypoint', fixture.entrypoint[0]!);
  if (fixture.composeProject) {
    // What Compose itself labels a Container with, so Lookout groups it the same way.
    const service = fixture.name.replace(`${fixture.composeProject}-`, '').replace(/-\d+$/, '');
    args.push(
      '--label',
      `com.docker.compose.project=${fixture.composeProject}`,
      '--label',
      `com.docker.compose.service=${service}`,
      '--label',
      'com.docker.compose.container-number=1',
      '--label',
      'com.docker.compose.oneoff=False',
    );
  }
  args.push(FIXTURE_IMAGE, ...(fixture.entrypoint ? fixture.entrypoint.slice(1) : fixture.command));
  return args;
}

function waitFor(name: string, done: (state: string) => boolean, what: string): void {
  for (let attempt = 0; attempt < 60; attempt++) {
    const state = dindDocker(
      [
        'inspect',
        '--format',
        '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{end}}',
        name,
      ],
      { allowFail: true },
    )?.trim();
    if (state && done(state)) return;
    execSleep(0.5);
  }
  throw new Error(`${name} did not become ${what}`);
}

const execSleep = (seconds: number) => inDind(['sleep', String(seconds)]);

export function seed(plan: PenTestPlan = PLAN): void {
  if (!dindContainer()) throw new Error('The pen-test deployment is not running: pnpm pen-test:up');
  const configuration = runningConfiguration();
  if (!configuration) throw new Error('Lookout is not running in the deployment: pnpm pen-test:up');

  // The fixture Host root, afresh.
  const { source, target } = plan.hostRoot;
  // Emptied in place, never replaced: Lookout's bind mount holds the directory itself, so a
  // new one at the same path would leave Lookout reading the deleted, empty original.
  inDind(['sh', '-c', 'mkdir -p "$1" && find "$1" -mindepth 1 -delete', 'sh', target]);
  docker(['cp', `${path.join(REPO_ROOT, source)}/.`, `${dindContainer()!}:${target}`]);

  // Every fixture Container, removed and made again.
  const existing = lines(
    dindDocker(['ps', '--all', '--quiet', '--filter', `label=${FIXTURE_LABEL}`]),
  );
  if (existing.length > 0) dindDocker(['rm', '--force', '--volumes', ...existing]);

  for (const fixture of plan.containers) {
    for (const mount of fixture.mounts) inDind(['mkdir', '-p', mount.source]);
    dindDocker(['create', ...createArgs(fixture)]);
    if (fixture.state === 'created') continue;
    dindDocker(['start', fixture.name]);
  }
  for (const fixture of plan.containers) {
    if (fixture.state === 'running')
      waitFor(fixture.name, (s) => s.startsWith('running'), 'running');
    if (fixture.state === 'exited') waitFor(fixture.name, (s) => s.startsWith('exited'), 'exited');
    if (fixture.state === 'unhealthy')
      waitFor(fixture.name, (s) => s === 'running/unhealthy', 'unhealthy');
  }

  // The shipped Containers: there, and labelled as Lookout's own.
  for (const shipped of plan.shipped) {
    if (!shipped.configurations.includes(configuration)) continue;
    const labels = dindDocker(['inspect', '--format', '{{json .Config.Labels}}', shipped.name], {
      allowFail: true,
    });
    if (labels === null)
      throw new Error(`${shipped.name} is not running: pnpm pen-test:up ${configuration}`);
    const parsed = JSON.parse(labels) as Record<string, string>;
    for (const [key, value] of Object.entries(shipped.labels)) {
      if (parsed[key] !== value) throw new Error(`${shipped.name} lacks the label ${key}=${value}`);
    }
  }
  console.log(
    `Seeded ${plan.containers.length} fixture Containers and the fixture Host root (${configuration}).`,
  );
}
