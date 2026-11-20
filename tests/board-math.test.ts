import { describe, expect, it } from 'vitest';
import {
  GRAPH_LIMITS,
  evaluateGraphExpression,
  geometryMeasurements,
  parseGraphExpression,
  sampleGraph,
} from '../shared/board-math';
import {
  BOARD_KATEX_OPTIONS,
  BOARD_SOURCE_LIMITS,
  boardSchema,
  toBoardStoreSnapshot,
  validateBoardRecord,
} from '../shared/board-schema';
import katex from 'katex';

describe('immutable saved board conversion', () => {
  const savedFormula = () => shape('math-formula', { w: 300, h: 120, source: 'x^2' });
  it('converts a native saved room to an independently validated static store', () => {
    const room = {
      clock: 4,
      schema: boardSchema.serialize(),
      documents: [{ state: savedFormula(), lastChangedClock: 4 }],
    };
    const before = JSON.stringify(room);
    const converted = toBoardStoreSnapshot(room);
    expect(Object.values(converted.store).find((record) => record.id === 'shape:test')).toEqual(
      savedFormula(),
    );
    expect(converted.schema).toEqual(boardSchema.serialize());
    expect(JSON.stringify(room)).toBe(before);
  });
  it('rejects future schemas, duplicate records and malformed subject content', () => {
    const entry = { state: savedFormula(), lastChangedClock: 4 };
    expect(() =>
      toBoardStoreSnapshot({ schema: { schemaVersion: 999 }, documents: [entry] }),
    ).toThrow();
    expect(() =>
      toBoardStoreSnapshot({ schema: boardSchema.serialize(), documents: [entry, entry] }),
    ).toThrow();
    expect(() =>
      toBoardStoreSnapshot({
        schema: boardSchema.serialize(),
        documents: [
          {
            ...entry,
            state: { ...savedFormula(), props: { w: 300, h: 120, source: 'x'.repeat(5000) } },
          },
        ],
      }),
    ).toThrow();
    expect(() => toBoardStoreSnapshot(null)).toThrow();
  });
});

describe('bounded board graph expressions', () => {
  it('evaluates arithmetic precedence, right-associative powers and the editable a parameter', () => {
    expect(evaluateGraphExpression(parseGraphExpression('-x^2 + a * 2^3^2'), 3, 2)).toBe(1015);
    expect(evaluateGraphExpression(parseGraphExpression('2^(-2) + 1e-2'), 0, 0)).toBeCloseTo(0.26);
  });

  it('supports the documented single-argument math functions', () => {
    const ast = parseGraphExpression('sin(x) + cos(x) + sqrt(abs(a)) + exp(0) + log(1)');
    expect(evaluateGraphExpression(ast, 0, -4)).toBe(4);
  });

  it.each([
    'globalThis.alert(1)',
    'x.constructor',
    'Math.sin(x)',
    'fetch(x)',
    'x = 1',
    'x; a',
    'sin(x, a)',
    'sin x',
    'x[0]',
    '2x',
    'Infinity',
    'NaN',
    '1e999',
    'x ? 1 : 0',
    '() => 1',
    '__proto__',
    '',
    '1 +',
    'sin()',
    '(x',
  ])('rejects unsafe or malformed expression %s', (source) => {
    expect(() => parseGraphExpression(source)).toThrow();
  });

  it('bounds source size, nesting and AST complexity before evaluation', () => {
    expect(() => parseGraphExpression('x'.repeat(GRAPH_LIMITS.source + 1))).toThrow();
    expect(() => parseGraphExpression(`${'('.repeat(40)}x${')'.repeat(40)}`)).toThrow();
    expect(() => parseGraphExpression(Array.from({ length: 140 }, () => 'x').join('+'))).toThrow();
  });

  it('marks non-finite values and graph discontinuities as gaps', () => {
    expect(evaluateGraphExpression(parseGraphExpression('1/x'), 0, 1)).toBeNull();
    expect(evaluateGraphExpression(parseGraphExpression('sqrt(x)'), -1, 1)).toBeNull();
    expect(sampleGraph('1/x', { a: 1, xMin: -1, xMax: 1, yMin: -10, yMax: 10 }, 4)).toEqual([
      { x: -1, y: -1 },
      { x: -0.5, y: -2 },
      null,
      { x: 0.5, y: 2 },
      { x: 1, y: 1 },
    ]);
  });

  it('rejects invalid ranges and unbounded sample requests', () => {
    const bounds = { a: 1, xMin: -5, xMax: 5, yMin: -5, yMax: 5 };
    expect(() => sampleGraph('x', { ...bounds, xMax: -5 }, 20)).toThrow();
    expect(() => sampleGraph('x', { ...bounds, a: Infinity }, 20)).toThrow();
    expect(() => sampleGraph('x', bounds, 100_000)).toThrow();
  });
});

describe('structured board geometry', () => {
  it('computes lengths and angles from reopenable triangle coordinates', () => {
    const metrics = geometryMeasurements({ ax: 0, ay: 0, bx: 3, by: 0, cx: 0, cy: 4 });
    expect(metrics.lengths).toEqual({ AB: 3, BC: 5, CA: 4 });
    expect(metrics.angles.A).toBeCloseTo(90);
    expect(metrics.angles.B! + metrics.angles.C!).toBeCloseTo(90);
  });

  it('does not invent angles for degenerate geometry', () => {
    expect(geometryMeasurements({ ax: 1, ay: 1, bx: 1, by: 1, cx: 2, cy: 1 }).angles.A).toBeNull();
  });
});

