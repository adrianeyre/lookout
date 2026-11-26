const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence alongside the SameSite=Strict cookie (FR-34): a state-changing request must
 * carry an Origin header naming this same host. A missing Origin is refused too.
 */
export function isAllowedOrigin(
  method: string,
  origin: string | undefined,
  host: string | undefined,
): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return true;
  if (!origin || !host || origin === 'null') return false;
  try {
    return new URL(origin).host === host.toLowerCase();
  } catch {
    return false;
  }
}
