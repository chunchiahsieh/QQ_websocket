import type { TableInfo } from '@/components/baccarat-table-card';
import { runtimeEnv } from '@/lib/runtime-env';

export type SharedMtMessage = {
  type: 'snapshot' | 'status';
  tables?: TableInfo[];
  status?: 'connecting' | 'connected' | 'offline';
  message?: string;
  receivedAt: number;
};

export const MT_IDLE_GRACE_MS = 15 * 60 * 1000;

type Subscriber = {
  send: (message: SharedMtMessage) => void;
  close: () => void;
};

type Feed = {
  latest?: SharedMtMessage;
  subscribers: Set<Subscriber>;
  collectorAt: number;
  viewers: Map<string, { connections: number; lastSeen: number }>;
  lastViewerAt: number;
};

const VIEWER_HEARTBEAT_TTL_MS = 45_000;

type SharedFeedGlobal = typeof globalThis & {
  __jshenMtSharedFeeds?: Map<string, Feed>;
};

const sharedGlobal = globalThis as SharedFeedGlobal;
const feeds = sharedGlobal.__jshenMtSharedFeeds ??= new Map<string, Feed>();

export function mtRoomForSession(_session: { accountId?: string; accountUsername?: string }) {
  // This deployment intentionally has one shared MT feed: A is the collector
  // account and every authenticated B/C viewer receives the same snapshot.
  // A future multi-tenant deployment can set a separate room name.
  return runtimeEnv('MT_SHARED_FEED_ROOM')?.trim() || 'global';
}

export function getMtFeed(room: string): Feed {
  let feed = feeds.get(room);
  if (!feed) {
    feed = { subscribers: new Set(), collectorAt: 0, viewers: new Map(), lastViewerAt: 0 };
    feeds.set(room, feed);
  }
  return feed;
}

export function publishMtFeed(room: string, message: SharedMtMessage) {
  const feed = getMtFeed(room);
  feed.latest = message;
  feed.collectorAt = message.receivedAt;
  for (const subscriber of [...feed.subscribers]) {
    try { subscriber.send(message); } catch { subscriber.close(); feed.subscribers.delete(subscriber); }
  }
}

function pruneViewers(feed: Feed) {
  const cutoff = Date.now() - VIEWER_HEARTBEAT_TTL_MS;
  for (const [viewerId, presence] of feed.viewers) {
    if (presence.lastSeen < cutoff && presence.connections <= 0) feed.viewers.delete(viewerId);
  }
}

function activeViewerCount(feed: Feed) {
  pruneViewers(feed);
  const cutoff = Date.now() - VIEWER_HEARTBEAT_TTL_MS;
  return [...feed.viewers.values()].filter(presence => presence.lastSeen >= cutoff).length;
}

export function touchMtViewer(room: string, viewerId: string, online: boolean) {
  const feed = getMtFeed(room);
  if (!online) {
    const presence = feed.viewers.get(viewerId);
    if (presence && presence.connections <= 0) feed.viewers.delete(viewerId);
    return;
  }
  const previous = feed.viewers.get(viewerId);
  feed.viewers.set(viewerId, { connections: previous?.connections ?? 0, lastSeen: Date.now() });
  feed.lastViewerAt = Date.now();
}

export function addMtSubscriber(room: string, subscriber: Subscriber, viewerId: string) {
  const feed = getMtFeed(room);
  feed.subscribers.add(subscriber);
  const previous = feed.viewers.get(viewerId);
  feed.viewers.set(viewerId, { connections: (previous?.connections ?? 0) + 1, lastSeen: Date.now() });
  feed.lastViewerAt = Date.now();
  if (feed.latest) {
    const fresh = feed.latest.type !== 'snapshot' || Date.now() - feed.latest.receivedAt <= 30_000;
    subscriber.send(fresh ? feed.latest : {
      type: 'status', status: 'offline', message: 'MT 即時資料暫停，等待恢復…', receivedAt: Date.now(),
    });
  }
  return () => {
    if (!feed.subscribers.delete(subscriber)) return;
    const presence = feed.viewers.get(viewerId);
    if (!presence || presence.connections <= 1) feed.viewers.delete(viewerId);
    else feed.viewers.set(viewerId, { ...presence, connections: presence.connections - 1 });
  };
}

export function mtFeedInfo(room: string) {
  const feed = getMtFeed(room);
  const idleForMs = feed.lastViewerAt ? Math.max(0, Date.now() - feed.lastViewerAt) : Number.POSITIVE_INFINITY;
  const viewerCount = activeViewerCount(feed);
  return {
    hasSnapshot: Boolean(feed.latest?.tables?.length),
    collectorAt: feed.collectorAt,
    subscribers: feed.subscribers.size,
    viewerCount,
    idleForMs,
    shouldCollect: viewerCount > 0 || idleForMs <= MT_IDLE_GRACE_MS,
  };
}
