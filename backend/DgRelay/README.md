# C# DG browser relay

## Current path
The collector browser logs into TZ once, calls the official `DGLI` game-launch API,
and receives a short-lived DG URL such as
`https://new-dd-cn.ahsy114.com/ddnewpc/index.html?token=...`.
It sends that URL to `POST /api/dg/start`; C# launches a fresh headless Edge
context, observes the official WebSocket, decodes table Protobuf, and broadcasts
baccarat JSON. DG account credentials are never used by C#.
Viewer browsers receive a one-use ticket, open C# `/ws/dg`, and subscribe to the
same shared feed. No viewer opens a second DG session or sends credentials.
No betting actions or arbitrary upstream commands are exposed by the relay.

## Local startup
Web server secrets in ignored .env.local:
```
DG_RELAY_URL=http://127.0.0.1:5091
DG_RELAY_API_KEY=<random-secret-at-least-32-characters>
```
Start from this directory:
```powershell
./start-local.ps1
```
Restart the web dev service after environment changes, then log in again.
The script reads the relay key and does not print it. The collector browser
authenticates the shared TZ account and supplies DGLI. CAPTCHA/manual verification
is not bypassed; an incomplete official login is reported to the collector.
Microsoft Edge must be installed. For a configured Chromium installation, set
DG_BROWSER_CHANNEL=chromium and install the matching Playwright browser first.

## Lifecycle and security
- Only loopback :5091 is bound. Production needs TLS and a protected reverse proxy.
- C# start endpoint requires an internal shared key.
- Launch URLs are accepted only over HTTPS from the allow-listed official DG domains
  (`*.ahsy114.com`, `*.20299999.com`, `*.dggw.vip`, `*.ywjxi.com`) and must contain a token.
- Ticket expires in one minute and is consumed once; the URL is not returned to viewers.
- WebSocket Origin defaults to http://localhost:3000; DG_FRONTEND_ORIGIN overrides it.
- DG_RELAY_PUBLIC_URL configures the browser-facing relay URL when deployed.
- One shared browser context serves the collector URL. Tab switches only
  subscribe/unsubscribe; they never close this browser. Process shutdown closes it.
- The shared browser stays alive for 15 minutes after the last subscriber, then stops.
- An expired DGLI URL requires the collector browser to publish a new URL.
- Frontend tickets remain single-use and frontend connections expire after one hour.
- Healthy subscriptions immediately receive a full cached snapshot, preserving
  original countdown timestamps. Slow subscribers coalesce full snapshots safely.
- Health requires an open upstream socket, a valid packet within 60 seconds and
  table updates within three minutes; it does not rely on new game results alone.
- On stalled data, reload the game page once before rebuilding the browser.
  Rebuilds are serialized with 5/10/20/40/60-second backoff. Cached data is cleared
  and frontend shows reconnecting during recovery. An expired or rejected DGLI URL
  is reported to the collector instead of retrying with hidden credentials.
- /health includes feed health, subscriber count and browser generation, no secrets.
- Only incoming table fields are forwarded. Wallet, member and credential fields are discarded.
- Health exposes only status and active session count, no credentials.
- No credential logs, persistent browser profile, packet traces or screenshots are retained.
- The old direct ClientWebSocket/SSE endpoint remains for diagnostics; the DG frontend no longer uses it.

## Verified locally
See TEST-RESULTS.md. Real DG baccarat JSON arrived and updated 13 tables.
Changing transport avoids relying on our earlier direct handshake implementation;
it does not establish the root cause of that earlier HTTP 403.
MT and DG now share BaccaratTableCard, including photos, countdown and five roads.
DG history point scores are not inferred; unknown scores render as hollow circles.
DG video sources and shuffling-state mapping remain unverified, not synthesized from MT codes.
Cloud IP access, multi-user load and long-running reconnect behavior remain unverified.
