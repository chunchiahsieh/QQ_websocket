export type DgDealer = { id?: string; name?: string; online?: boolean };

export type DgTable = {
  tableId?: string;
  shoeId?: string;
  playId?: string;
  state?: number;
  countDown?: number;
  result?: string;
  poker?: string;
  roads?: string[];
  gameNo?: string;
  tableName?: string;
  totalAmount?: number;
  onlineCount?: number;
  dealer?: DgDealer;
};

export type DgLobbyPush = { tableId?: string; onlineCount?: number };
export type DgPublicBean = { cmd?: number; table?: DgTable[]; lobbyPush?: DgLobbyPush[]; list?: string[] };

class Reader {
  private offset = 0;
  private readonly data: Uint8Array;
  constructor(data: Uint8Array) { this.data = data; }
  get done() { return this.offset >= this.data.length; }
  uint() {
    let value = 0; let shift = 0;
    while (!this.done && shift < 35) {
      const next = this.data[this.offset++];
      value += (next & 0x7f) * 2 ** shift;
      if (!(next & 0x80)) return value;
      shift += 7;
    }
    throw new Error('Protobuf varint 無效');
  }
  field() { const tag = this.uint(); return { number: tag >>> 3, wire: tag & 7 }; }
  bytes() { const length = this.uint(); const start = this.offset; this.advance(length); return this.data.slice(start, start + length); }
  private advance(length: number) {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.data.length) throw new Error('Protobuf 長度超出封包範圍');
    this.offset += length;
  }
  string() { return new TextDecoder().decode(this.bytes()); }
  skip(wire: number) {
    if (wire === 0) { this.uint(); return; }
    if (wire === 1) { this.advance(8); return; }
    if (wire === 2) { const length = this.uint(); this.advance(length); return; }
    if (wire === 5) { this.advance(4); return; }
    throw new Error(`不支援的 Protobuf wire type: ${wire}`);
  }
}

const readDealer = (bytes: Uint8Array): DgDealer => {
  const reader = new Reader(bytes); const dealer: DgDealer = {};
  while (!reader.done) {
    const { number, wire } = reader.field();
    if (number === 1 && wire === 0) dealer.id = String(reader.uint());
    else if (number === 2 && wire === 2) dealer.name = reader.string();
    else if (number === 6 && wire === 0) dealer.online = Boolean(reader.uint());
    else reader.skip(wire);
  }
  return dealer;
};

const readTable = (bytes: Uint8Array): DgTable => {
  const reader = new Reader(bytes); const table: DgTable = {};
  while (!reader.done) {
    const { number, wire } = reader.field();
    if (wire === 0 && number === 1) table.tableId = String(reader.uint());
    else if (wire === 0 && number === 2) table.shoeId = String(reader.uint());
    else if (wire === 0 && number === 3) table.playId = String(reader.uint());
    else if (wire === 0 && number === 4) table.state = reader.uint();
    else if (wire === 0 && number === 5) table.countDown = reader.uint();
    else if (wire === 2 && number === 6) table.result = reader.string();
    else if (wire === 2 && number === 7) table.poker = reader.string();
    else if (wire === 2 && number === 10) (table.roads ??= []).push(reader.string());
    else if (wire === 2 && number === 11) table.gameNo = reader.string();
    else if (wire === 2 && number === 13) table.tableName = reader.string();
    else if (wire === 0 && number === 15) table.totalAmount = reader.uint();
    else if (wire === 0 && number === 16) table.onlineCount = reader.uint();
    else if (wire === 2 && number === 17) table.dealer = readDealer(reader.bytes());
    else reader.skip(wire);
  }
  return table;
};

const readLobbyPush = (bytes: Uint8Array): DgLobbyPush => {
  const reader = new Reader(bytes); const push: DgLobbyPush = {};
  while (!reader.done) {
    const { number, wire } = reader.field();
    if (number === 1 && wire === 0) push.tableId = String(reader.uint());
    else if (number === 2 && wire === 0) push.onlineCount = reader.uint();
    else reader.skip(wire);
  }
  return push;
};

export const decodeDgPublicBean = (data: ArrayBuffer): DgPublicBean => {
  const reader = new Reader(new Uint8Array(data)); const message: DgPublicBean = { table: [], lobbyPush: [], list: [] };
  while (!reader.done) {
    const { number, wire } = reader.field();
    if (number === 1 && wire === 0) message.cmd = reader.uint();
    else if (number === 12 && wire === 2) message.list?.push(reader.string());
    else if (number === 16 && wire === 2) message.lobbyPush?.push(readLobbyPush(reader.bytes()));
    else if (number === 17 && wire === 2) message.table?.push(readTable(reader.bytes()));
    else reader.skip(wire);
  }
  return message;
};

// The direct browser stream receives both full Table frames and count-only
// LobbyPush frames. Emit only known tables with their accumulated fields.
export class DgTableAccumulator {
  private readonly tables = new Map<string, DgTable>();
  private readonly lobbyCountTables = new Set<string>();
  private readonly pendingLobbyCounts = new Map<string, number>();

  accept(packet: DgPublicBean): DgTable[] {
    const changed = new Set<string>();
    for (const update of packet.table ?? []) {
      const id = update.tableId;
      if (!id) continue;
      const current = this.tables.get(id) ?? { tableId: id };
      if (update.shoeId !== undefined && current.shoeId !== undefined && update.shoeId !== current.shoeId) current.roads = [];
      const { onlineCount, ...fields } = update;
      Object.assign(current, fields);
      if (!this.lobbyCountTables.has(id) && onlineCount !== undefined) current.onlineCount = onlineCount;
      const pendingCount = this.pendingLobbyCounts.get(id);
      if (pendingCount !== undefined) {
        current.onlineCount = pendingCount;
        this.lobbyCountTables.add(id);
        this.pendingLobbyCounts.delete(id);
      }
      this.tables.set(id, current);
      changed.add(id);
    }
    if (packet.cmd === 207) {
      for (const push of packet.lobbyPush ?? []) {
        const id = push.tableId;
        if (!id || push.onlineCount === undefined) continue;
        const current = this.tables.get(id);
        if (!current) {
          if (!this.pendingLobbyCounts.has(id) && this.pendingLobbyCounts.size >= 300) {
            const oldestId = this.pendingLobbyCounts.keys().next().value;
            if (oldestId !== undefined) this.pendingLobbyCounts.delete(oldestId);
          }
          this.pendingLobbyCounts.set(id, push.onlineCount);
          continue;
        }
        const firstLobbyCount = !this.lobbyCountTables.has(id);
        this.lobbyCountTables.add(id);
        if (!firstLobbyCount && current.onlineCount === push.onlineCount) continue;
        current.onlineCount = push.onlineCount;
        changed.add(id);
      }
    }
    return [...changed].map(id => ({ ...this.tables.get(id)! }));
  }
}
