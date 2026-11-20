import { describe, expect, it } from 'vitest';
import { MathDraftBook, type MathSubject } from '../shared/board-drafts';
const graph = (props: Record<string, string | number | boolean> = {}): MathSubject => ({
  id: 'shape:g',
  type: 'math-graph',
  props: {
    w: 420,
    h: 320,
    expression: 'sin(x)',
    a: 1,
    xMin: -5,
    xMax: 5,
    yMin: -5,
    yMax: 5,
    ...props,
  },
});
const formula = (): MathSubject => ({
  id: 'shape:f',
  type: 'math-formula',
  props: { w: 300, h: 120, source: 'x^2' },
});
describe('recoverable per-object math drafts', () => {
  it('captures the live text baseline when that field is first edited after another field', () => {
    const book = new MathDraftBook();
    const initial = graph({ expression: 'x' });
    book.setNumeric(initial, 'a', '2');
    const remote = graph({ expression: 'x^2' });
    book.setField(remote, 'expression', 'x');
    expect(book.get(remote.id)?.baseProps.expression).toBe('x^2');
    expect(book.view(remote).expression).toBe('x');
    expect(book.plan(remote.id, remote)).toEqual({
      patch: { expression: 'x', a: 2 },
      conflicts: [],
    });
  });
  it('captures the live numeric baseline even when new input equals its old untouched value', () => {
    const book = new MathDraftBook();
    book.setField(graph(), 'expression', 'cos(x)');
    const remote = graph({ a: 3 });
    book.setNumeric(remote, 'a', '1');
    expect(book.get(remote.id)?.baseProps.a).toBe(3);
    expect(book.get(remote.id)?.numericDraft.a).toBe('1');
    expect(book.plan(remote.id, remote)).toEqual({
      patch: { expression: 'cos(x)', a: 1 },
      conflicts: [],
    });
  });
  it('retains two independent unapplied drafts across selection changes', () => {
    const book = new MathDraftBook();
    book.setField(formula(), 'source', 'x^3');
    book.setNumeric(graph(), 'a', '2');
    expect(book.size).toBe(2);
    expect(book.view(formula()).source).toBe('x^3');
    expect(book.get('shape:g')?.numericDraft.a).toBe('2');
  });
  it('merges only changed fields and displays unrelated live properties', () => {
    const book = new MathDraftBook();
    book.setNumeric(graph(), 'a', '2');
    const remote = graph({ expression: 'cos(x)', w: 600 });
    expect(book.plan('shape:g', remote)).toEqual({ patch: { a: 2 }, conflicts: [] });
    expect(book.view(remote)).toMatchObject({ a: 2, expression: 'cos(x)', w: 600 });
  });
  it('requires explicit resolution of a same-field remote change', () => {
    const book = new MathDraftBook();
    book.setNumeric(graph(), 'a', '2');
    const remote = graph({ a: 3 });
    expect(book.plan('shape:g', remote).conflicts).toEqual(['a']);
    expect(book.get('shape:g')?.baseProps.a).toBe(1);
    book.rebase('shape:g', remote);
    expect(book.plan('shape:g', remote)).toEqual({ patch: { a: 2 }, conflicts: [] });
    expect(book.plan('shape:g', graph({ a: 4 })).conflicts).toEqual(['a']);
  });
  it('keeps incomplete numeric input recoverable and refuses to apply it', () => {
    const book = new MathDraftBook();
    book.setNumeric(graph(), 'a', '-');
    expect(book.get('shape:g')?.numericDraft.a).toBe('-');
    expect(() => book.plan('shape:g', graph())).toThrow();
    book.setNumeric(graph(), 'a', '-2.5');
    expect(book.plan('shape:g', graph()).patch).toEqual({ a: -2.5 });
  });
  it('keeps applied source until canonical proof confirms the intended field values', () => {
    const book = new MathDraftBook();
    const f = formula();
    book.setField(f, 'source', 'x^3');
    book.markApplied(f.id, { source: 'x^3' });
    expect(book.confirm([f])).toBe(false);
    expect(book.size).toBe(1);
    expect(book.confirm([{ ...f, props: { ...f.props, source: 'x^3', w: 700 } }])).toBe(true);
    expect(book.size).toBe(0);
  });
  it('preserves new input when an earlier applied value becomes confirmed', () => {
    const book = new MathDraftBook();
    const f = formula();
    book.setField(f, 'source', 'x^3');
    book.markApplied(f.id, { source: 'x^3' });
    const applied = { ...f, props: { ...f.props, source: 'x^3' } };
    book.setField(applied, 'source', 'x^4');
    expect(book.plan(f.id, applied).conflicts).toEqual([]);
    book.confirm([applied]);
    expect(book.get(f.id)?.draft.source).toBe('x^4');
    expect(book.plan(f.id, applied)).toEqual({ patch: { source: 'x^4' }, conflicts: [] });
  });
  it('retains deleted/rejected objects for recovery, and refresh is explicit', () => {
    const book = new MathDraftBook();
    const f = formula();
    book.setField(f, 'source', 'x^3');
    book.markApplied(f.id, { source: 'x^3' });
    expect(() => book.plan(f.id, undefined)).toThrow();
    expect(book.confirm([])).toBe(false);
    expect(book.get(f.id)?.draft.source).toBe('x^3');
    book.discard(f.id);
    expect(book.size).toBe(0);
  });
  it('bounds source and editable fields before retaining them', () => {
    const book = new MathDraftBook();
    expect(() => book.setField(formula(), 'source', 'x'.repeat(4097))).toThrow();
    expect(() => book.setField(graph(), 'expression', 'x'.repeat(513))).toThrow();
    expect(() => book.setField(graph(), 'w', 900)).toThrow();
    expect(() => book.setNumeric(graph(), 'a', '0'.repeat(200))).toThrow();
    expect(book.size).toBe(0);
  });
  it('treats a peer already matching the intended value as a no-op apply requiring proof', () => {
    const book = new MathDraftBook();
    const f = formula();
    book.setField(f, 'source', 'x^3');
    const matching = { ...f, props: { ...f.props, source: 'x^3' } };
    expect(book.plan(f.id, matching)).toEqual({ patch: { source: 'x^3' }, conflicts: [] });
    book.confirm([matching]);
    expect(book.size).toBe(1);
    book.markApplied(f.id, { source: 'x^3' });
    book.confirm([matching]);
    expect(book.size).toBe(0);
  });
  it('retains a user reversal while an earlier applied value is still unconfirmed', () => {
    const book = new MathDraftBook();
    const f = formula();
    book.setField(f, 'source', 'x^3');
    book.markApplied(f.id, { source: 'x^3' });
    const applied = { ...f, props: { ...f.props, source: 'x^3' } };
    book.setField(applied, 'source', 'x^2');
    expect(book.size).toBe(1);
    book.confirm([applied]);
    expect(book.plan(f.id, applied)).toEqual({ patch: { source: 'x^2' }, conflicts: [] });
  });
  it('merges a geometry display change without reverting a remote point move', () => {
    const geometry: MathSubject = {
      id: 'shape:geo',
      type: 'math-geometry',
      props: {
        w: 400,
        h: 320,
        kind: 'triangle',
        ax: 0,
        ay: 0,
        bx: 4,
        by: 0,
        cx: 1,
        cy: 3,
        radius: 2,
        showLengths: true,
        showAngles: true,
      },
    };
    const book = new MathDraftBook();
    book.setField(geometry, 'showAngles', false);
    const moved = { ...geometry, props: { ...geometry.props, ax: 2 } };
    expect(book.plan(geometry.id, moved)).toEqual({ patch: { showAngles: false }, conflicts: [] });
    expect(book.view(moved).ax).toBe(2);
    book.discard(geometry.id);
    expect(book.view(moved)).toEqual(moved.props);
  });
});
