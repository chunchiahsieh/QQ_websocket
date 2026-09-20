import type { TableInfo } from '@/components/baccarat-table-card';

export type SharedDgMessage = {
  type: 'snapshot' | 'status';
  tables?: TableInfo[];
  status?: 'connecting' | 'connected' | 'offline';
  message?: string;
  receivedAt: number;
  collectorId?: string;
  sequence?: number;
};

type Feed = { latest?: SharedDgMessage; status?: SharedDgMessage };
type SharedFeedGlobal = typeof globalThis & { __jshenDgSharedFeeds?: Map<string, Feed> };

const feeds = (globalThis as SharedFeedGlobal).__jshenDgSharedFeeds ??= new Map<string, Feed>();

export const dgRoomForSession = (_session: { accountId?: string; accountUsername?: string }, configuredRoom?: string) => configuredRoom?.trim() || 'global';

const getFeed = (room: string) => {
  let feed = feeds.get(room);
  if (!feed) {
    feed = {};
    feeds.set(room, feed);
  }
  return feed;
};

export const publishDgFeed = (room: string, message: SharedDgMessage) => {
  const feed = getFeed(room);
  if (message.type === 'snapshot') {
    const previous = feed.latest;
    const sameCollector = Boolean(message.collectorId) && message.collectorId === previous?.collectorId;
    if (previous && ((sameCollector && (message.sequence ?? -1) >= 0 && (previous.sequence ?? -1) >= 0 && (message.sequence ?? -1) < (previous.sequence ?? -1))
      || (!sameCollector && message.receivedAt < previous.receivedAt))) return false;
    feed.latest = message;
    return true;
  }
  if (feed.status && message.receivedAt < feed.status.receivedAt) return false;
  feed.status = message;
  return true;
};

export const currentDgFeedMessage = (room: string): SharedDgMessage => {
  const feed = getFeed(room);
  if (feed.latest?.type === 'snapshot' && Date.now() - feed.latest.receivedAt <= 30_000) return feed.latest;
  return feed.status || { type: 'status', status: 'connecting', message: '等待 DG 即時資料…', receivedAt: Date.now() };
};
