/**
 * The hero demo (PRD WEB-5): the Lookout Containers page, live. Sparklines move; one
 * Container's CPU and memory climb until its health check fails and it is Flagged; the user
 * restarts it (Stop and Restart ask first, FR-24) and it comes back healthy.
 *
 * Plan, written before the code (the Stageshow skill's framing and motion references):
 *   Medium   an animated hero beside the page's copy, 720 × 440, looping while on screen;
 *            a 340-wide compact design for phones, cropped to three Containers.
 *   Layout   the dashboard in a browser window inset one gutter on a quiet well.
 *   Focal    photos-server-1's row.
 *   Beats    1 every sparkline ticks; photos-server-1's CPU and memory climb
 *            2 its health check fails: the row and the header turn Flagged
 *            3 the cursor clicks Restart; the dialog asks; the cursor confirms
 *            4 restarting (a gap in the samples), then starting, then healthy
 *            payoff: "Restarted photos-server-1." and 0 flagged, held while its
 *            spike scrolls out of the sparkline; the note fades, which is the seam.
 *   Still    under reduced motion, the Flagged frame: the moment Lookout exists for.
 *   Words    the real dashboard's: its header summary, badges, Flagged reason, Container
 *            Action words and confirmation text (apps/web/src/components/).
 *
 * The Sparkline and the number formats are the dashboard's own components, imported from
 * apps/web, so the demo draws exactly what the product draws.
 */
import { Sparkline } from '../../apps/web/src/components/Sparkline.tsx';
import { formatBytes, formatPercent } from '../../apps/web/src/format.ts';
import {
  CONTAINERS,
  SAMPLES,
  STORY_ID,
  TICK_MS,
  TIMELINE,
  series,
  status,
  summary,
  type DemoContainer,
  type Phase,
} from './hero-data.ts';
import { useState } from 'react';
import { Stage, Window, useReducedMotion, type Act, type Layout, type Theme } from './kit.ts';
import './hero.css';

/** The demo's text equivalent: the demo is one picture to assistive technology. */
export const HERO_LABEL =
  'An animated demo of the Lookout Containers page. CPU and memory sparklines update live; ' +
  'photos-server-1 becomes unhealthy and is Flagged; the user restarts it, confirms, and it ' +
  'comes back running and healthy, with nothing flagged.';

interface S {
  /** Samples taken since the start of the loop. */
  tick: number;
  /** photos-server-1's part in the story. */
  phase: Phase;
  /** The Restart confirmation is open. */
  dialog: boolean;
  /** "Restarted photos-server-1." shows. */
  done: boolean;
}

export const INITIAL: S = { tick: 0, phase: 'healthy', dialog: false, done: false };

/** The still frame, under reduced motion: photos-server-1 Flagged, its spike in view. */
export const POSTER: S = {
  tick: TIMELINE.unhealthy + 4,
  phase: 'unhealthy',
  dialog: false,
  done: false,
};

async function script(a: Act<S>): Promise<void> {
  let tick = 0;
  /** The next sample arrives, with whatever else changes at the same moment. */
  const sampleNow = async (patch: Partial<S> = {}) => {
    tick += 1;
    await a.set({ ...patch, tick });
  };
  /** Samples keep arriving until `last`. */
  const until = async (last: number) => {
    while (tick < last) {
      await a.wait(TICK_MS);
      await sampleNow();
    }
  };

  // 1. Everything is fine, then photos-server-1 starts to struggle.
  await until(TIMELINE.unhealthy - 1);
  await a.wait(TICK_MS);
  // 2. Its health check fails: Flagged, in the row and in the header.
  a.mark('flagged');
  await sampleNow({ phase: 'unhealthy' });
  await until(TIMELINE.restart - 4);

  // 3. Restart, which asks first.
  await a.move('restart');
  await sampleNow();
  await a.click();
  await sampleNow({ dialog: true });
  await a.wait(TICK_MS);
  await sampleNow();
  await a.move('confirm');
  await a.click();
  a.mark('restart');
  await sampleNow({ dialog: false, phase: 'restarting' });

  // 4. It restarts, runs, and its health check passes.
  await until(TIMELINE.running - 1);
  await a.wait(TICK_MS);
  await sampleNow({ phase: 'starting', done: true });
  await a.move('rest');
  await until(TIMELINE.healthy - 1);
  await a.wait(TICK_MS);
  a.mark('healthy');
  await sampleNow({ phase: 'healthy' });

  // Payoff, held while the spike scrolls out of view; the note fades before the seam.
  await until(TIMELINE.end - Math.round(SAMPLES / 3));
  await sampleNow({ done: false });
  await until(TIMELINE.end);
  // The last sample is the first of the next loop (hero-data.ts), so nothing moves.
  await a.snap({ tick: 0 });
}

const MIB = 1024 * 1024;

const flagReason = (phase: Phase) =>
  phase === 'unhealthy' ? 'Unhealthy' : phase === 'restarting' ? 'Restarting' : null;

function Spark({
  container,
  tick,
  metric,
  layout,
}: {
  container: DemoContainer;
  tick: number;
  metric: 'cpu' | 'memory';
  layout: Layout;
}) {
  const values = series(container, tick, metric);
  const now = values.at(-1) ?? null;
  const text =
    metric === 'cpu'
      ? `CPU ${formatPercent(now)}`
      : now === null
        ? 'Mem —'
        : `Mem ${formatBytes((now / 100) * container.memoryLimit * MIB)}${
            layout === 'wide' ? ` / ${formatBytes(container.memoryLimit * MIB)}` : ''
          }`;
  return (
    <span className={`lk-stat lk-stat--${metric}`}>
      <span className="lk-stat__text">{now === null && metric === 'cpu' ? 'CPU —' : text}</span>
      <Sparkline
        series={[{ values, tone: metric === 'cpu' ? 'primary' : 'secondary' }]}
        capacity={SAMPLES}
        max={100}
        label={metric === 'cpu' ? 'CPU' : 'Memory'}
      />
    </span>
  );
}

