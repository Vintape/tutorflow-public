import { AppError } from '../errors.js';

// Initial local-teaching budgets, above the measured 302-object B1 case.
// They are ceilings against abuse, not a verified deployment capacity claim.
export const BOARD_LIMITS = {
  records: 2000,
  documentBytes: 8 * 1024 * 1024,
  recordBytes: 256 * 1024,
  frameBytes: 512 * 1024,
  messageBytes: 1024 * 1024,
  depth: 32,
  nodes: 100000,
  chunks: 16,
  sockets: 8,
  rooms: 8,
  queue: 64,
  messagesPerSecond: 120,
  burst: 240,
  snapshots: 50,
  historyBytes: 64 * 1024 * 1024,
} as const;
export type BoardLimits = { [K in keyof typeof BOARD_LIMITS]: number };
type Limits = Partial<BoardLimits>;
function reject() {
  throw new AppError(413, 'Превышен безопасный размер или сложность доски', 'BOARD_LIMIT');
}
function inspect(value: unknown, limits: BoardLimits) {
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const entry = pending.pop()!;
    if (++nodes > limits.nodes || entry.depth > limits.depth) reject();
    const v = entry.value;
    // Presence carries epoch-millisecond timestamps (already > 1e12). Geometry
    // has its own schema bounds; the generic JSON gate must permit valid SDK time.
    if (typeof v === 'number' && (!Number.isFinite(v) || Math.abs(v) > Number.MAX_SAFE_INTEGER)) reject();
    if (!v || typeof v !== 'object') continue;
    for (const [key, child] of Object.entries(v)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) reject();
      // Presence is ephemeral and bypasses the persisted-record transaction guard.
      if (key === 'imageUrl' && child !== undefined && child !== null && child !== '' &&
        (typeof child !== 'string' || child.length > 240000 || !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]*={0,2}$/.test(child))) reject();
      pending.push({ value: child, depth: entry.depth + 1 });
    }
  }
}
export function checkBoardRecords(
  records: unknown[],
  validate: (record: unknown) => void,
  overrides: Limits = {},
) {
  const limits = { ...BOARD_LIMITS, ...overrides };
  if (records.length > limits.records) reject();
  let bytes = 0;
  for (const record of records) {
    inspect(record, limits);
    const size = Buffer.byteLength(JSON.stringify(record));
    bytes += size;
    if (size > limits.recordBytes || bytes > limits.documentBytes) reject();
    if (!record || typeof record !== 'object') reject();
    const r = record as { id?: unknown; typeName?: unknown; type?: unknown; props?: { src?: unknown } };
    if (typeof r.id !== 'string' || r.id.length > 256) reject();
    if (r.typeName === 'shape' && ['embed', 'video', 'bookmark'].includes(String(r.type))) reject();
    if (r.typeName === 'asset') {
      const src = r.props?.src;
      if (r.type !== 'image' || typeof src !== 'string' || !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]*={0,2}$/.test(src)) reject();
    }
    validate(record);
  }
}

/** Host cap precedes the SDK assembler, whose generic ceiling is much larger. */
export class BoardMessageGate {
  private readonly limits: BoardLimits;
  private parts: string[] = [];
  private remaining: number | null = null;
  private bytes = 0;
  constructor(overrides: Limits = {}) {
    this.limits = { ...BOARD_LIMITS, ...overrides };
  }
  accept(frame: string): string | null {
    if (Buffer.byteLength(frame) > this.limits.frameBytes) reject();
    const match = /^(\d{1,8})_([\s\S]*)$/.exec(frame);
    let message: string;
    if (match) {
      const remaining = Number(match[1]);
      if (remaining >= this.limits.chunks || (this.remaining !== null && remaining !== this.remaining - 1)) reject();
      this.bytes += Buffer.byteLength(match[2]);
      if (this.bytes > this.limits.messageBytes) reject();
      this.parts.push(match[2]);
      this.remaining = remaining;
      if (remaining) return null;
      message = this.parts.join('');
      this.parts = []; this.bytes = 0; this.remaining = null;
    } else {
      if (this.remaining !== null || Buffer.byteLength(frame) > this.limits.messageBytes) reject();
      message = frame;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(message); } catch { reject(); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) reject();
    inspect(parsed, this.limits);
    return message;
  }
}
