import { describe, expect, it } from 'vitest';
import { BoardMessageGate, checkBoardRecords, BOARD_LIMITS } from '../server/boards/limits.js';

describe('bounded native board input', () => {
  it('accepts normal SDK presence timestamps in epoch milliseconds', () => {
    const message = JSON.stringify({ type: 'push', clientClock: 1, presence: ['put', { lastActivityTimestamp: 1794515573000 }] });
    expect(new BoardMessageGate().accept(message)).toBe(message);
  });
  it('assembles ordered SDK chunks and clears state between messages', () => {
    const gate = new BoardMessageGate();
    expect(gate.accept('1_{"type":')).toBeNull();
    expect(gate.accept('0_"ping"}')).toBe('{"type":"ping"}');
    expect(gate.accept('{"type":"ping"}')).toBe('{"type":"ping"}');
  });
  it('rejects large declared chunk count, disorder and unfinished-buffer growth', () => {
    expect(() => new BoardMessageGate().accept('999999_payload')).toThrow();
    const disorder = new BoardMessageGate();
    disorder.accept('2_{');
    expect(() => disorder.accept('0_}')).toThrow();
    const gate = new BoardMessageGate({ messageBytes: 25, frameBytes: 25 });
    gate.accept('2_{"a":"1234');
    gate.accept('1_5678901234');
    expect(() => gate.accept('0_567890"}')).toThrow();
  });
  it('rejects oversized frames, invalid JSON, prototype keys and deeply nested payloads', () => {
    const gate = new BoardMessageGate({ frameBytes: 20 });
    expect(() => gate.accept('x'.repeat(21))).toThrow();
    expect(() => new BoardMessageGate().accept('{invalid')).toThrow();
    expect(() => new BoardMessageGate().accept('{"__proto__":{"polluted":true}}')).toThrow();
    expect(() => new BoardMessageGate().accept('{"presence":{"imageUrl":"https://remote.invalid/track.png"}}')).toThrow();
    expect(() => new BoardMessageGate().accept('{"a":'.repeat(40) + '0' + '}'.repeat(40))).toThrow();
  });
  it('enforces document record/byte budgets and validates the final candidate', () => {
    const valid = { id: 'shape:a', typeName: 'shape', type: 'geo', props: { w: 20 } };
    expect(() => checkBoardRecords([valid], () => {})).not.toThrow();
    expect(() => checkBoardRecords([valid, valid], () => {}, { records: 1 })).toThrow();
    expect(() => checkBoardRecords([valid], () => {}, { documentBytes: 8 })).toThrow();
    expect(() => checkBoardRecords([valid], () => { throw new Error('invalid source'); })).toThrow('invalid source');
    expect(BOARD_LIMITS.records).toBeGreaterThan(302);
  });
  it('rejects unbounded numbers, sources and external active content', () => {
    const shape = { id: 'shape:a', typeName: 'shape', type: 'geo', props: {} };
    expect(() => checkBoardRecords([{ ...shape, x: Infinity }], () => {})).toThrow();
    expect(() => checkBoardRecords([{ ...shape, type: 'embed' }], () => {})).toThrow();
    expect(() => checkBoardRecords([{ id: 'asset:a', typeName: 'asset', type: 'image', props: { src: 'https://elsewhere.invalid/private.png' } }], () => {})).toThrow();
    expect(() => checkBoardRecords([{ id: 'asset:a', typeName: 'asset', type: 'image', props: { src: 'data:image/svg+xml,<svg/>' } }], () => {})).toThrow();
    expect(() => checkBoardRecords([{ id: 'asset:a', typeName: 'asset', type: 'image', props: { src: 'data:image/png;base64,YQ==' } }], () => {})).not.toThrow();
  });
});
