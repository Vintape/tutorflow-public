import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BoardContentProof,
  canonicalBoardDocument,
  fingerprintBoardDocument,
  type DurableBoardStatus,
} from '../shared/board-fingerprint';

describe('canonical durable board content', () => {
  it('sorts records and every object key without changing ordered arrays', () => {
    const records = [
      { id: 'shape:b', props: { y: 2, x: [3, 1] } },
      { props: { source: 'Я' }, id: 'shape:a' },
    ];
    expect(canonicalBoardDocument(records)).toBe(
      '[{"id":"shape:a","props":{"source":"Я"}},{"id":"shape:b","props":{"x":[3,1],"y":2}}]',
    );
    expect(canonicalBoardDocument([...records].reverse())).toBe(canonicalBoardDocument(records));
    expect(records[0].id).toBe('shape:b');
  });
  it('matches JSON persistence semantics for optional object properties and arrays', () => {
    expect(
      canonicalBoardDocument([{ id: 'shape:a', optional: undefined, points: [undefined, null] }]),
    ).toBe(canonicalBoardDocument([{ id: 'shape:a', points: [null, null] }]));
  });
  it.each([
    { records: [{ id: 'a' }, { id: 'a' }] },
    { records: [{ id: 'a', n: Infinity }] },
    { records: [{ id: 'a', n: NaN }] },
    { records: [{ missing: 'id' }] },
    { records: [{ id: 'a', n: BigInt(1) }] },
  ])('rejects ambiguous or non-JSON content', ({ records }) => {
    expect(() => canonicalBoardDocument(records)).toThrow();
  });
  it('rejects cycles and excessive nesting before hashing', () => {
    const cyclic: { id: string; self?: unknown } = { id: 'a' };
    cyclic.self = cyclic;
    expect(() => canonicalBoardDocument([cyclic])).toThrow();
    let nested: unknown = 1;
    for (let i = 0; i < 40; i++) nested = { nested };
    expect(() => canonicalBoardDocument([{ id: 'a', nested }])).toThrow();
  });
  it('produces the same SHA-256 in browser WebCrypto and Node UTF-8 hashing', async () => {
    const records = [{ id: 'shape:formula', props: { source: 'α = 2' } }];
    const expected = createHash('sha256')
      .update(canonicalBoardDocument(records), 'utf8')
      .digest('hex');
    expect(await fingerprintBoardDocument(records)).toBe(expected);
    expect(
      await fingerprintBoardDocument([{ id: 'shape:formula', props: { source: 'α = 3' } }]),
    ).not.toBe(expected);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function nodeFingerprint(records: readonly unknown[]) {
  return createHash('sha256').update(canonicalBoardDocument(records), 'utf8').digest('hex');
}
describe('quiet, race-safe durable content proof', () => {
  const proofs: BoardContentProof[] = [];
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    proofs.splice(0).forEach((proof) => proof.dispose());
    vi.useRealTimers();
  });
  function setup(fetchStatus?: () => Promise<DurableBoardStatus>) {
    let local = [{ id: 'shape:a', x: 0 }],
      durable = [{ id: 'shape:a', x: 0 }];
    const fetch = vi.fn(
      fetchStatus ?? (async () => ({ fingerprint: nodeFingerprint(durable), documentClock: 7 })),
    );
    const proof = new BoardContentProof({
      readRecords: () => local,
      fetchStatus: fetch,
      fingerprint: async (records) => nodeFingerprint(records),
      debounceMs: 800,
    });
    proofs.push(proof);
    return {
      proof,
      fetch,
      local: (x: number) => {
        local = [{ id: 'shape:a', x }];
      },
      durable: (x: number) => {
        durable = [{ id: 'shape:a', x }];
      },
    };
  }
  it('requires an actual quiet content comparison, including on initial connection', async () => {
    const { proof, fetch } = setup();
    proof.setConnected(true);
    expect(proof.getState()).toMatchObject({ confirmed: false, dirty: false });
    await vi.advanceTimersByTimeAsync(799);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(proof.getState()).toMatchObject({ confirmed: true, dirty: false, documentClock: 7 });
  });
  it('does not let an older packet receipt acknowledge a newer unsent local change', async () => {
    const { proof, local, durable } = setup();
    proof.setConnected(true);
    await vi.advanceTimersByTimeAsync(800);
    local(1);
    proof.changed('user');
    proof.setTransportPending(1);
    local(2);
    proof.changed('user');
    durable(1);
    proof.setTransportPending(0);
    proof.requestCheck();
    await vi.advanceTimersByTimeAsync(800);
    expect(proof.getState()).toMatchObject({ confirmed: false, dirty: true });
    durable(2);
    proof.requestCheck();
    await vi.advanceTimersByTimeAsync(800);
    expect(proof.getState()).toMatchObject({ confirmed: true, dirty: false });
  });
  it('clears edit-then-undo by exact content even when no document push is emitted', async () => {
    const { proof, local, fetch } = setup();
    proof.setConnected(true);
    await vi.advanceTimersByTimeAsync(800);
    local(1);
    proof.changed('user');
    local(0);
    proof.changed('user');
    expect(proof.getState().dirty).toBe(true);
    await vi.advanceTimersByTimeAsync(800);
    expect(proof.getState()).toMatchObject({ confirmed: true, dirty: false });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('discards a matching async result when the document changed during the request', async () => {
    const first = deferred<DurableBoardStatus>(),
      second = deferred<DurableBoardStatus>();
    const queue = [first, second];
    const { proof, local } = setup(() => queue.shift()!.promise);
    proof.setConnected(true);
    await vi.advanceTimersByTimeAsync(800);
    local(2);
    proof.changed('user');
    first.resolve({ fingerprint: nodeFingerprint([{ id: 'shape:a', x: 0 }]), documentClock: 7 });
    await vi.advanceTimersByTimeAsync(0);
    expect(proof.getState()).toMatchObject({ confirmed: false, dirty: true });
    await vi.advanceTimersByTimeAsync(800);
    second.resolve({ fingerprint: nodeFingerprint([{ id: 'shape:a', x: 2 }]), documentClock: 8 });
    await vi.advanceTimersByTimeAsync(0);
    expect(proof.getState()).toMatchObject({ confirmed: true, dirty: false, documentClock: 8 });
  });
  it('waits for outstanding document packets and rechecks after reconnect', async () => {
    const { proof, local, fetch } = setup();
    proof.setConnected(true);
    proof.setTransportPending(1);
    local(1);
    proof.changed('user');
    local(0);
    proof.changed('user');
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetch).not.toHaveBeenCalled();
    proof.setTransportPending(0);
    await vi.advanceTimersByTimeAsync(800);
    expect(proof.getState()).toMatchObject({ confirmed: true, dirty: false });
    proof.setConnected(false);
    local(3);
    proof.changed('user');
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetch).toHaveBeenCalledTimes(1);
    proof.setConnected(true);
    await vi.advanceTimersByTimeAsync(800);
    expect(proof.getState()).toMatchObject({ confirmed: false, dirty: true });
  });
  it('preserves dirty work on failed proof and does not poll without another event', async () => {
    const { proof } = setup(async () => {
      throw new Error('offline');
    });
    proof.setConnected(true);
    proof.changed('user');
    await vi.advanceTimersByTimeAsync(800);
    expect(proof.getState()).toMatchObject({ confirmed: false, dirty: true, failed: true });
    await vi.advanceTimersByTimeAsync(5000);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels pending timers on disposal', async () => {
    const { proof, fetch } = setup();
    proof.setConnected(true);
    proof.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('discards a stale asynchronous hash before requesting a server proof', async () => {
    let local = [{ id: 'a', x: 0 }];
    const hash = deferred<string>();
    const fetch = vi.fn(async () => ({ fingerprint: nodeFingerprint(local), documentClock: 4 }));
    const proof = new BoardContentProof({
      readRecords: () => local,
      fetchStatus: fetch,
      fingerprint: () => hash.promise,
      debounceMs: 800,
    });
    proofs.push(proof);
    proof.setConnected(true);
    await vi.advanceTimersByTimeAsync(800);
    local = [{ id: 'a', x: 1 }];
    proof.changed('user');
    hash.resolve(nodeFingerprint([{ id: 'a', x: 0 }]));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(proof.getState()).toMatchObject({ confirmed: false, dirty: true });
  });
  it('aborts an in-flight request on disposal and ignores its late result', async () => {
    const response = deferred<DurableBoardStatus>();
    let signal: AbortSignal | undefined;
    const proof = new BoardContentProof({
      readRecords: () => [{ id: 'a' }],
      fingerprint: async () => nodeFingerprint([{ id: 'a' }]),
      fetchStatus: (requestSignal) => {
        signal = requestSignal;
        return response.promise;
      },
      debounceMs: 800,
    });
    proofs.push(proof);
    proof.setConnected(true);
    await vi.advanceTimersByTimeAsync(800);
    proof.dispose();
    expect(signal?.aborted).toBe(true);
    response.resolve({ fingerprint: nodeFingerprint([{ id: 'a' }]), documentClock: 4 });
    await vi.advanceTimersByTimeAsync(0);
    expect(proof.getState().confirmed).toBe(false);
  });
});
