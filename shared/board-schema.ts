import {
  createTLSchema,
  defaultShapeSchemas,
  type TLBaseShape,
  type TLRecord,
} from '@tldraw/tlschema';
import { T } from '@tldraw/validate';
import type { KatexOptions } from 'katex';
import { canonicalBoardDocument } from './board-fingerprint';
import {
  GRAPH_LIMITS,
  parseGraphExpression,
  validateGraphBounds,
  type GeometryPoints,
  type GraphBounds,
} from './board-math';

export const BOARD_SOURCE_LIMITS = {
  formula: 4096,
  python: 65536,
  rasterDataUrl: 240_000,
} as const;
export const BOARD_KATEX_OPTIONS: KatexOptions = {
  throwOnError: false,
  trust: false,
  strict: 'error',
  maxExpand: 200,
  maxSize: 20,
  displayMode: true,
  output: 'htmlAndMathml',
};
const boundedNumber = (min: number, max: number) =>
  T.number.check((n) => {
    if (n < min || n > max) throw new Error(`Число должно лежать в пределах ${min}…${max}.`);
  });
const boundedString = (max: number) =>
  T.string.check((source) => {
    if (source.length > max) throw new Error(`Источник длиннее ${max} символов.`);
  });
const sizeProps = { w: boundedNumber(1, 4000), h: boundedNumber(1, 4000) };
const coordinate = boundedNumber(-10000, 10000);
export const formulaProps = { ...sizeProps, source: boundedString(BOARD_SOURCE_LIMITS.formula) };
export const graphProps = {
  ...sizeProps,
  expression: boundedString(GRAPH_LIMITS.source).check((source) => {
    parseGraphExpression(source);
  }),
  a: coordinate,
  xMin: coordinate,
  xMax: coordinate,
  yMin: coordinate,
  yMax: coordinate,
};
export const geometryProps = {
  ...sizeProps,
  kind: T.literalEnum('triangle', 'circle'),
  ax: coordinate,
  ay: coordinate,
  bx: coordinate,
  by: coordinate,
  cx: coordinate,
  cy: coordinate,
  radius: boundedNumber(0.001, 10000),
  showLengths: T.boolean,
  showAngles: T.boolean,
};
export const pythonProps = {
  ...sizeProps,
  source: boundedString(BOARD_SOURCE_LIMITS.python),
  version: T.integer.check((version) => {
    if (version < 1 || !Number.isSafeInteger(version))
      throw new Error('Недопустимая версия исходного кода.');
  }),
};

export interface FormulaProps {
  w: number;
  h: number;
  source: string;
}
export interface GraphProps extends GraphBounds {
  w: number;
  h: number;
  expression: string;
}
export interface GeometryProps extends GeometryPoints {
  w: number;
  h: number;
  kind: 'triangle' | 'circle';
  radius: number;
  showLengths: boolean;
  showAngles: boolean;
}
export interface PythonProps {
  w: number;
  h: number;
  source: string;
  version: number;
}
export type FormulaShape = TLBaseShape<'math-formula', FormulaProps>;
export type GraphShape = TLBaseShape<'math-graph', GraphProps>;
export type GeometryShape = TLBaseShape<'math-geometry', GeometryProps>;
export type PythonShape = TLBaseShape<'code-python', PythonProps>;
export type BoardSubjectShape = FormulaShape | GraphShape | GeometryShape | PythonShape;

declare module '@tldraw/tlschema' {
  interface TLGlobalShapePropsMap {
    'math-formula': FormulaProps;
    'math-graph': GraphProps;
    'math-geometry': GeometryProps;
    'code-python': PythonProps;
  }
}

/** Keep the exact same schema on the native room and its lazy browser client. */
export const boardSchema = createTLSchema({
  shapes: {
    ...defaultShapeSchemas,
    'math-formula': { props: formulaProps },
    'math-graph': { props: graphProps },
    'math-geometry': { props: geometryProps },
    'code-python': { props: pythonProps },
  },
});

