# E3: rules of engagement

> Private on the same terms as [the pen-testing PRD](../product-requirements-document/pen-testing.md) (see [README](README.md)). The brief is [the PRD](../product-requirements-document/pen-testing.md); these rules say how the round is run, and restate none of it.

**Version:** 2, 25 November 2026. **Status:** in force: the owner confirmed the window on 25 November 2026 (#61).

## Who tests, on whose authority

- **Authority:** the owner of Lookout and of this repository (Adi) authorises this round, against the scope below only.
- **Testers:** the owner, and agents working each scope issue through AI Office (`ai-office`, `role:coder`) on the owner's behalf. No one else tests in this round. See [Engagement shape](../product-requirements-document/pen-testing.md#engagement-shape).
- What testers are given, and what they are not, is in [credentials-package.md](credentials-package.md).

## The window

- **Opens** when E1-E5 all read **ready** in the [readiness table](README.md#readiness).
- **Closes** no later than **Friday 22 January 2027 at 17:00 UK time** (GMT).
- It is **extended only by a dated amendment to this page, made before it closes**. An amendment made after the window has closed does not reopen it; a new round does.

## In scope

- **The pen-test deployment** ([deployment.md](deployment.md)) and its hosts, by name: the Compose project `lookout-pen-test` on the Tester's machine, its `dind` and `relay` containers, `http://127.0.0.1:7780`, and every Container inside its throwaway daemon (`lookout`, `lookout-docker-proxy` and the fixtures in [fixtures.md](fixtures.md)), in both shipped configurations.
- **The source**, read-only: this repository at the round's commit.

## Out of scope

As the PRD lists under [Explicitly out of scope](../product-requirements-document/pen-testing.md#explicitly-out-of-scope). In short: anything outside the deployment, above all any real Host, LAN or tailnet and the Tester's machine beyond running the deployment; the platforms Lookout uses; denial of service and volume testing; social engineering and physical access.

## Conduct

- **No destructive testing outside the pen-test deployment.** Inside it, destroy what you like; `pnpm pen-test:seed` restores the fixtures and `pnpm pen-test:down && pnpm pen-test:up` the rest.
- **Reaching the Tester's machine or any real Docker** (a Container, file or socket that is not the deployment's) means: make **one read-only proof** (for example, list one directory or one Container name), **stop**, and report it to the owner at once as a critical finding. Do nothing more with that access.
- **At most 20 parallel requests** for any demonstration. A missing limit is shown by arithmetic, not by load.
- **Synthetic data only.** Use the fixtures. Never put a real secret, password or personal data into the deployment.
- **No request leaves the deployment.** Hosted Sites, SSRF targets and listeners are served inside it.
- Every probe names the configuration it ran against.

## Reporting a critical finding

- **In this round:** file it as an issue straight away with the **Pen-test finding** template and `severity:critical`, and tell the owner the same day (the repository is private and the data synthetic). See the PRD's [Findings workflow](../product-requirements-document/pen-testing.md#findings-workflow).
- **In an external round:** a critical finding never starts life as an issue. The tester tells the owner by the **out-of-band channel this page names for that round** (to be added by the amendment that opens it), with **no exploit detail in the first message**. If the owner does not acknowledge within **30 minutes**, testing pauses until they do.

## How the owner pauses testing

The owner pauses the round by any of:

- a comment on the tracking issue (#75) saying **"Testing paused"**, with the reason and date (every tester, agent or not, reads #75 before a probe run and stops on seeing it);
- removing the `ai-office` label from the open scope issues;
- `pnpm pen-test:down`, which ends the deployment and its credentials.

Testing resumes only on a comment on #75 saying **"Testing resumed"**, dated, by the owner.

## Amendments

| Date | Change | By |
| ---- | ------ | -- |
| 25 November 2026 | First version. | Agent, for the owner's confirmation on #61 |
| 25 November 2026 | The owner confirmed the window as written: it opens when E1-E5 read ready and closes no later than Friday 22 January 2027 at 17:00 UK time. E3 is ready. | Owner (Adi), recorded by an agent |
