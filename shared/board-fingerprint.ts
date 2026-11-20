/** Stable UTF-8 content encoding shared by native durable storage and the browser.
 * Pass document records only; transport clocks, schema metadata and presence are not content.
 */
export function canonicalBoardDocument(records: readonly unknown[]): string {
  if (!Array.isArray(records) || records.length > 2000)
    throw new Error('Invalid board record collection');
  const ids = new Set<string>();
  const ordered = records
    .map((record) => {
      if (
        !record ||
        typeof record !== 'object' ||
        Array.isArray(record) ||
        !Object.hasOwn(record, 'id') ||
        typeof (record as { id: unknown }).id !== 'string'
      ) {
        throw new Error('Board records require string IDs');
      }
      const id = (record as { id: string }).id;
      if (!id || ids.has(id)) throw new Error('Duplicate or empty board record ID');
      ids.add(id);
      return { id, record };
    })
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const ancestors = new Set<object>();
  let nodes = 0;
  function encode(value: unknown, depth: number): string {
    if (depth > 32 || ++nodes > 100000) throw new Error('Excessive board content complexity');
    if (value === null || value === undefined) return 'null';
    if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error('Non-finite board number');
      return JSON.stringify(value);
    }
    if (typeof value !== 'object') throw new Error('Non-JSON board value');
    if (ancestors.has(value)) throw new Error('Cyclic board content');
    ancestors.add(value);
    try {
      if (Array.isArray(value))
        return `[${Array.from(value, (item) => encode(item, depth + 1)).join(',')}]`;
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null)
        throw new Error('Non-JSON board object');
      const object = value as Record<string, unknown>;
      return `{${Object.keys(object)
        .sort()
        .filter((key) => object[key] !== undefined)
        .map((key) => `${JSON.stringify(key)}:${encode(object[key], depth + 1)}`)
        .join(',')}}`;
    } finally {
      ancestors.delete(value);
    }
  }
  return `[${ordered.map(({ record }) => encode(record, 0)).join(',')}]`;
}

export async function fingerprintBoardDocument(records: readonly unknown[]): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalBoardDocument(records));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface DurableBoardStatus {
  fingerprint: string;
  documentClock: number;
}
export interface BoardProofState {
  confirmed: boolean;
  dirty: boolean;
  checking: boolean;
  failed: boolean;
  documentClock: number | null;
  confirmedAt: number | null;
  fingerprint: string | null;
}
interface BoardProofOptions {
  readRecords: () => readonly unknown[];
  fetchStatus: (signal: AbortSignal) => Promise<DurableBoardStatus>;
  fingerprint?: (records: readonly unknown[]) => Promise<string>;
  debounceMs?: number;
  onChange?: (state: BoardProofState) => void;
}
export const INITIAL_BOARD_PROOF_STATE: BoardProofState = Object.freeze({
  confirmed: false,
  dirty: false,
  checking: false,
  failed: false,
  documentClock: null,
  confirmedAt: null,
  fingerprint: null,
});

/** Event-driven proof of actual durable content, independent of transport packet numbering. */
export class BoardContentProof {
  private state: BoardProofState = INITIAL_BOARD_PROOF_STATE;
  private revision = 0;
  private attempt = 0;
  private pending = 0;
  private connected = false;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: AbortController | null = null;
  constructor(private readonly options: BoardProofOptions) {}
  getState(): BoardProofState {
    return this.state;
  }
  private patch(patch: Partial<BoardProofState>) {
    if (this.disposed) return;
    const next = { ...this.state, ...patch };
    if (
      (Object.keys(next) as (keyof BoardProofState)[]).every((key) => next[key] === this.state[key])
    )
      return;
    this.state = next;
    this.options.onChange?.(next);
  }
  setConnected(connected: boolean): void {
    if (this.disposed || this.connected === connected) return;
    this.connected = connected;
    this.patch({ confirmed: false, checking: false, failed: false });
    this.requestCheck();
  }
  changed(source: 'user' | 'remote'): void {
    if (this.disposed) return;
    this.revision++;
    this.patch({
      confirmed: false,
      checking: false,
      failed: false,
      dirty: this.state.dirty || source === 'user',
    });
    this.requestCheck();
  }
  setTransportPending(count: number): void {
    if (this.disposed || count === this.pending) return;
    if (!Number.isSafeInteger(count) || count < 0)
      throw new Error('Invalid pending document count');
    this.pending = count;
    if (count) this.patch({ confirmed: false, checking: false, dirty: true });
    this.requestCheck();
  }
  requestCheck(): void {
    if (this.disposed) return;
    const attempt = ++this.attempt;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.inFlight?.abort();
    this.inFlight = null;
    this.patch({ checking: false, failed: false });
    if (!this.connected || this.pending) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.check(attempt);
    }, this.options.debounceMs ?? 850);
  }
  private async check(attempt: number) {
    const revision = this.revision;
    const controller = new AbortController();
    this.inFlight = controller;
    const current = () =>
      !this.disposed &&
      this.connected &&
      !this.pending &&
      this.attempt === attempt &&
      this.revision === revision &&
      !controller.signal.aborted;
    this.patch({ checking: true });
    try {
      const local = await (this.options.fingerprint ?? fingerprintBoardDocument)(
        this.options.readRecords(),
      );
      if (!current()) return;
      const durable = await this.options.fetchStatus(controller.signal);
      if (!current()) return;
      if (
        !durable ||
        !/^[0-9a-f]{64}$/.test(durable.fingerprint) ||
        !Number.isSafeInteger(durable.documentClock) ||
        durable.documentClock < 0
      ) {
        throw new Error('Invalid durable content proof');
      }
      if (local === durable.fingerprint) {
        this.patch({
          confirmed: true,
          dirty: false,
          checking: false,
          failed: false,
          documentClock: durable.documentClock,
          confirmedAt: Date.now(),
          fingerprint: durable.fingerprint,
        });
      } else this.patch({ confirmed: false, checking: false, failed: false });
    } catch {
      if (current()) this.patch({ confirmed: false, checking: false, failed: true });
    } finally {
      if (this.inFlight === controller) this.inFlight = null;
    }
  }
  dispose(): void {
    this.disposed = true;
    this.attempt++;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.inFlight?.abort();
    this.inFlight = null;
  }
}
