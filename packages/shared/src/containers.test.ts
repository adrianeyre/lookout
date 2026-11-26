import { describe, expect, it } from 'vitest';
import { CONTAINER_STATES, flagReason, isFlagged, type ContainerHealth } from './containers.ts';

const HEALTHS: (ContainerHealth | null)[] = [null, 'starting', 'healthy', 'unhealthy'];
const EXIT_CODES: (number | null)[] = [null, 0, 1, 137, 255];

describe('isFlagged', () => {
  it('covers every state, health and exit code combination', () => {
    for (const state of CONTAINER_STATES) {
      for (const health of HEALTHS) {
        for (const exitCode of EXIT_CODES) {
          const expected =
            state === 'restarting' ||
            health === 'unhealthy' ||
            (state === 'exited' && exitCode !== null && exitCode !== 0);
          expect(isFlagged({ state, health, exitCode }), `${state} ${health} ${exitCode}`).toBe(
            expected,
          );
          expect(flagReason({ state, health, exitCode }) !== null).toBe(expected);
        }
      }
    }
  });

  it('does not flag a clean exit', () => {
    expect(isFlagged({ state: 'exited', health: null, exitCode: 0 })).toBe(false);
  });

  it('flags a non-zero exit and says why', () => {
    expect(isFlagged({ state: 'exited', health: null, exitCode: 1 })).toBe(true);
    expect(flagReason({ state: 'exited', health: null, exitCode: 137 })).toBe(
      'Exited with code 137',
    );
  });

  it('flags restarting and unhealthy Containers', () => {
    expect(flagReason({ state: 'restarting', health: null, exitCode: 0 })).toBe('Restarting');
    expect(flagReason({ state: 'running', health: 'unhealthy', exitCode: null })).toBe('Unhealthy');
  });

  it('only exited Containers are flagged for their exit code', () => {
    // A running Container keeps the exit code of its previous run.
    expect(isFlagged({ state: 'running', health: 'healthy', exitCode: 1 })).toBe(false);
    expect(isFlagged({ state: 'dead', health: null, exitCode: 1 })).toBe(false);
  });
});
