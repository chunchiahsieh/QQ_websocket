# MT / DG stability acceptance gate

This checklist is a release gate. A deployment cannot be promoted merely
because one platform happens to show tables in a browser.

## Service boundaries

- `jshen-card-prediction-demo`: UI, authenticated viewer requests, and the
  realtime hub contract. It never launches a platform browser.
- `jshen-dg-collector`: DG only. It cannot publish MT state or authenticate
  system users.
- MT browser collection remains a browser-side adapter. It publishes only
  validated MT snapshots to the hub and has no dependency on DG.
- `jshen-account-admin`: system user administration only. It is private and
  persists its state on its own disk.

## Required local / LAN test run

1. Start AccountAdmin with a temporary data directory and create a normal
   system user from `/admin`.
2. Verify successful login, a wrong password, disabled user, expired user,
   password reset, and logout. All responses must remain JSON for API calls.
3. Start only MT. Verify a non-empty snapshot, monotonically decreasing
   countdown, no card remount flicker, and preservation of the latest valid
   snapshot during reconnect.
4. Stop MT and verify DG remains connected with its existing tables.
5. Start only DG and repeat the same check in reverse: MT must not change.
6. Open two viewers. They must receive the same latest MT and DG snapshot;
   neither viewer may create another upstream connection.
7. Confirm the hub rejects an older sequence or older `receivedAt` value.

## Required Render test run

Use the same commit that passed the local run. Configure the two matching
`ACCOUNT_ADMIN_INTERNAL_KEY` / `ADMIN_INTERNAL_KEY` values and persist the
AccountAdmin disk before testing public login.

1. Log in on the Render URL and create, disable, then re-enable a test user
   from `/admin`.
2. Check MT and DG freshness independently: table count, last update time,
   collector health, reconnect count, and memory use.
3. Restart only the DG collector. MT's snapshot and countdown must stay
   visible and continue normally.
4. Restart only the MT collector/browser session. DG must stay unchanged.
5. Keep two viewers open for ten minutes. Both must show the same data and
   neither service may restart from memory pressure.

Record the commit SHA and results before promoting the deployment.
