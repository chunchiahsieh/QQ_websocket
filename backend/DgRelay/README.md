# C# DG browser relay

## Current path
Browser DG tab → POST /api/dg/start (web app validates login) → C# one-use ticket.
Browser then opens C# /ws/dg and sends the ticket as its first message.
C# launches a fresh headless Edge context, signs in at https://dg18.cc/ using
DG_BACKEND_USERNAME / DG_BACKEND_PASSWORD and clicks the normal enter-game button,
observes received WebSocket frames, decodes table Protobuf, and sends baccarat JSON.
The official DG application itself handles authentication, subscriptions and heartbeat.
No betting actions or arbitrary upstream commands are exposed by the relay.

## Local startup
Web server secrets in ignored .env.local:
```
DG_RELAY_URL=http://127.0.0.1:5091
DG_RELAY_API_KEY=<random-secret-at-least-32-characters>
DG_BACKEND_USERNAME=<dedicated-DG-account>
DG_BACKEND_PASSWORD=<dedicated-DG-password>
```
Start from this directory:
```powershell
./start-local.ps1
```
Restart the web dev service after environment changes, then log in again.
The script reads the relay key and dedicated DG credentials; it does not print them.
The web login still authenticates the monitor user through TZ; DG credentials are
used only by C# at dg18.cc, never sent to TZ or returned to the frontend.
Actual DG login starts on the first DG subscription and stays alive afterward. CAPTCHA/manual verification
is not bypassed; incomplete login is reported without guessing a password failure.
Microsoft Edge must be installed. For a configured Chromium installation, set
DG_BROWSER_CHANNEL=chromium and install the matching Playwright browser first.

## Lifecycle and security
- Only loopback :5091 is bound. Production needs TLS and a protected reverse proxy.
- C# start endpoint requires an internal shared key.
- The entry is fixed to https://dg18.cc/; clients cannot supply arbitrary launch URLs.
- Ticket expires in one minute and is consumed once; DG token is not sent to frontend JS.
- WebSocket Origin defaults to http://localhost:3000; DG_FRONTEND_ORIGIN overrides it.
- DG_RELAY_PUBLIC_URL configures the browser-facing relay URL when deployed.
- One shared browser context serves the fixed backend account. Tab switches only
  subscribe/unsubscribe; they never close this browser. Process shutdown closes it.
- Frontend tickets remain single-use and frontend connections expire after one hour.
- Healthy subscriptions immediately receive a full cached snapshot, preserving
  original countdown timestamps. Slow subscribers coalesce full snapshots safely.
- Health requires an open upstream socket, a valid packet within 60 seconds and
  table updates within three minutes; it does not rely on new game results alone.
- On stalled data, reload the game page once before rebuilding the browser.
  Rebuilds are serialized with 5/10/20/40/60-second backoff. Cached data is cleared
  and frontend shows reconnecting during recovery. Failed normal login stops retries
  until credentials/manual verification are addressed and the service restarts.
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