const shape = (type: string, props: object) => ({
  id: 'shape:test',
  typeName: 'shape',
  type,
  x: 0,
  y: 0,
  rotation: 0,
  index: 'a1',
  parentId: 'page:page',
  opacity: 1,
  isLocked: false,
  meta: {},
  props,
});

describe('board source validation', () => {
  it('accepts native drawing and structured editable subject sources', () => {
    expect(() =>
      validateBoardRecord(
        shape('draw', {
          color: 'black',
          fill: 'none',
          dash: 'draw',
          size: 'm',
          segments: [],
          isComplete: true,
          isClosed: false,
          isPen: false,
          scale: 1,
          scaleX: 1,
          scaleY: 1,
        }),
      ),
    ).not.toThrow();
    expect(() =>
      validateBoardRecord(shape('math-formula', { w: 300, h: 120, source: '\\frac{x}{2}' })),
    ).not.toThrow();
    expect(() =>
      validateBoardRecord(
        shape('math-graph', {
          w: 420,
          h: 320,
          expression: 'a*sin(x)',
          a: 2,
          xMin: -5,
          xMax: 5,
          yMin: -5,
          yMax: 5,
        }),
      ),
    ).not.toThrow();
    expect(() =>
      validateBoardRecord(
        shape('math-geometry', {
          w: 400,
          h: 320,
          kind: 'triangle',
          ax: 0,
          ay: 0,
          bx: 3,
          by: 0,
          cx: 0,
          cy: 4,
          radius: 2,
          showLengths: true,
          showAngles: true,
        }),
      ),
    ).not.toThrow();
    expect(() =>
      validateBoardRecord(shape('code-python', { w: 440, h: 260, source: '', version: 1 })),
    ).not.toThrow();
  });

  it('rejects external user avatar URLs before the native UI can render them', () => {
    const user = {
      id: 'user:test',
      typeName: 'user',
      name: 'Участник',
      color: '#7763d6',
      imageUrl: '',
      meta: {},
    };
    expect(() => validateBoardRecord(user)).not.toThrow();
    expect(() =>
      validateBoardRecord({ ...user, imageUrl: 'https://example.com/avatar.png' }),
    ).toThrow();
  });

  it('rejects oversized source, invalid versions, coordinates and graph ranges', () => {
    expect(() =>
      validateBoardRecord(
        shape('math-formula', {
          w: 300,
          h: 120,
          source: 'x'.repeat(BOARD_SOURCE_LIMITS.formula + 1),
        }),
      ),
    ).toThrow();
    expect(() =>
      validateBoardRecord(
        shape('code-python', {
          w: 440,
          h: 260,
          source: 'x'.repeat(BOARD_SOURCE_LIMITS.python + 1),
          version: 1,
        }),
      ),
    ).toThrow();
    expect(() =>
      validateBoardRecord(shape('code-python', { w: 440, h: 260, source: '', version: 0 })),
    ).toThrow();
    expect(() =>
      validateBoardRecord(
        shape('math-graph', {
          w: 420,
          h: 320,
          expression: 'x.constructor',
          a: 1,
          xMin: -5,
          xMax: 5,
          yMin: -5,
          yMax: 5,
        }),
      ),
    ).toThrow();
    expect(() =>
      validateBoardRecord(
        shape('math-graph', {
          w: 420,
          h: 320,
          expression: 'x',
          a: 1,
          xMin: 5,
          xMax: -5,
          yMin: -5,
          yMax: 5,
        }),
      ),
    ).toThrow();
    expect(() =>
      validateBoardRecord(
        shape('math-geometry', {
          w: 400,
          h: 320,
          kind: 'circle',
          ax: Infinity,
          ay: 0,
          bx: 3,
          by: 0,
          cx: 0,
          cy: 4,
          radius: 2,
          showLengths: true,
          showAngles: false,
        }),
      ),
    ).toThrow();
  });

  it('rejects externally rendered embeds and unknown native records', () => {
    expect(() =>
      validateBoardRecord(shape('embed', { w: 300, h: 200, url: 'https://example.com' })),
    ).toThrow();
    expect(() => validateBoardRecord({ typeName: '__proto__' })).toThrow();
    expect(() => validateBoardRecord(null)).toThrow();
  });
});

describe('safe formula rendering with the installed KaTeX', () => {
  it('keeps readable formula markup and a strict maximum layout size', () => {
    expect(katex.renderToString('\\frac{x^2}{2}', BOARD_KATEX_OPTIONS)).toContain('katex');
    const markup = katex.renderToString('\\rule{1000em}{1em}', BOARD_KATEX_OPTIONS);
    expect(markup).not.toContain('width:1000em');
  });
  it.each([
    '\\href{https://example.com}{link}',
    '\\includegraphics{https://example.com/image.png}',
    '\\htmlClass{injected}{x}',
  ])('does not create trusted external HTML for %s', (source) => {
    const markup = katex.renderToString(source, BOARD_KATEX_OPTIONS);
    expect(markup).not.toMatch(/<(?:a|img)\b|class="injected"/);
  });
});
