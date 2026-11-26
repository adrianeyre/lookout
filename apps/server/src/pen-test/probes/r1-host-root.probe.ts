/**
 * R1 (#68) against the pen-test deployment, in the configuration that is running: the Host
 * root as Lookout's Container sees it. The deployment's Host root is the fixture Host root
 * inside the throwaway daemon (`/pen-test/host-root`, mounted read-only at `/host`), so a
 * probe may plant links and files there; each is removed again afterwards. What a real `/`
 * mount gives Lookout's user is V2's (#74), on a disposable VM. The in-process half is
 * r1-host-root.test.ts, r1-folders-race.test.ts and r1-df.test.ts.
 */
import type { HostSample } from '@lookout/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dindDocker, inDind } from '../deployment.ts';
import { FAKE_MARKER } from '../fixtures/plan.ts';
import { connect, type Deployment } from './deployment-harness.ts';

const ROOT = '/pen-test/host-root';
// The fixture Host root's mount table, edited inside the daemon; Lookout still reads it through HostRoot.
// eslint-disable-next-line no-restricted-syntax
const MOUNTS = `${ROOT}/proc/1/mounts`;
const LINK = '/mnt/pen-test-r1-link';
const KEY = `/home/r1-owner/.ssh/id_${FAKE_MARKER}`;

let deployment: Deployment;
beforeAll(async () => {
  deployment = await connect();
  inDind([
    'sh',
    '-c',
    [
      `cp ${MOUNTS} ${MOUNTS}.r1-backup`,
      // An absolute link: inside Lookout's Container it resolves to Lookout's own /etc.
      `ln -sfn /etc ${ROOT}${LINK}`,
      `printf '/dev/pen-test-r1 ${LINK} ext4 rw 0 0\\n' >> ${MOUNTS}`,
      // A made-up private key owned by the Host's UID 1000, readable by its owner only.
      `mkdir -p ${ROOT}/home/r1-owner/.ssh`,
      `printf '${FAKE_MARKER}-private-key\\n' > ${ROOT}${KEY}`,
      `chown -R 1000:1000 ${ROOT}/home/r1-owner`,
      `chmod 700 ${ROOT}/home/r1-owner/.ssh`,
      `chmod 600 ${ROOT}${KEY}`,
    ].join(' && '),
  ]);
});
afterAll(() => {
  inDind([
    'sh',
    '-c',
    `mv ${MOUNTS}.r1-backup ${MOUNTS}; rm -f ${ROOT}${LINK}; rm -rf ${ROOT}/home/r1-owner`,
  ]);
});

/** The first `host` event from a stream opened now. */
async function hostSample(): Promise<HostSample> {
  const response = await deployment.api('/api/stream', { signal: AbortSignal.timeout(15_000) });
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    text += decoder.decode(chunk, { stream: true });
    const match = /event: host\ndata: (.*)\n\n/.exec(text);
    if (match) return JSON.parse(match[1]!) as HostSample;
  }
  throw new Error('No host event');
}

describe('R1: who Lookout is on the Host', () => {
  it('runs as UID and GID 65532, a user no Host account uses (#106)', () => {
    const id = dindDocker(['exec', 'lookout', 'id'])?.trim();
    console.log(`[${deployment.configuration}] Lookout's id: ${id}`);
    expect(dindDocker(['exec', 'lookout', 'id', '-u'])?.trim()).toBe('65532');
    expect(dindDocker(['exec', 'lookout', 'id', '-g'])?.trim()).toBe('65532');
  });

  it("cannot read a 0600 file the Host's UID 1000 owns, through the read-only / mount (regression)", () => {
    const read = dindDocker(['exec', 'lookout', 'cat', `/host${KEY}`], { allowFail: true });
    console.log(`[${deployment.configuration}] read /host${KEY}: ${read?.trim() ?? 'refused'}`);
    expect(read).toBeNull();
    // Nor list the owner's .ssh, which is 0700.
    const listed = dindDocker(['exec', 'lookout', 'ls', `/host/home/r1-owner/.ssh`], {
      allowFail: true,
    });
    expect(listed).toBeNull();
  });

  it("runs /bin/df by its absolute path, busybox's in the Image (#114)", () => {
    const found = dindDocker(['exec', 'lookout', 'sh', '-c', 'ls -l /bin/df; command -v df']);
    console.log(`[${deployment.configuration}] df: ${found?.replace('\n', ' | ')}`);
    expect(found).toMatch(/\/bin\/df/);
  });
});

describe('R1 H14: a mount point reached through a link', () => {
  it('a mount point reached through a link out of the Host root is never measured (#113) (regression)', async () => {
    // A sample after the link was planted (the sampler re-reads the mount table every time).
    await new Promise((resolve) => setTimeout(resolve, 4000));
    const sample = await hostSample();
    const linked = sample.disks.find((d) => d.mountPoint === LINK);
    console.log(
      `[${deployment.configuration}] ${LINK}: ${linked ? JSON.stringify(linked) : 'not measured'}; disks: ${sample.disks.map((d) => d.mountPoint).join(' ')}`,
    );
    expect(linked).toBeUndefined();
    // The fixture Host root's own filesystems are still measured.
    expect(sample.disks.length).toBeGreaterThan(0);
  });
});
