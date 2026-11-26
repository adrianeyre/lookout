/**
 * The pen-test release gate (docs/product-requirements-document/pen-testing.md#the-gate).
 * Run by the release workflow before semantic-release: it fails while the round's tracking
 * issue is open, or while any open issue carries `prd:pen-test` and `severity:critical` or
 * `severity:high`, and names what is blocking in the job summary.
 *
 *   GITHUB_TOKEN=… GITHUB_REPOSITORY=owner/name PEN_TEST_TRACKING_ISSUE=75 \
 *     node scripts/release-gate.ts
 *
 * It only reads issues, and uses nothing but Node: no dependency runs beside the token.
 */
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRD_LABEL = 'prd:pen-test';
export const BLOCKING_SEVERITIES = ['severity:critical', 'severity:high'] as const;

export interface GateIssue {
  number: number;
  title: string;
  state: 'open' | 'closed';
  labels: string[];
}

export interface Blocker {
  number: number;
  title: string;
  reason: string;
}

export interface GateVerdict {
  pass: boolean;
  blockers: Blocker[];
}

/** The gate's decision, from the tracking issue and every open `prd:pen-test` issue. */
export function gateVerdict(
  tracking: GateIssue | null,
  openPenTestIssues: GateIssue[],
): GateVerdict {
  const blockers: Blocker[] = [];
  if (tracking === null) {
    blockers.push({
      number: 0,
      title: 'No tracking issue',
      reason: 'the round’s tracking issue was not found, so the gate fails closed',
    });
  } else if (tracking.state === 'open') {
    blockers.push({
      number: tracking.number,
      title: tracking.title,
      reason: 'the pen-test round’s tracking issue is open',
    });
  }
  for (const issue of openPenTestIssues) {
    if (issue.state !== 'open' || !issue.labels.includes(PRD_LABEL)) continue;
    const severity = BLOCKING_SEVERITIES.find((label) => issue.labels.includes(label));
    if (severity)
      blockers.push({
        number: issue.number,
        title: issue.title,
        reason: `an open ${severity} finding`,
      });
  }
  return { pass: blockers.length === 0, blockers };
}

/** The job summary, in Markdown. */
export function summary(verdict: GateVerdict, repository: string): string {
  if (verdict.pass) {
    return '## Pen-test release gate: open\n\nThe round is closed and no high or critical finding is open.\n';
  }
  const rows = verdict.blockers.map((b) =>
    b.number > 0
      ? `- [#${b.number}](https://github.com/${repository}/issues/${b.number}) ${b.title}: ${b.reason}`
      : `- ${b.title}: ${b.reason}`,
  );
  return [
    '## Pen-test release gate: closed',
    '',
    `No release is cut while any of these is open ([the gate](https://github.com/${repository}/blob/main/docs/product-requirements-document/pen-testing.md#the-gate)). \`:edge\` still publishes.`,
    '',
    ...rows,
    '',
  ].join('\n');
}

interface ApiIssue {
  number: number;
  title: string;
  state: 'open' | 'closed';
  labels: (string | { name?: string })[];
  pull_request?: unknown;
}

const toGateIssue = (issue: ApiIssue): GateIssue => ({
  number: issue.number,
  title: issue.title,
  state: issue.state,
  labels: issue.labels.map((label) => (typeof label === 'string' ? label : (label.name ?? ''))),
});

async function github<T>(url: string, token: string): Promise<T | null> {
  const response = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${url}`);
  return (await response.json()) as T;
}

async function main(): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  const trackingNumber = Number(process.env.PEN_TEST_TRACKING_ISSUE);
  if (!token || !repository || !Number.isSafeInteger(trackingNumber) || trackingNumber <= 0) {
    throw new Error('GITHUB_TOKEN, GITHUB_REPOSITORY and PEN_TEST_TRACKING_ISSUE are required');
  }
  const api = `https://api.github.com/repos/${repository}`;
  const tracking = await github<ApiIssue>(`${api}/issues/${trackingNumber}`, token);

  const open: GateIssue[] = [];
  for (let page = 1; ; page++) {
    const query = new URLSearchParams({
      state: 'open',
      labels: PRD_LABEL,
      per_page: '100',
      page: String(page),
    });
    const issues = (await github<ApiIssue[]>(`${api}/issues?${query}`, token)) ?? [];
    open.push(...issues.filter((issue) => issue.pull_request === undefined).map(toGateIssue));
    if (issues.length < 100) break;
  }

  const verdict = gateVerdict(
    tracking && !tracking.pull_request ? toGateIssue(tracking) : null,
    open,
  );
  const text = summary(verdict, repository);
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  if (!verdict.pass) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
