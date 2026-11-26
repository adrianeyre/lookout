# E1: the pen-test deployment

> Private on the same terms as [the pen-testing PRD](../product-requirements-document/pen-testing.md) (see [README](README.md)).

**The pen-test deployment never points at a real Docker or a real Host.** Lookout in it talks only to a throwaway Docker daemon (`docker:dind`) that lives and dies with the deployment, and reads a fixture Host root copied from `e2e/fixtures/host`. If anything ever makes Lookout in the deployment list the Tester's machine's Containers, or read the Tester's machine's files, stop and report it as a finding.

## Shape

```
Tester's machine (its Docker builds the Images and runs this project only)
└── Compose project "lookout-pen-test"  (pen-test/compose.yaml)
    ├── relay  ── publishes 127.0.0.1:7780 ─▶ Lookout; drops every new outbound connection
    └── dind   ── the round's Host: a throwaway daemon on an internal network, no way out
        ├── lookout                (shipped compose.yaml, network_mode: host = dind's namespace)
        ├── lookout-docker-proxy   (shipped compose.socket-proxy.yaml, socket-proxy only)
        └── the fixtures           (pnpm pen-test:seed, see fixtures.md)
```

- **Its own Compose project**, `lookout-pen-test`, never `lookout`.
- **Lookout runs inside the throwaway daemon** with the shipped `compose.yaml`, and `compose.socket-proxy.yaml` in that configuration, unchanged except for `pen-test/lookout.override.yaml`: the Image built from the round's commit (`lookout:pen-test`) and the fixture Host root at `/host`. `network_mode: host`, the socket mount, `lookout.self`, the proxy and its allowlist are exactly as shipped, so in the deployment "the Host" is the dind container.
- **No way out.** dind sits only on `inner`, an `internal: true` network with no gateway; Containers inside it route through dind and so have none either. A published port needs a network that is not internal, so one relay (socat) sits on both; at start it sets an iptables policy that drops every new outbound connection except to `inner`, then relays as `nobody` with no capabilities left to change it. The Hosted Sites the fixtures need are served inside the daemon.
- **Published on `127.0.0.1` only**: the relay's `127.0.0.1:7780` (`PEN_TEST_PORT` to change it).
- dind cannot pull, so `pnpm pen-test:up` builds and pulls on the Tester's machine (Lookout's Image from the working tree, the fixture Image, the socket proxy by its pinned digest) and loads them into the daemon.

## Standing it up

```sh
pnpm pen-test:up                 # the default configuration (compose.yaml)
pnpm pen-test:up socket-proxy    # compose.yaml + compose.socket-proxy.yaml
pnpm pen-test:seed               # load the fixtures (again, after a destructive probe)
pnpm pen-test:probe              # the probes that need the deployment, against what is running
```

`pnpm pen-test:up` from a clean checkout builds the Images, starts the project, generates the round's credentials (see [credentials-package.md](credentials-package.md)) and starts Lookout. Running it again with the other configuration switches Lookout in place, keeping the credentials; run `pnpm pen-test:seed` after.

The URL is `http://127.0.0.1:7780`; the testers' password is in `pen-test/.state/credentials.json` (untracked).

## Which configuration is running

```sh
pnpm pen-test:status
```

prints the configuration, the URL and every Container in the throwaway daemon. Every probe names the configuration it ran in (the probes read it from the deployment), and a full round runs `pnpm pen-test:probe` once in each.

## Tearing it down

```sh
pnpm pen-test:down
```

removes the project's containers, networks and **volumes** (the daemon's whole state, the deployment's `.env` with the session secret, the fixture Host root), the round's local Images and `pen-test/.state` (the credentials). It then checks that no container, network or volume labelled with the project is left, and fails naming any that is.

## What it proves, and how

`apps/server/src/pen-test/probes/e1-isolation.probe.ts` (in `pnpm pen-test:probe`):

- only `127.0.0.1` ports are published, and only by the relay;
- dind and the relay cannot reach the internet;
- no Container inside the daemon can (each running Container's namespace, and the daemon's own, which Lookout and the proxy share, runs the fixture Image's `egress-check`: TCP to public addresses and public DNS);
- Lookout's Containers page lists exactly the throwaway daemon's Containers, and none of the Tester's machine's;
- Host Metrics come from the fixture Host root.

## What dind can't show

The deployment's "Host" is a privileged container, not a Linux machine. It cannot show:

- escapes through `network_mode: host` into a real Host's network namespace (other services on the Host's loopback, the LAN, a tailnet);
- what the real `/` mount exposes (`/host` here is the fixture Host root, so H14's symlink reads and what Lookout's user may read are not the real thing);
- the real kernel, AppArmor/SELinux and cgroup limits a Host applies.

Those are **V2's** (#74): a one-off check on a disposable Linux VM, with a read-only proof, then stop.
