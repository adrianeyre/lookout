# Pen-test round: how findings are handled

> **Private.** Everything under `docs/pen-test/` is private on the same terms as [the pen-testing PRD](../product-requirements-document/pen-testing.md): it names exploit chains against a tool with root-equivalent Docker access. It must never be published, and this repository must not be made public while any `prd:pen-test` issue at `severity:high` or `severity:critical` is open. A test (`site/privacy.test.ts`, and `pnpm site:check` in CI) fails if anything from here reaches the Project Website.

This page is the working procedure for the round. The targets, the severity table and the rules behind them are in the PRD's [Findings workflow](../product-requirements-document/pen-testing.md#findings-workflow); this page links to them and copies none of them.

| Page                                                 | What it is                                                     |
| ---------------------------------------------------- | -------------------------------------------------------------- |
| [deployment.md](deployment.md)                       | E1: the pen-test deployment's runbook                          |
| [fixtures.md](fixtures.md)                           | E2: every fixture, its handle and what it is for               |
| [rules-of-engagement.md](rules-of-engagement.md)     | E3: who tests, when, against what, and how testing stops       |
| [statement-of-work.md](statement-of-work.md)         | E3: what closes the round, and what each scope issue hands back |
| [credentials-package.md](credentials-package.md)     | E4: what testers get, what they don't, and how it ends         |
| [findings/](findings/)                               | One findings note per scope issue                              |

## Readiness

The window opens when every row reads **ready** (see [the rules of engagement](rules-of-engagement.md#the-window)).

| Item | Issue | Ready | Notes |
| ---- | ----- | ----- | ----- |
| E1 the pen-test deployment | #56 | ready | `pnpm pen-test:up`, both configurations, isolation probed by `pnpm pen-test:probe` |
| E2 fixtures | #60 | ready | `pnpm pen-test:seed`; plan checked by `plan.test.ts` |
| E3 rules of engagement and statement of work | #61 | ready | the owner confirmed the window on 25 November 2026 ([rules of engagement](rules-of-engagement.md#amendments)) |
| E4 credentials package | #62 | ready | generated per deployment by `pnpm pen-test:up` |
| E5 findings workflow | #57 | ready | this page, the four `severity:*` labels and the **Pen-test finding** template |

## Filing a finding

1. A scope issue confirms a weakness with a probe (an `it.fails` stating what should hold, beside a `today_…` test pinning what happens now).
2. File it within one working day with **New issue → Pen-test finding**. The template adds `prd:pen-test` and asks, in order, for the scope issue, the H entry, the configuration, the rule broken, steps, observed, expected, impact and the test that would have caught it.
3. Add **exactly one** of `severity:critical`, `severity:high`, `severity:medium`, `severity:low`, by the PRD's [severity table](../product-requirements-document/pen-testing.md#findings-workflow).
4. Link it from the scope issue's findings note (`findings/<ID>.md`) and from the H entry in the PRD.

In an external round a critical finding is never filed as an issue first: see the PRD and [the rules of engagement](rules-of-engagement.md#reporting-a-critical-finding).

## Triage, the same working day

The owner, or an agent on the owner's behalf, triages each new finding on the working day it is filed:

1. **Reproduce** it from its steps, in the configuration it names.
2. **Confirm the severity** against the PRD's table; change the label if it is wrong, and say why in a comment.
3. **Check the shape:** every template heading filled, one `severity:*` label, `prd:pen-test`, a pointer to its scope issue.
4. **Link it back:** from the scope issue's findings note and the PRD's H entry.
5. Comment **"Triaged on _date_; target _date_"**, the target being the triage date plus the severity's working days from the PRD's table.
6. Add `needs-human` if it waits on the owner (a decision, a waiver, a credential).

## Waiving

`wontfix` goes on only after the owner has written, in the issue, what is accepted, why, and **the date it stops being true**. A waiver without an end date is not a waiver. Until then the finding stays open and counts against [the gate](../product-requirements-document/pen-testing.md#the-gate).

## Fixing

Each fix is its own pull request against its finding, labelled `ai-office:manual`: the owner merges every security fix; none merges itself. The fix turns the finding's probe: the `it.fails` becomes an `it`, the `today_…` test becomes a `(regression)` test. Tests are turned, never deleted. Closing keywords are written plainly (Fixes #123), never in bold or code.

A finding answered by a new or changed ADR stays open until the code matches the ADR, unless the ADR accepts the finding.

## Verifying

Fixed is not verified. After the fix merges, re-run the probe that found it (`pnpm test`, or `pnpm pen-test:up && pnpm pen-test:seed && pnpm pen-test:probe` in each configuration the finding names) and comment with the result. Only then is the finding closed, and its H entry in the PRD amended with the date.
