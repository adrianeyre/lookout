// Used by the Dockerfile HEALTHCHECK. Probes /healthz on the configured bind address.
const address = process.env.LOOKOUT_BIND_ADDRESS?.trim() || '127.0.0.1';
const port = process.env.LOOKOUT_PORT?.trim() || '7777';
const host = address.includes(':') ? `[${address}]` : address;

try {
  const response = await fetch(`http://${host}:${port}/healthz`, {
    signal: AbortSignal.timeout(3000),
  });
  process.exit(response.ok ? 0 : 1);
} catch {
  process.exit(1);
}
