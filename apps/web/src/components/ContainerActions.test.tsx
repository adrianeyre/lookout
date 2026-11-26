import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { summary } from '../test-support.ts';
import { ContainerActions } from './ContainerActions.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(response: () => Response) {
  const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(() =>
    Promise.resolve(response()),
  );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

const ok = (action: string) =>
  new Response(JSON.stringify({ action, containerId: 'abc' }), { status: 200 });

describe('ContainerActions', () => {
  it('offers stop and restart for a running Container, start and remove for a stopped one', () => {
    const { rerender } = render(<ContainerActions container={summary({ id: 'abc' })} />);
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Stop', 'Restart']);
    rerender(<ContainerActions container={summary({ id: 'abc', state: 'exited' })} />);
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Start', 'Remove']);
  });

  it("disables every action on Lookout's own Container", () => {
    render(
      <ContainerActions container={summary({ id: 'abc', labels: { 'lookout.self': 'true' } })} />,
    );
    for (const button of screen.getAllByRole('button'))
      expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('self-note')).toBeTruthy();
  });

  it('asks before restarting, then shows progress and success', async () => {
    let resolve: (r: Response) => void = () => undefined;
    const fetch = vi.fn(() => new Promise<Response>((r) => (resolve = r)));
    vi.stubGlobal('fetch', fetch);
    render(<ContainerActions container={summary({ id: 'abc', name: 'web' })} />);
    await userEvent.click(screen.getByRole('button', { name: 'Restart' }));
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Restart web?' })).toBeTruthy();

    await userEvent.click(screen.getByTestId('confirm-action'));
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/containers/abc/actions/restart', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      credentials: 'same-origin',
    });
    expect(screen.getByTestId('action-status').textContent).toMatch(/Restarting web/);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Stop' }).disabled).toBe(true);

    resolve(ok('restart'));
    expect(await screen.findByText('Restarted web.')).toBeTruthy();
  });

  it('cancelling the dialog does nothing', async () => {
    const fetch = stubFetch(() => ok('stop'));
    render(<ContainerActions container={summary({ id: 'abc', name: 'web' })} />);
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows Docker's error when an action fails", async () => {
    stubFetch(
      () => new Response(JSON.stringify({ error: 'port is already allocated' }), { status: 502 }),
    );
    render(<ContainerActions container={summary({ id: 'abc', state: 'exited' })} />);
    await userEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Start failed: port is already allocated',
    );
  });

  it('only enables Remove once the exact name is typed, and sends it', async () => {
    const fetch = stubFetch(() => ok('remove'));
    const onRemoved = vi.fn();
    render(
      <ContainerActions
        container={summary({ id: 'abc', name: 'old-job', state: 'exited' })}
        onRemoved={onRemoved}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    const confirm = screen.getByTestId('confirm-action');
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByTestId('confirm-name'), 'old-jo');
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByTestId('confirm-name'), 'b');
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(confirm);
    expect(fetch.mock.calls[0]![1]).toMatchObject({ body: '{"confirmName":"old-job"}' });
    await vi.waitFor(() => expect(onRemoved).toHaveBeenCalledOnce());
  });
});
