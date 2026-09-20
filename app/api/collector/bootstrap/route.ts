import { configuredCollectorCredentials, hasCollectorBootstrapKey } from '@/lib/collector-credentials';
import { collectorSessionCookie, readCollectorSession } from '@/lib/monitor-session';
import { isSameRequestOrigin } from '@/lib/request-origin';

// A collector is a separately authenticated machine role. Recovery requires
// either its encrypted collector session or the one-time fixed-browser key;
// normal viewer sessions can never obtain the platform credentials.
export async function POST(request: Request) {
  if (!isSameRequestOrigin(request)) return Response.json({ message: '來源不符。' }, { status: 403 });
  const existingSession = await readCollectorSession(request);
  const session = existingSession?.accountStamp === 'collector' ? existingSession : null;
  if (!session && !hasCollectorBootstrapKey(request.headers.get('X-Collector-Bootstrap'))) {
    return Response.json({ message: '採集端尚未完成初始登入。' }, { status: 401 });
  }
  const collectorCredentials = configuredCollectorCredentials();
  if (!collectorCredentials) {
    return Response.json({ message: '採集端帳號尚未設定。' }, { status: 503 });
  }
  return Response.json({
    account: { username: session?.accountUsername || collectorCredentials.username },
    collectorCredentials,
  }, { headers: {
    'Cache-Control': 'no-store',
    // Refresh a legacy one-hour collector cookie on its first resume. Viewer
    // sessions never reach this branch, so their one-hour lifetime is kept.
    'Set-Cookie': await collectorSessionCookie(request, {
      dgDirectLogin: session?.dgDirectLogin ?? true,
      accountId: session?.accountId || `collector-${collectorCredentials.username}`,
      accountUsername: session?.accountUsername || collectorCredentials.username,
      accountStamp: 'collector',
    }, 30 * 24 * 60 * 60),
  } });
}
