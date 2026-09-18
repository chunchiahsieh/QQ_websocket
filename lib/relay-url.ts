/**
 * Resolve the browser-facing relay URL.
 *
 * In LAN development the relay listens on loopback from the server's point
 * of view, while the browser must connect to the hostname used to open the
 * frontend. Deriving the public URL from the request prevents DHCP changes
 * from leaving a stale 192.168.x.x address in the WebSocket response.
 */
export function browserRelayUrl(request: Request, configured: string | undefined, path: string) {
  const requestUrl = new URL(request.url);
  const configuredUrl = configured?.trim() ? new URL(configured) : undefined;
  const isLocalRelay = !configuredUrl
    || configuredUrl.hostname === 'localhost'
    || configuredUrl.hostname === '127.0.0.1'
    || configuredUrl.hostname === '::1';
  const base = isLocalRelay
    ? `${requestUrl.protocol}//${requestUrl.hostname}:5091`
    : configuredUrl!.toString();
  const url = new URL(path, base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}
