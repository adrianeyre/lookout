---
status: accepted
---

# A single password, reachable only over LAN/VPN

[Lookout](https://github.com/adrianeyre/lookout) has one user and holds root-equivalent Docker access ([ADR-0003](./0003-deploy-as-container-with-host-access.md)). It must only be reachable over a LAN or VPN (for example Tailscale) and must never be exposed directly to the public internet. As defence in depth it also requires a single password, checked against an Argon2id hash in `LOOKOUT_PASSWORD_HASH`. A successful login issues a signed, `HttpOnly`, `SameSite=Strict` session cookie. Failed logins are rate-limited, and state-changing requests have their `Origin` checked.

## Considered Options

- **No app login, network access only:** simplest, but one exposed port or a compromised LAN device would give root on the Host.
- **Reverse proxy / SSO (Authelia, Cloudflare Access, Tailscale identity headers):** stronger, but adds infrastructure and couples Lookout to one specific proxy setup.
- **Multi-user with roles:** no second user exists. See the PRD non-goals.

## Consequences

There are no user records, so there is no database and nothing to migrate. Changing the password means changing the env var and recreating the Container. `LOOKOUT_BIND_ADDRESS` defaults to `127.0.0.1`, so a misconfigured install fails closed.

**Accepted:** one password and the network in front of Lookout are its whole defence. At start Lookout warns when `LOOKOUT_BIND_ADDRESS` is every interface or not a loopback, private, CGNAT, ULA or link-local address (pen-test #122), and refuses a session secret or password hash too weak to hold (#85, #124). This **stops being true** if Lookout gains a second user, is meant to be reached from the public internet, or a reverse proxy becomes a supported way to reach it; it is revisited by the next pen-test round, on 25 February 2027 at the latest.
