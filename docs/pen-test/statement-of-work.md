# E3: statement of work

> Private on the same terms as [the pen-testing PRD](../product-requirements-document/pen-testing.md) (see [README](README.md)).

## What closes the round

The round closes when every one of the PRD's [success criteria](../product-requirements-document/pen-testing.md#success-criteria) holds, the owner says so on the tracking issue (#75), and #75 is closed. Until #75 is closed [the release gate](../product-requirements-document/pen-testing.md#the-gate) holds every release.

The criteria are the PRD's, linked and not copied. How each is shown:

| Criterion | Shown by |
| --------- | -------- |
| 1 | the scope issues under `prd:pen-test`, listed on #75 |
| 2 | `pnpm pen-test:probe`'s isolation probe passing in both configurations, and `pnpm pen-test:down` reporting nothing left |
| 3 | each finding's creation date against its scope issue's findings note |
| 4 | a dated verdict on every H entry and "Good and to confirm" item in the PRD |
| 5 | the H1, H2 and H3 entries in the PRD |
| 6 | the gate job passing on `main`, and `site/privacy.test.ts` in `pnpm test` |
| 7 | `pnpm pen-test:down` at the end, and the note on #75 ([credentials-package.md](credentials-package.md#when-the-round-ends)) |

## What each scope issue hands back

Each scope issue (A1, W1, K1, P1, S1, R1, X1, I1, I2, V1, V2) hands back, before it closes:

1. **A findings note** at `docs/pen-test/findings/<ID>.md`: a verdict for every probe the issue lists (confirmed, refuted, or confirmed as a documented decision), each naming the configuration it ran against.
2. **Probe tests** in `apps/server/src/pen-test/probes/`: `*.test.ts` in `pnpm test`, `*.probe.ts` in `pnpm pen-test:probe` where they need the deployment. An open gap is an `it.fails` for the property that should hold, beside a `today_…` test pinning what happens now.
3. **One finding issue per confirmed weakness**, filed with the **Pen-test finding** template, one `severity:*` label and a pointer back to the scope issue, within one working day ([README](README.md#filing-a-finding)).
4. **Its H entries in the PRD amended** with their dated verdicts, naming the finding issues.

A scope issue probes and never fixes. X1b (#73) hands back the owner's figures in the PRD's limits table instead; V2 (#74) a read-only proof and its note.
