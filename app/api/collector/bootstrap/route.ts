import { configuredCollectorCredentials } from '@/lib/collector-credentials';
import { readSession, sessionCookie } from '@/lib/monitor-session';
import { isSameRequestOrigin } from '@/lib/request-origin';

// A collector is a separately authenticated machine role. This endpoint is
// deliberately not a generic "auto login" API: only an encrypted session
// created by collector-mode login may resume the platform connection.
export async function POST(request: Request) {
  if (!isSameRequestOrigin(request)) return Response.json({ message: '來源不符。' }, { status: 403 });
  const session = await readSession(request);
  if (session?.accountStamp !== 'collector') {
    return Response.json({ message: '採集端尚未完成初始登入。' }, { status: 401 });
  }
  const collectorCredentials = configuredCollectorCredentials();
  if (!collectorCredentials) {
    return Response.json({ message: '採集端帳號尚未設定。' }, { status: 503 });
  }
  return Response.json({
    account: { username: session.accountUsername || collectorCredentials.username },
    collectorCredentials,
  }, { headers: {
    'Cache-Control': 'no-store',
    // Refresh a legacy one-hour collector cookie on its first resume. Viewer
    // sessions never reach this branch, so their one-hour lifetime is kept.
    'Set-Cookie': await sessionCookie(request, {
      dgDirectLogin: session.dgDirectLogin,
      accountId: session.accountId,
      accountUsername: session.accountUsername,
      accountStamp: session.accountStamp,
    }, 30 * 24 * 60 * 60),
  } });
}
