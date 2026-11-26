import { createContext, useContext, type ReactNode } from 'react';
import type { ThresholdLevel } from '@lookout/shared';

/** Set inside a Widget, whose bar already shows the title as the heading. */
export const InWidget = createContext(false);

export function Card({
  title,
  children,
  testId,
  actions,
  lead,
}: {
  title: string;
  children: ReactNode;
  testId?: string;
  /** Controls shown beside the title, such as a toggle. */
  actions?: ReactNode;
  /**
   * What the card opens with, such as its headline figures. In a Widget, whose bar has the
   * title, the actions sit beside it, so they don't take a row of their own.
   */
  lead?: ReactNode;
}) {
  const inWidget = useContext(InWidget);
  const id = `card-${title.toLowerCase().replace(/\W+/g, '-')}`;
  if (inWidget) {
    // The Widget's bar has the heading; its frame is the card's.
    return (
      <section className="card card--bare" aria-label={title} data-testid={testId}>
        {(lead || actions) && (
          <div className="card__head card__head--actions">
            {lead}
            {actions && <div className="card__actions">{actions}</div>}
          </div>
        )}
        {children}
      </section>
    );
  }
  return (
    <section className="card" aria-labelledby={id} data-testid={testId}>
      <div className="card__head">
        <h2 className="card__title" id={id}>
          {title}
        </h2>
        {actions}
      </div>
      {lead}
      {children}
    </section>
  );
}

/** A horizontal usage bar, amber or red past the thresholds (FR-12). */
export function Meter({
  percent,
  label,
  level = 'ok',
}: {
  percent: number | null;
  label: string;
  level?: ThresholdLevel;
}) {
  const value = percent ?? 0;
  return (
    <div
      className={`meter meter--${level}`}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value)}
      data-level={level}
    >
      <div className="meter__fill" style={{ inlineSize: `${Math.min(100, value)}%` }} />
    </div>
  );
}

const LEVEL_TEXT: Record<Exclude<ThresholdLevel, 'ok'>, { icon: string; text: string }> = {
  warn: { icon: '▲', text: 'Warning' },
  critical: { icon: '■', text: 'Critical' },
};

/**
 * Says a threshold has been crossed in words and a shape as well as colour, so it does not
 * rely on colour alone. Nothing is shown below the warning threshold.
 */
export function LevelBadge({ level, testId }: { level: ThresholdLevel; testId?: string }) {
  if (level === 'ok') return null;
  const { icon, text } = LEVEL_TEXT[level];
  return (
    <span className={`level level--${level}`} data-testid={testId} data-level={level}>
      <span className="level__icon" aria-hidden="true">
        {icon}
      </span>
      {text}
    </span>
  );
}

export function Stat({
  label,
  value,
  testId,
}: {
  label: string;
  value: ReactNode;
  testId?: string;
}) {
  return (
    <div className="stat">
      <dt>{label}</dt>
      <dd data-testid={testId}>{value}</dd>
    </div>
  );
}
