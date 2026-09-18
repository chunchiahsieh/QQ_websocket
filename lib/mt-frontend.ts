export type MtFrontendConnection = {
  sourceUrl: string;
  token: string;
  websocketUrl: string;
};

/**
 * Return a non-sensitive browser channel name for one MT session. The token
 * is only used as input to the hash and is never placed in the channel name.
 * Ignore optional launch-page parameters (for example `ti`) so copies of the
 * same token still discover one another across system tabs.
 */
export function mtSharedChannelKey(connection: MtFrontendConnection) {
  let hash = 2166136261;
  for (const character of `${connection.token}|${connection.websocketUrl}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `mt-feed-${(hash >>> 0).toString(16)}`;
}

/**
 * Convert the short-lived MT launch URL into the browser WebSocket endpoint.
 *
 * The URL supplied by MT is normally an https page such as
 * `https://gsa.ofalive99.net/?token=...&lang=zhtw`.  For local testing we keep
 * the token in the browser and connect directly to the official a1 game host.
 * A ws/wss URL is also accepted so a locally captured endpoint can be pasted
 * without changing it.
 */
export function parseMtLaunchUrl(raw: string): MtFrontendConnection {
  const value = raw.trim();
  if (!value) throw new Error('請貼上 MT 授權網址。');

  let source: URL;
  try {
    source = new URL(value);
  } catch {
    throw new Error('MT 授權網址格式不正確。');
  }

  if (!['https:', 'http:', 'wss:', 'ws:'].includes(source.protocol)) {
    throw new Error('MT 授權網址必須使用 http、https、ws 或 wss。');
  }

  const token = source.searchParams.get('token')?.trim() ?? '';
  if (!token) throw new Error('網址中找不到 token。');

  const isWebSocket = source.protocol === 'ws:' || source.protocol === 'wss:';
  const websocket = isWebSocket
    ? new URL(source.toString())
    : new URL('/game/ws', source.origin);

  // The official MT page opens a1.<platform>/game/ws and authenticates by
  // sending a JSON message after open. The launch token is intentionally not
  // put in the WS query string; it is sent once in the browser's auth frame.
  if (!isWebSocket) {
    const host = source.hostname.replace(/^gsa\./i, 'a1.');
    websocket.hostname = host;
    websocket.protocol = source.protocol === 'http:' ? 'ws:' : 'wss:';
  }
  websocket.search = '';

  return {
    sourceUrl: source.toString(),
    token,
    websocketUrl: websocket.toString(),
  };
}

export function mtAuthenticateMessage(token: string) {
  return JSON.stringify({
    method: 'POST',
    action: { name: '/api/v1/authenticate' },
    body: { type: 3, token },
  });
}

/** Request the authenticated member context used by the official MT client. */
export function mtMemberMessage(lang = 'zhtw') {
  return JSON.stringify({
    method: 'POST',
    action: { name: '/api/v1/member/me', lang },
  });
}

/** Request the current baccarat table snapshot used by the official MT client. */
export function mtTablesMessage() {
  return JSON.stringify({
    method: 'GET',
    action: {
      name: '/api/v1/gametype/*/game/*/room/*/tables',
      data: { gametype_id: 3, game_id: 1, room_id: 1 },
    },
  });
}

/** Subscribe one authenticated MT socket to the live events for all lobby tables. */
export function mtMultipleJoinMessage(tableIds: string[]) {
  return JSON.stringify({
    method: 'GET',
    action: {
      name: '/api/v1/gametype/*/game/*/room/*/mulitple_join',
      data: { table_id: tableIds.join(',') },
    },
  });
}

/** Keep the browser-side MT session alive while the page is open. */
export function mtPingMessage() {
  return JSON.stringify({
    method: 'POST',
    action: { name: '/api/v1/ping' },
  });
}

export async function readMtWebSocketMessage(data: unknown): Promise<string | null> {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  if (typeof Blob !== 'undefined' && data instanceof Blob) return data.text();
  return null;
}