function Action({ s }: { s: S }) {
  if (s.phase === 'unhealthy') {
    return (
      <span className="lk-button lk-button--small lk-button--quiet" data-target="restart">
        Restart
      </span>
    );
  }
  if (s.phase === 'restarting') {
    return (
      <span className="lk-progress">
        <span className="lk-spinner" />
        Restarting…
      </span>
    );
  }
  return (
    <span className="lk-done" data-show={s.done || undefined}>
      Restarted
    </span>
  );
}

function Row({ container, s, layout }: { container: DemoContainer; s: S; layout: Layout }) {
  const story = container.id === STORY_ID;
  const { state, health } = status(container, s.phase);
  const reason = story ? flagReason(s.phase) : null;
  return (
    <div className="lk-row" data-flagged={reason !== null || undefined}>
      <span className="lk-row__main">
        <span className="lk-row__name">{container.name}</span>
        <span className="lk-row__image">{container.image}</span>
      </span>
      <span className="lk-row__status">
        <span className={`lk-badge lk-badge--${state}`}>{state}</span>
        {health && <span className={`lk-badge lk-badge--${health}`}>{health}</span>}
        {reason && (
          <span className="lk-flag">
            <span aria-hidden="true">⚑</span> Flagged: {reason}
          </span>
        )}
      </span>
      <Spark container={container} tick={s.tick} metric="cpu" layout={layout} />
      <Spark container={container} tick={s.tick} metric="memory" layout={layout} />
      <span className="lk-row__action">{story && <Action s={s} />}</span>
    </div>
  );
}

function Summary({ s }: { s: S }) {
  const figures = summary(s.tick, s.phase);
  return (
    <span className="lk-summary">
      <span className="lk-summary__group">
        Containers: {figures.running} running ·{' '}
        <span className="lk-summary__item" data-flagged={figures.flagged > 0 || undefined}>
          {figures.flagged} flagged
        </span>
      </span>
      <span className="lk-summary__group">
        <span className="lk-summary__item">CPU {formatPercent(figures.cpu)}</span>
        <span className="lk-summary__item">Mem {formatPercent(figures.memory)}</span>
        <span className="lk-summary__item">Disk {formatPercent(figures.disk)}</span>
      </span>
    </span>
  );
}

/** The Restart confirmation, worded as ConfirmActionDialog words it. */
function Dialog({ open }: { open: boolean }) {
  return (
    <span className="lk-backdrop" data-open={open || undefined}>
      <span className="lk-dialog">
        <span className="lk-dialog__title">Restart photos-server-1?</span>
        <span className="lk-dialog__text">
          The Container stops and starts again. Whatever it serves is briefly unavailable while it
          does.
        </span>
        <span className="lk-dialog__buttons">
          <span className="lk-button lk-button--quiet">Cancel</span>
          <span className="lk-button lk-button--danger" data-target="confirm">
            Restart
          </span>
        </span>
      </span>
    </span>
  );
}

/**
 * The demo, as one picture with its text equivalent, and a button that stops and restarts it
 * (WCAG 2.2.2: it moves for longer than five seconds). Stopped, it shows its still frame, as
 * it does under reduced motion, where the button is not needed.
 */
export function HeroDemo({ theme }: { theme: Theme }) {
  const [stopped, setStopped] = useState(false);
  const reduced = useReducedMotion();
  return (
    <div className="lk-demo">
      <div role="img" aria-label={HERO_LABEL}>
        <Scene theme={theme} stopped={stopped} />
      </div>
      {!reduced && (
        <button type="button" className="lk-demo__toggle" onClick={() => setStopped(!stopped)}>
          {stopped ? 'Play animation' : 'Pause animation'}
        </button>
      )}
    </div>
  );
}

function Scene({ theme, stopped }: { theme: Theme; stopped: boolean }) {
  return (
    <Stage<S>
      theme={theme}
      width={720}
      height={440}
      compact={{ below: 480, width: 340, height: 540 }}
      initial={INITIAL}
      poster={POSTER}
      script={stopped ? undefined : script}
      cursor={{ at: 'rest', ripple: true }}
      className="lk lk-hero"
    >
      {(s, _rect, layout) => {
        const shown =
          layout === 'wide' ? CONTAINERS : CONTAINERS.filter((c) => c.id !== 'notes-db');
        const projects = [...new Set(shown.map((c) => c.project))];
        return (
          <>
            <Window url="lookout.example.com" className="lk-window">
              <span className="lk-app">
                <span className="lk-header">
                  <img
                    className="lk-logo"
                    src={theme === 'dark' ? '/brand/logo-dark.svg' : '/brand/logo.svg'}
                    alt=""
                    width="87"
                    height="24"
                  />
                  {layout === 'wide' && (
                    <span className="lk-nav">
                      <span>Host</span>
                      <span data-current="">Containers</span>
                    </span>
                  )}
                  <Summary s={s} />
                </span>
                <span className="lk-main">
                  <span className="lk-title">Containers</span>
                  {projects.map((project) => (
                    <span key={project} className="lk-group">
                      <span className="lk-group__title">{project}</span>
                      <span className="lk-rows">
                        {shown
                          .filter((c) => c.project === project)
                          .map((c) => (
                            <Row key={c.id} container={c} s={s} layout={layout} />
                          ))}
                      </span>
                    </span>
                  ))}
                </span>
                <Dialog open={s.dialog} />
              </span>
            </Window>
            <span className="lk-rest" data-target="rest" />
          </>
        );
      }}
    </Stage>
  );
}
