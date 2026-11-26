import type { ContainerState, ContainerSummary } from './containers.ts';

/** The four Container Actions (FR-23, ADR-0005). Nothing else is offered. */
export type ContainerAction = 'start' | 'stop' | 'restart' | 'remove';

export const CONTAINER_ACTIONS: readonly ContainerAction[] = ['start', 'stop', 'restart', 'remove'];

/** The label that marks Lookout's own Container (FR-26). */
export const SELF_LABEL = 'lookout.self';

/** States in which Docker considers the Container's process to be up. */
const UP: ReadonlySet<ContainerState> = new Set(['running', 'restarting', 'paused']);
/** States Start can bring up. A dead Container cannot be started, only removed. */
const STARTABLE: ReadonlySet<ContainerState> = new Set(['created', 'exited']);
/** Stopped: the only states Remove is offered for (FR-25: never a force-remove). */
const STOPPED: ReadonlySet<ContainerState> = new Set(['created', 'exited', 'dead']);

type ActionSubject = Pick<ContainerSummary, 'state' | 'labels'> &
  Pick<Partial<ContainerSummary>, 'selfClaimedByImage'>;

/**
 * True for Lookout's own Container, which no Container Action may touch (FR-26). Only the
 * operator's label counts: an Image that carries `lookout.self` itself cannot make its
 * Containers unstoppable from Lookout (#105).
 */
export function isSelf(
  container: Pick<ContainerSummary, 'labels'> &
    Pick<Partial<ContainerSummary>, 'selfClaimedByImage'>,
): boolean {
  return container.labels[SELF_LABEL] === 'true' && container.selfClaimedByImage !== true;
}

export function isContainerAction(value: string): value is ContainerAction {
  return (CONTAINER_ACTIONS as readonly string[]).includes(value);
}

/**
 * Why an action is not allowed on a Container right now, or null if it is. The one rule
 * used by the server, which refuses the request, and by the UI, which disables the button.
 */
export function actionRefusal(container: ActionSubject, action: ContainerAction): string | null {
  if (isSelf(container)) return 'Lookout cannot act on its own Container';
  switch (action) {
    case 'start':
      return STARTABLE.has(container.state) ? null : `Cannot start a ${container.state} Container`;
    case 'stop':
    case 'restart':
      return UP.has(container.state) ? null : `Cannot ${action} a ${container.state} Container`;
    case 'remove':
      return STOPPED.has(container.state)
        ? null
        : 'Only a stopped Container can be removed; stop it first';
  }
}

/** The actions to show for a Container's state (FR-23): start when down, stop and restart when up. */
export function actionsOffered(container: Pick<ContainerSummary, 'state'>): ContainerAction[] {
  if (UP.has(container.state)) return ['stop', 'restart'];
  const offered: ContainerAction[] = [];
  if (STARTABLE.has(container.state)) offered.push('start');
  offered.push('remove');
  return offered;
}

export interface ContainerActionRequest {
  /** Remove only: the Container's name, typed by the user to confirm (FR-25). */
  confirmName?: string;
}

export interface ContainerActionResult {
  action: ContainerAction;
  containerId: string;
}

/** The URL of a Container Action. */
export function actionPath(containerId: string, action: ContainerAction): string {
  return `/api/containers/${encodeURIComponent(containerId)}/actions/${action}`;
}
