import { describe, expect, it } from 'vitest';
import { actionRefusal, actionsOffered, isSelf, type ContainerAction } from './actions.ts';
import { CONTAINER_STATES, type ContainerState } from './containers.ts';

const subject = (state: ContainerState, labels: Record<string, string> = {}) => ({ state, labels });

describe('Container Action rules', () => {
  it.each<[ContainerState, ContainerAction[]]>([
    ['running', ['stop', 'restart']],
    ['restarting', ['stop', 'restart']],
    ['paused', ['stop', 'restart']],
    ['created', ['start', 'remove']],
    ['exited', ['start', 'remove']],
    ['dead', ['remove']],
  ])('offers the right actions for a %s Container', (state, expected) => {
    expect(actionsOffered({ state })).toEqual(expected);
    for (const action of expected) expect(actionRefusal(subject(state), action)).toBeNull();
  });

  it('refuses every action that is not offered', () => {
    for (const state of CONTAINER_STATES) {
      const offered = actionsOffered({ state });
      for (const action of ['start', 'stop', 'restart', 'remove'] as const) {
        if (!offered.includes(action)) expect(actionRefusal(subject(state), action)).not.toBeNull();
      }
    }
  });

  it('never allows removing a running Container', () => {
    expect(actionRefusal(subject('running'), 'remove')).toMatch(/stopped/);
  });

  it("refuses every action on Lookout's own Container, in every state", () => {
    for (const state of CONTAINER_STATES) {
      for (const action of ['start', 'stop', 'restart', 'remove'] as const) {
        expect(actionRefusal(subject(state, { 'lookout.self': 'true' }), action)).toMatch(
          /own Container/,
        );
      }
    }
  });

  it('only treats lookout.self=true as self', () => {
    expect(isSelf({ labels: { 'lookout.self': 'true' } })).toBe(true);
    expect(isSelf({ labels: { 'lookout.self': 'false' } })).toBe(false);
    expect(isSelf({ labels: {} })).toBe(false);
    // The Image's own LABEL is not the operator's (#105).
    expect(isSelf({ labels: { 'lookout.self': 'true' }, selfClaimedByImage: true })).toBe(false);
  });
});