export function isBoardSubjectShape(record: { type: string }): record is BoardSubjectShape {
  return (
    record.type === 'math-formula' ||
    record.type === 'math-graph' ||
    record.type === 'math-geometry' ||
    record.type === 'code-python'
  );
}

/** No network resolution or decoding is needed to enforce the raster asset policy. */
export function isBoardRasterDataUrl(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= BOARD_SOURCE_LIMITS.rasterDataUrl &&
    /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
  );
}

/** Synchronous subject-specific validation; the host also applies whole-document budgets. */
export function validateBoardRecord(record: unknown): void {
  if (!record || typeof record !== 'object' || Array.isArray(record))
    throw new Error('Ожидается запись доски.');
  const candidate = record as Record<string, unknown>;
  if (
    typeof candidate.typeName !== 'string' ||
    !Object.hasOwn(boardSchema.types, candidate.typeName)
  ) {
    throw new Error('Неизвестный тип записи доски.');
  }
  const recordType = boardSchema.types[candidate.typeName as keyof typeof boardSchema.types];
  recordType.validate(record);
  if (
    candidate.typeName === 'user' &&
    candidate.imageUrl !== '' &&
    !isBoardRasterDataUrl(candidate.imageUrl)
  ) {
    throw new Error('Внешние аватары участников отключены.');
  }
  if (candidate.typeName === 'shape') {
    if (candidate.type === 'embed' || candidate.type === 'video' || candidate.type === 'bookmark') {
      throw new Error('Внешние встраиваемые материалы в досках отключены.');
    }
    if (candidate.type === 'math-graph')
      validateGraphBounds(candidate.props as unknown as GraphProps);
  }
  if (candidate.typeName === 'asset') {
    const props = candidate.props as Record<string, unknown>;
    if (
      candidate.type !== 'image' ||
      !isBoardRasterDataUrl(props.src) ||
      !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(props.mimeType))
    ) {
      throw new Error('Разрешены только ограниченные растровые изображения без внешних ссылок.');
    }
  }
}

/** Saved history uses a fresh static store, retaining and applying native schema migrations. */
export function toBoardStoreSnapshot(
  snapshot: unknown,
): Parameters<typeof boardSchema.migrateStoreSnapshot>[0] {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot))
    throw new Error('Некорректная сохранённая версия.');
  const room = snapshot as { documents?: unknown; schema?: unknown };
  if (
    !Array.isArray(room.documents) ||
    room.documents.length > 2000 ||
    !room.schema ||
    typeof room.schema !== 'object'
  ) {
    throw new Error('Нет документов или схемы сохранённой версии.');
  }
  const records = room.documents.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error('Некорректная запись версии.');
    const row = entry as { state?: unknown; lastChangedClock?: unknown };
    if (!Number.isSafeInteger(row.lastChangedClock) || Number(row.lastChangedClock) < 0)
      throw new Error('Некорректная версия записи.');
    return row.state;
  });
  const canonical = canonicalBoardDocument(records);
  if (new TextEncoder().encode(canonical).length > 8 * 1024 * 1024)
    throw new Error('Сохранённая версия слишком велика.');
  const store = Object.fromEntries(
    records.map((record) => [(record as { id: string }).id, record]),
  ) as Record<string, TLRecord>;
  const result = boardSchema.migrateStoreSnapshot({
    store,
    schema: room.schema as Parameters<typeof boardSchema.migrateStoreSnapshot>[0]['schema'],
  });
  if (result.type !== 'success') throw new Error('Эта схема сохранённой версии не поддерживается.');
  for (const record of Object.values(result.value)) {
    validateBoardRecord(record);
    if (boardSchema.types[record.typeName].scope !== 'document')
      throw new Error('Версия содержит данные сеанса.');
  }
  return { store: result.value, schema: boardSchema.serialize() };
}
