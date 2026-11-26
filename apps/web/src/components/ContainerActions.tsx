import { useEffect, useId, useRef, useState, type SyntheticEvent } from 'react';
import {
  actionPath,
  actionsOffered,
  isSelf,
  type ContainerAction,
  type ContainerActionResult,
  type ContainerSummary,
} from '@lookout/shared';
import { postJson } from '../api.ts';

const WORDS: Record<ContainerAction, { verb: string; progress: string; done: string }> = {
  start: { verb: 'Start', progress: 'Starting', done: 'Started' },
  stop: { verb: 'Stop', progress: 'Stopping', done: 'Stopped' },
  restart: { verb: 'Restart', progress: 'Restarting', done: 'Restarted' },
  remove: { verb: 'Remove', progress: 'Removing', done: 'Removed' },
};

const CONSEQUENCES: Partial<Record<ContainerAction, string>> = {
  stop: 'Docker asks the Container to stop and kills it if it has not stopped after its timeout. Whatever it serves is unavailable until it is started again.',
  restart:
    'The Container stops and starts again. Whatever it serves is briefly unavailable while it does.',
  remove:
    'The Container is deleted. Its volumes are kept, but anything written inside the Container is lost. This cannot be undone.',
};

type Outcome = { ok: true; text: string } | { ok: false; text: string };

/**
 * Asks before Stop and Restart (FR-24); Remove also needs the Container's name typed
 * exactly (FR-25). A native modal dialog, so focus stays inside it and Escape cancels.
 */
export function ConfirmActionDialog({
  action,
  name,
  onConfirm,
  onCancel,
}: {
  action: ContainerAction;
  name: string;
  onConfirm: (confirmName: string) => void;
  onCancel: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [typed, setTyped] = useState('');
  const needsName = action === 'remove';
  const confirmed = !needsName || typed === name;

  useEffect(() => {
    const element = dialog.current;
    if (!element || element.open) return;
    if (typeof element.showModal === 'function') element.showModal();
    else element.setAttribute('open', '');
  }, []);

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (confirmed) onConfirm(typed);
  };

  return (
    <dialog
      ref={dialog}
      className="dialog"
      aria-labelledby={titleId}
      data-testid="confirm-dialog"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <form onSubmit={submit}>
        <h2 className="dialog__title" id={titleId}>
          {WORDS[action].verb} <bdi>{name}</bdi>?
        </h2>
        <p className="dialog__text">{CONSEQUENCES[action]}</p>
        {needsName && (
          <label className="field">
            <span className="field__label">
              Type{' '}
              <code>
                <bdi>{name}</bdi>
              </code>{' '}
              to confirm
            </span>
            <input
              className="field__input"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              data-testid="confirm-name"
              autoFocus
            />
          </label>
        )}
        <div className="dialog__buttons">
          <button type="button" className="button button--quiet" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="submit"
            className="button button--danger"
            disabled={!confirmed}
            data-testid="confirm-action"
          >
            {WORDS[action].verb}
          </button>
        </div>
      </form>
    </dialog>
  );
}

/**
 * The Container Actions offered for a Container's state (FR-23). Lookout's own Container
 * shows them disabled (FR-26); the server refuses them too. Progress, then success or
 * Docker's error, is announced (FR-27); the new state itself arrives on the live list.
 */
export function ContainerActions({
  container,
  onRemoved,
}: {
  container: ContainerSummary;
  onRemoved?: () => void;
}) {
  const [pending, setPending] = useState<ContainerAction | null>(null);
  const [confirming, setConfirming] = useState<ContainerAction | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const self = isSelf(container);
  const offered = actionsOffered(container);

  const run = async (action: ContainerAction, confirmName?: string) => {
    setConfirming(null);
    setOutcome(null);
    setPending(action);
    const result = await postJson<ContainerActionResult>(
      actionPath(container.id, action),
      confirmName === undefined ? {} : { confirmName },
    );
    setPending(null);
    if (result.ok) {
      setOutcome({ ok: true, text: `${WORDS[action].done} ${container.name}.` });
      if (action === 'remove') onRemoved?.();
    } else {
      setOutcome({ ok: false, text: `${WORDS[action].verb} failed: ${result.message}` });
    }
  };

  const choose = (action: ContainerAction) => {
    if (action === 'start') void run(action);
    else setConfirming(action);
  };

  return (
    <div className="actions" data-testid="container-actions">
      <div className="actions__buttons" role="group" aria-label="Container Actions">
        {offered.map((action) => (
          <button
            key={action}
            type="button"
            className={`button button--small ${
              action === 'start'
                ? ''
                : action === 'restart'
                  ? 'button--quiet'
                  : 'button--danger-quiet'
            }`}
            disabled={self || pending !== null}
            onClick={() => choose(action)}
            data-testid={`action-${action}`}
          >
            {WORDS[action].verb}
          </button>
        ))}
      </div>
      {self && (
        <p className="muted actions__note" data-testid="self-note">
          This is Lookout&rsquo;s own Container, so it cannot be stopped, restarted or removed from
          here.
        </p>
      )}
      <p className="actions__status" role="status" data-testid="action-status">
        {pending !== null && (
          <>
            <span className="spinner" aria-hidden="true" /> {WORDS[pending].progress}{' '}
            <bdi>{container.name}</bdi>…
          </>
        )}
        {pending === null && outcome?.ok && outcome.text}
      </p>
      {pending === null && outcome && !outcome.ok && (
        <p className="error" role="alert" data-testid="action-error">
          {outcome.text}
        </p>
      )}
      {confirming && (
        <ConfirmActionDialog
          action={confirming}
          name={container.name}
          onConfirm={(name) => void run(confirming, confirming === 'remove' ? name : undefined)}
          onCancel={() => setConfirming(null)}
        />
      )}
    </div>
  );
}
