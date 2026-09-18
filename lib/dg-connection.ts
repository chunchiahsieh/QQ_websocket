export const DG_LINES = [
  { name: '預設線', url: 'wss://hwdata-new.taxyss.com' },
  { name: '台灣線', url: 'wss://appatw.kindlestone.com' },
] as const;

type AcceptedSocket = WebSocket & { accept(): void };

export async function connectDgLines(
  endpointFor: (base: string) => string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<AcceptedSocket> {
  const failures: string[] = [];
  for (const line of DG_LINES) {
    signal.throwIfAborted();
    let socket: AcceptedSocket | undefined;
    try {
      const endpoint = new URL(endpointFor(line.url));
      if (endpoint.protocol !== 'wss:' || endpoint.host !== new URL(line.url).host) throw new Error('Invalid endpoint');
      endpoint.protocol = 'https:';
      const response = await fetcher(endpoint, {
        headers: { Upgrade: 'websocket' },
        signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]),
      });
      socket = (response as Response & { webSocket?: AcceptedSocket }).webSocket;
      if (response.status !== 101 || !socket) {
        socket?.close();
        await response.body?.cancel();
        failures.push(`${line.name} HTTP ${response.status}`);
        continue;
      }
      socket.accept();
      if (signal.aborted) { socket.close(); signal.throwIfAborted(); }
      return socket;
    } catch {
      try { socket?.close(); } catch {}
      signal.throwIfAborted();
      failures.push(`${line.name} 連線失敗或逾時`);
    }
  }
  // Never expose signed URLs, tokens, or raw upstream exceptions.
  throw new Error(`DG 握手未成功：${failures.join('；')}。已使用此次登入的 DG Token，簽章與連線要求仍待核對。`);
}
