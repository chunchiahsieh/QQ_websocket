import type { TableInfo } from '@/components/baccarat-table-card';

export type SharedMtMessage = {
  type: 'snapshot' | 'status';
  tables?: TableInfo[];
  status?: 'connecting' | 'connected' | 'offline';
  message?: string;
  receivedAt: number;
  collectorId?: string;
  sequence?: number;
};

export const MT_IDLE_GRACE_MS = 15 * 60 * 1000;

type Subscriber = {
  send: (message: SharedMtMessage) => void;
  close: () => void;
};

type Feed = {
  // `latest` is intentionally snapshots only. A reconnect status must never
  // overwrite the last valid table data and make every viewer go blank.
  latest?: SharedMtMessage;
  status?: SharedMtMessage;
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

export function mtRoomForSession(_session: { accountId?: string; accountUsername?: string }, configuredRoom?: string) {
  // This deployment intentionally has one shared MT feed: A is the collector
  // account and every authenticated B/C viewer receives the same snapshot.
  // A future multi-tenant deployment can set a separate room name.
  return configuredRoom?.trim() || 'global';
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
  const previous = message.type === 'snapshot' ? feed.latest : feed.status;
  // Network requests can arrive out of order. Never let an old collector
  // snapshot replace a newer snapshot, otherwise cards and countdowns appear
  // to run backward after reconnect. Status updates are allowed through so a
  // genuine disconnect remains visible.
  if (message.type === 'snapshot' && previous?.type === 'snapshot') {
    const previousSequence = previous.sequence ?? -1;
    const nextSequence = message.sequence ?? -1;
    const sameCollector = Boolean(message.collectorId) && message.collectorId === previous.collectorId;
    if ((sameCollector && nextSequence >= 0 && previousSequence >= 0 && nextSequence < previousSequence)
      || (!sameCollector && message.receivedAt < previous.receivedAt)) return false;
  }
  if (message.type === 'snapshot') {
    feed.latest = message;
    feed.collectorAt = message.receivedAt;
  } else {
    // Do not replace a newer reconnect/connected status with an old network
    // callback from the previous socket generation.
    if (feed.status && message.receivedAt < feed.status.receivedAt) return false;
    feed.status = message;
  }
  for (const subscriber of feed.subscribers) {
    try { subscriber.send(message); } catch { subscriber.close(); feed.subscribers.delete(subscriber); }
  }
  return true;
}

export function currentMtFeedMessage(room: string): SharedMtMessage {
  const feed = getMtFeed(room);
  const latest = feed.latest;
  if (latest?.type === 'snapshot' && Date.now() - latest.receivedAt <= 30_000) return latest;
  return feed.status || {
    type: 'status', status: 'connecting', message: '等待 MT 即時資料…', receivedAt: Date.now(),
  };
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
  subscriber.send(currentMtFeedMessage(room));
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
