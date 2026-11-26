import { describe, expect, it } from 'vitest';
import { gateVerdict, summary, type GateIssue } from './release-gate.ts';

const tracking = (state: 'open' | 'closed'): GateIssue => ({
  number: 75,
  title: 'Pen test: tracking issue for the first round',
  state,
  labels: ['prd:pen-test'],
});
const finding = (number: number, severity: string, labels = ['prd:pen-test']): GateIssue => ({
  number,
  title: `Finding ${number}`,
  state: 'open',
  labels: [...labels, severity],
});

describe('the pen-test release gate', () => {
  it('fails while the tracking issue is open, and names it', () => {
    const verdict = gateVerdict(tracking('open'), []);
    expect(verdict.pass).toBe(false);
    expect(verdict.blockers.map((b) => b.number)).toEqual([75]);
    expect(verdict.blockers[0]?.reason).toContain('tracking issue');
    expect(summary(verdict, 'owner/repo')).toContain(
      '[#75](https://github.com/owner/repo/issues/75)',
    );
  });

  it('fails while a high finding is open', () => {
    const verdict = gateVerdict(tracking('closed'), [finding(90, 'severity:high')]);
    expect(verdict.pass).toBe(false);
    expect(verdict.blockers.map((b) => b.number)).toEqual([90]);
  });

  it('fails while a critical finding is open', () => {
    const verdict = gateVerdict(tracking('closed'), [finding(91, 'severity:critical')]);
    expect(verdict.pass).toBe(false);
    expect(verdict.blockers[0]?.reason).toContain('severity:critical');
  });

  it('passes with only medium and low findings open', () => {
    const verdict = gateVerdict(tracking('closed'), [
      finding(92, 'severity:medium'),
      finding(93, 'severity:low'),
    ]);
    expect(verdict).toEqual({ pass: true, blockers: [] });
    expect(summary(verdict, 'owner/repo')).toContain('open');
  });

  it('passes with nothing open', () => {
    expect(gateVerdict(tracking('closed'), [])).toEqual({ pass: true, blockers: [] });
  });

  it('names every blocker at once', () => {
    const verdict = gateVerdict(tracking('open'), [
      finding(90, 'severity:high'),
      finding(91, 'severity:critical'),
      finding(92, 'severity:medium'),
    ]);
    expect(verdict.blockers.map((b) => b.number)).toEqual([75, 90, 91]);
  });

  it('ignores a high issue that is not under prd:pen-test, and closed ones', () => {
    const other = finding(94, 'severity:high', ['bug']);
    const closed = { ...finding(95, 'severity:high'), state: 'closed' as const };
    expect(gateVerdict(tracking('closed'), [other, closed]).pass).toBe(true);
  });

  it('fails closed when the tracking issue cannot be found', () => {
    expect(gateVerdict(null, []).pass).toBe(false);
  });
});
