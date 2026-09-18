/**
 * Validate browser POST origins when the app is behind a reverse proxy.
 *
 * Render (and similar hosts) can expose an internal request URL to the
 * application while preserving the public Host/X-Forwarded-* headers.  The
 * browser Origin must be compared with both forms; otherwise a valid request
 * is incorrectly rejected as「來源不符」.
 */
export function isSameRequestOrigin(request: Request) {
  const origin = request.headers.get('origin')?.trim();
  if (!origin) return true;

  const allowed = new Set<string>();
  try { allowed.add(new URL(request.url).origin); } catch { /* invalid URL is rejected below */ }

  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
    || request.headers.get('host')?.trim();
  if (forwardedHost) {
    const protocol = forwardedProto || (new URL(request.url).protocol.replace(':', ''));
    if (protocol) allowed.add(`${protocol}://${forwardedHost}`.replace(/\/$/, ''));
  }

  return allowed.has(origin.replace(/\/$/, ''));
}
