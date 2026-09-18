# Local browser relay verification

## Persistent upstream — 2026-09-18

- `node tests/dg-persistent-live.mjs`: first 13 tables in 11311 ms; unsubscribe,
  then subscribe again: 13 tables in 11 ms, generation stayed 1, idle browser count 1.
- `dotnet run --project backend/DgRelay.Tests/DgRelay.Tests.csproj`: persistence,
  20 concurrent subscribers using one capture, full cache snapshots, original
  countdown timestamps, disconnected-cache gating, shutdown, login retry blocking,
  and simulated capture-failure/backoff/recovery all passed.
- C# build and TypeScript type checks passed. Browser crash/page-reload recovery
  has not been fault-injected against the live DG service; long-duration stability
  remains unverified. Earlier tab-switch shutdown observations below are historical.

## dg18.cc dedicated account flow — 2026-09-18

- C# login through dg18.cc normal form and enter-game button succeeded.
- Internal start returned 200; first decoded snapshot contained 13 baccarat tables,
  followed by a one-table live update. No TZ DG authorization or manual token used.
- C# build and TypeScript type check passed.
- Previous launch-URL flow observations below are historical.

2026-09-18, localhost:3000 + loopback C# service :5091, Microsoft Edge headless.

Verified through the right-hand browser UI:

- Login returned independent MT and DG authorization.
- MT page showed live tables before selecting DG.
- DG tab launched one isolated browser session (health activeSessions=1).
- DG official launch entry redirected normally; no manual betting/game commands sent.
- Incoming official Protobuf packets decoded in C# and were forwarded as JSON on our own WebSocket.
- Frontend displayed 13 baccarat tables: RB01–RB05, S01/S02/S03/S05/S06/S07/S09/S10.
- Live updates observed: RB02 round 55 → 56, roads 54 → 55; RB03 round 5 → 6, roads 4 → 5.
- Switching back to MT released the browser session (health activeSessions=0).

No password, launch token, API secret or raw account packet is included in this record.
The earlier direct-WebSocket 403 path is not used by this browser transport.

Subsequent shared-card verification: DG displays the same BaccaratTableCard as MT,
with dealer photos, a ticking countdown based on server receive timestamps,
chronological bead road, big road and three derived roads. Unknown point scores
remain blank; video toggle stays disabled without a verified stream source.
Cloud deployment and long-duration/multi-user stability have not been validated.
