import { useEffect, useId, useRef, useState, type SyntheticEvent } from 'react';
import { volumeDeletePath, type DockerVolume } from '@lookout/shared';
import { postJson } from '../api.ts';
import { formatBytes } from '../format.ts';
import { unusedVolumes, volumesOf, type VolumesState } from '../volumes.ts';
import { Card } from './Card.tsx';

const size = (volume: DockerVolume) =>
  volume.sizeBytes === null ? 'size not measured yet' : formatBytes(volume.sizeBytes);

/** The volumes a Container mounts, under its row on the Containers page. */
export function ContainerVolumes({
  state,
  containerId,
}: {
  state: VolumesState;
  containerId: string;
}) {
  if (state.status !== 'ok') return null;
  const mounted = volumesOf(state.snapshot.volumes, containerId);
  if (mounted.length === 0) return null;
  return (
    <div className="row__volumes" data-testid="container-volumes">
      <span className="row__volumes-label muted">Volumes</span>
      <ul className="volumes">
        {mounted.map(({ volume, destination, readOnly }) => (
          <li
            key={`${volume.name}:${destination}`}
            className="volume"
            data-testid="container-volume"
          >
            <bdi className="volume__name" data-testid="volume-name">
              {volume.name}
            </bdi>
            <span className="muted">
              {' '}
              at <bdi>{destination}</bdi>
              {readOnly ? ' (read-only)' : ''} ·{' '}
              <span data-testid="volume-size">{size(volume)}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Asks for the volume's name typed exactly before deleting it. Escape cancels. */
export function DeleteVolumeDialog({
  name,
  onConfirm,
  onCancel,
}: {
  name: string;
  onConfirm: (confirmName: string) => void;
  onCancel: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [typed, setTyped] = useState('');
  const confirmed = typed === name;

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
      data-testid="volume-delete-dialog"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <form onSubmit={submit}>
        <h2 className="dialog__title" id={titleId}>
          Delete <bdi>{name}</bdi>?
        </h2>
        <p className="dialog__text">
          The volume and everything in it are deleted. No Container uses it now. This cannot be
          undone.
        </p>
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
            data-testid="volume-confirm-name"
            autoFocus
          />
        </label>
        <div className="dialog__buttons">
          <button type="button" className="button button--quiet" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="submit"
            className="button button--danger"
            disabled={!confirmed}
            data-testid="volume-confirm-delete"
          >
            Delete
          </button>
        </div>
      </form>
    </dialog>
  );
}

function created(volume: DockerVolume): string | null {
  if (volume.createdAt === null) return null;
  return new Date(volume.createdAt).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * Volumes no Container, running or stopped, mounts (ADR-0015), each with Delete. The server
 * checks again that nothing uses it, and never forces.
 */
export function UnusedVolumesCard({
  state,
  refresh,
}: {
  state: VolumesState;
  refresh: () => void;
}) {
  const [asking, setAsking] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const remove = async (name: string, confirmName: string) => {
    setAsking(null);
    setBusy(name);
    setMessage(null);
    const result = await postJson<{ deleted: string }>(volumeDeletePath(name), { confirmName });
    setBusy(null);
    setMessage(
      result.ok ? { ok: true, text: `Deleted ${name}` } : { ok: false, text: result.message },
    );
    refresh();
  };

  let body;
  if (state.status === 'loading') {
    body = (
      <p className="muted" role="status">
        Loading volumes…
      </p>
    );
  } else if (state.status === 'error') {
    body = (
      <p className="error" role="alert" data-testid="volumes-error">
        {state.message}
      </p>
    );
  } else {
    const unused = unusedVolumes(state.snapshot.volumes);
    const total = unused.reduce((sum, v) => sum + (v.sizeBytes ?? 0), 0);
    body =
      unused.length === 0 ? (
        <p className="muted" data-testid="volumes-none-unused">
          Every volume is used by a Container.
        </p>
      ) : (
        <>
          <p className="muted" data-testid="volumes-unused-count">
            {unused.length} {unused.length === 1 ? 'volume' : 'volumes'} no Container uses
            {total > 0 ? `, ${formatBytes(total)} in all` : ''}. Deleting one cannot be undone.
          </p>
          <ul className="rows">
            {unused.map((volume) => (
              <li
                key={volume.name}
                className="row volume-row"
                data-testid="unused-volume"
                data-name={volume.name}
              >
                <div className="row__main">
                  <bdi className="row__name volume__name" data-testid="volume-name">
                    {volume.name}
                  </bdi>
                  <span className="muted">
                    {[
                      size(volume),
                      volume.project ? `Compose Project ${volume.project}` : null,
                      created(volume) ? `created ${created(volume)}` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </div>
                <div className="row__actions">
                  <button
                    type="button"
                    className="button button--danger button--small"
                    disabled={busy !== null}
                    onClick={() => setAsking(volume.name)}
                    data-testid="volume-delete"
                  >
                    {busy === volume.name ? 'Deleting…' : 'Delete'}
                    <span className="visually-hidden">: {volume.name}</span>
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      );
  }

  return (
    <Card title="Unused volumes" testId="unused-volumes">
      {message && (
        <p
          className={message.ok ? 'notice' : 'error'}
          role={message.ok ? 'status' : 'alert'}
          data-testid="volume-delete-result"
        >
          {message.text}
        </p>
      )}
      {body}
      {asking !== null && (
        <DeleteVolumeDialog
          name={asking}
          onConfirm={(confirmName) => void remove(asking, confirmName)}
          onCancel={() => setAsking(null)}
        />
      )}
    </Card>
  );
}
