import { BOARD_SOURCE_LIMITS } from './board-schema';
import { GRAPH_LIMITS } from './board-math';
export type MathKind = 'math-formula' | 'math-graph' | 'math-geometry';
export type MathValue = string | number | boolean;
export interface MathSubject {
  id: string;
  type: MathKind;
  props: Record<string, MathValue>;
}
export interface MathDraft {
  type: MathKind;
  baseProps: Record<string, MathValue>;
  draft: Record<string, MathValue>;
  numericDraft: Record<string, string>;
  applied: Record<string, MathValue>;
}
const fields: Record<MathKind, readonly string[]> = {
  'math-formula': ['source'],
  'math-graph': ['expression', 'a', 'xMin', 'xMax', 'yMin', 'yMax'],
  'math-geometry': [
    'kind',
    'ax',
    'ay',
    'bx',
    'by',
    'cx',
    'cy',
    'radius',
    'showLengths',
    'showAngles',
  ],
};
function desired(entry: MathDraft, key: string): MathValue {
  if (!Object.hasOwn(entry.numericDraft, key)) return entry.draft[key];
  const raw = entry.numericDraft[key];
  if (!raw.trim() || !Number.isFinite(Number(raw))) throw new Error('Заполните все числовые поля.');
  return Number(raw);
}
function changedKeys(entry: MathDraft): string[] {
  return fields[entry.type].filter((key) => {
    if (Object.hasOwn(entry.applied, key)) return true;
    try {
      return desired(entry, key) !== entry.baseProps[key];
    } catch {
      return true;
    }
  });
}
/** Session-only recovery: a submitted field remains here until exact durable content proof. */
export class MathDraftBook {
  readonly drafts = new Map<string, MathDraft>();
  get size() {
    return this.drafts.size;
  }
  get(id: string) {
    return this.drafts.get(id);
  }
  private prepare(shape: MathSubject, key: string): MathDraft {
    if (!fields[shape.type]?.includes(key))
      throw new Error('Это поле не редактируется в черновике.');
    const existing = this.drafts.get(shape.id);
    if (existing && existing.type !== shape.type)
      throw new Error('Тип объекта изменён. Сохраните черновик.');
    const entry = existing
      ? structuredClone(existing)
      : {
          type: shape.type,
          baseProps: { ...shape.props },
          draft: { ...shape.props },
          numericDraft: {},
          applied: {},
        };
    // A previously untouched field may have changed remotely since another field's draft began.
    // Capture its own live baseline on first edit; dirty/submitted fields retain their baseline.
    if (existing && !changedKeys(existing).includes(key)) {
      entry.baseProps[key] = shape.props[key];
      entry.draft[key] = shape.props[key];
      delete entry.numericDraft[key];
    }
    return entry;
  }
  private retain(id: string, entry: MathDraft) {
    if (changedKeys(entry).length) this.drafts.set(id, entry);
    else this.drafts.delete(id);
  }
  setField(shape: MathSubject, key: string, value: MathValue): void {
    const entry = this.prepare(shape, key);
    if (typeof value !== typeof entry.baseProps[key])
      throw new Error('Некорректное значение поля.');
    const max =
      key === 'source'
        ? BOARD_SOURCE_LIMITS.formula
        : key === 'expression'
          ? GRAPH_LIMITS.source
          : 128;
    if (typeof value === 'string' && value.length > max)
      throw new Error(`Поле длиннее ${max} символов.`);
    if (typeof value === 'number' && !Number.isFinite(value))
      throw new Error('Число должно быть конечным.');
    entry.draft[key] = value;
    delete entry.numericDraft[key];
    this.retain(shape.id, entry);
  }
  setNumeric(shape: MathSubject, key: string, value: string): void {
    const entry = this.prepare(shape, key);
    if (typeof entry.baseProps[key] !== 'number' || value.length > 128)
      throw new Error('Некорректный числовой черновик.');
    entry.numericDraft[key] = value;
    if (value.trim() && Number.isFinite(Number(value))) entry.draft[key] = Number(value);
    this.retain(shape.id, entry);
  }
  view(shape: MathSubject): Record<string, MathValue> {
    const entry = this.drafts.get(shape.id);
    if (!entry || entry.type !== shape.type) return shape.props;
    const props = { ...shape.props };
    for (const key of changedKeys(entry)) props[key] = entry.draft[key];
    return props;
  }
  plan(
    id: string,
    latest: MathSubject | undefined,
  ): { patch: Record<string, MathValue>; conflicts: string[] } {
    const entry = this.drafts.get(id);
    if (!entry) return { patch: {}, conflicts: [] };
    if (!latest || latest.type !== entry.type)
      throw new Error('Объект удалён или изменён. Черновик доступен в экспорте восстановления.');
    const patch: Record<string, MathValue> = {},
      conflicts: string[] = [];
    for (const key of changedKeys(entry)) {
      const value = desired(entry, key);
      patch[key] = value;
      if (
        latest.props[key] !== entry.baseProps[key] &&
        latest.props[key] !== value &&
        (!Object.hasOwn(entry.applied, key) || latest.props[key] !== entry.applied[key])
      )
        conflicts.push(key);
    }
    return { patch, conflicts };
  }
  markApplied(id: string, patch: Record<string, MathValue>): void {
    const entry = this.drafts.get(id);
    if (entry) this.drafts.set(id, { ...entry, applied: { ...entry.applied, ...patch } });
  }
  rebase(id: string, latest: MathSubject | undefined): void {
    const entry = this.drafts.get(id);
    if (!entry) return;
    const plan = this.plan(id, latest);
    const next = structuredClone(entry);
    for (const key of plan.conflicts) next.baseProps[key] = latest!.props[key];
    this.retain(id, next);
  }
  discard(id: string): void {
    this.drafts.delete(id);
  }
  confirm(records: readonly MathSubject[]): boolean {
    const current = new Map(records.map((shape) => [shape.id, shape]));
    let changed = false;
    for (const [id, entry] of this.drafts) {
      const shape = current.get(id);
      if (!shape || shape.type !== entry.type) continue;
      const next = structuredClone(entry);
      let updated = false;
      for (const [key, value] of Object.entries(entry.applied)) {
        if (shape.props[key] !== value) continue;
        next.baseProps[key] = value;
        delete next.applied[key];
        try {
          if (desired(entry, key) === value) {
            next.draft[key] = value;
            delete next.numericDraft[key];
          }
        } catch {
          /* Preserve partial new input. */
        }
        updated = true;
      }
      if (updated) {
        changed = true;
        this.retain(id, next);
      }
    }
    return changed;
  }
}
