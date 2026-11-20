import {
  Children,
  cloneElement,
  isValidElement,
  useId,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useSync } from '@tldraw/sync';
import * as nativeSync from '@tldraw/sync-core';
import type { TLPersistentClientSocket } from '@tldraw/sync-core';
import { getAssetUrls } from '@tldraw/assets/selfHosted';
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  Tldraw,
  createShapeId,
  createTLStore,
  useValue,
  atom,
  createUserId,
  UserRecordType,
  resizeBox,
  type Editor,
  type TLAssetStore,
  type TLStore,
  type TLUiOverrides,
  type TLResizeInfo,
  type TLShapePartial,
} from 'tldraw';
import katex from 'katex';
import {
  BOARD_KATEX_OPTIONS,
  BOARD_SOURCE_LIMITS,
  boardSchema,
  formulaProps,
  graphProps,
  geometryProps,
  pythonProps,
  isBoardRasterDataUrl,
  isBoardSubjectShape,
  validateBoardRecord,
  toBoardStoreSnapshot,
  type BoardSubjectShape,
  type FormulaShape,
  type GraphShape,
  type GeometryShape,
  type PythonShape,
} from '../shared/board-schema';
import { geometryMeasurements, sampleGraph } from '../shared/board-math';
import { MathDraftBook, type MathSubject, type MathValue } from '../shared/board-drafts';
import {
  BoardContentProof,
  INITIAL_BOARD_PROOF_STATE,
  type BoardProofState,
  type DurableBoardStatus,
} from '../shared/board-fingerprint';
import 'tldraw/tldraw.css';
import 'katex/dist/katex.min.css';
import './board-editor.css';

interface BoardEditorProps {
  boardId: string;
  role: 'owner' | 'editor' | 'viewer';
  licenseKey?: string;
}
interface PythonDraft {
  source: string;
  baseSource: string;
  expectedVersion: number;
}
interface SyncProgress {
  pending: number;
  ackAt: number | null;
  rejected: boolean;
}
const initialProgress: SyncProgress = {
  pending: 0,
  ackAt: null,
  rejected: false,
};
const assetUrls = getAssetUrls({ baseUrl: '/board-assets/5.6.0/' });
// 5.6.0 exports this native adapter at runtime, but excludes its declaration from the public .d.mts.
// This narrow type describes only its public socket contract; messages are forwarded untouched.
const NativeClientWebSocketAdapter = (
  nativeSync as unknown as {
    ClientWebSocketAdapter: new (getUri: () => string) => TLPersistentClientSocket;
  }
).ClientWebSocketAdapter;
interface ObservedNativeMessage {
  type?: string;
  clientClock?: number;
  diff?: object;
  data?: ObservedNativeMessage[];
  action?: unknown;
}
const imageTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
// Tldraw includes this identity in its Editor construction dependencies.
// A fresh [] on each progress render repeatedly tears down the editor.
const videoTypes: string[] = [];
const localAssets: TLAssetStore = {
  async upload(_asset, file) {
    if (!imageTypes.includes(file.type) || file.size > 175_000)
      throw new Error('Выберите растровое изображение до 175 КБ.');
    const src = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('Не удалось прочитать изображение.'));
      reader.readAsDataURL(file);
    });
    if (!isBoardRasterDataUrl(src)) throw new Error('Изображение превышает допустимый размер.');
    return { src };
  },
  resolve(asset) {
    return isBoardRasterDataUrl(asset.props.src) ? asset.props.src : null;
  },
};
const uiOverrides: TLUiOverrides = {
  actions(_editor, actions) {
    const result = { ...actions };
    delete result['insert-embed'];
    return result;
  },
};

function FormulaContent({ shape }: { shape: FormulaShape }) {
  const markup = useMemo(
    () => katex.renderToString(shape.props.source || '\\text{Формула}', BOARD_KATEX_OPTIONS),
    [shape.props.source],
  );
  return (
    <HTMLContainer
      className="board-subject board-formula"
      style={{ width: shape.props.w, height: shape.props.h }}
    >
      <div dangerouslySetInnerHTML={{ __html: markup }} />
    </HTMLContainer>
  );
}
function GraphContent({ shape }: { shape: GraphShape }) {
  const { w, h, expression, a, xMin, xMax, yMin, yMax } = shape.props;
  const path = useMemo(() => {
    let drawing = false,
      previousY = 0;
    const segments: string[] = [];
    for (const point of sampleGraph(expression, { a, xMin, xMax, yMin, yMax })) {
      if (!point) {
        drawing = false;
        continue;
      }
      const x = 24 + ((point.x - xMin) / (xMax - xMin)) * (w - 48);
      const y = 28 + ((yMax - point.y) / (yMax - yMin)) * (h - 64);
      const command = drawing && Math.abs(y - previousY) < h / 2 ? 'L' : 'M';
      drawing = true;
      previousY = y;
      segments.push(`${command}${x.toFixed(2)},${y.toFixed(2)}`);
    }
    return segments.join(' ');
  }, [w, h, expression, a, xMin, xMax, yMin, yMax]);
  const x0 = 24 + ((0 - xMin) / (xMax - xMin)) * (w - 48);
  const y0 = 28 + (yMax / (yMax - yMin)) * (h - 64);
  return (
    <HTMLContainer className="board-subject" style={{ width: w, height: h }}>
      <svg
        width={w}
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        role="img"
        aria-label={`График y = ${expression}, a = ${a}`}
      >
        <rect
          x="24"
          y="28"
          width={Math.max(1, w - 48)}
          height={Math.max(1, h - 64)}
          fill="none"
          stroke="currentColor"
          opacity="0.15"
        />
        {x0 >= 24 && x0 <= w - 24 ? (
          <line x1={x0} x2={x0} y1="28" y2={h - 36} className="board-axis" />
        ) : null}
        {y0 >= 28 && y0 <= h - 36 ? (
          <line x1="24" x2={w - 24} y1={y0} y2={y0} className="board-axis" />
        ) : null}
        <path d={path} fill="none" stroke="#6d5ce7" strokeWidth="2.5" />
        <text x="24" y="18">
          y = {expression} · a = {a}
        </text>
        <text x="24" y={h - 14}>
          {xMin}
        </text>
        <text x={w - 24} y={h - 14} textAnchor="end">
          {xMax} · x
        </text>
        <text x="28" y="44">
          {yMax}
        </text>
        <text x="28" y={h - 42}>
          {yMin}
        </text>
      </svg>
    </HTMLContainer>
  );
}
function GeometryContent({ shape }: { shape: GeometryShape }) {
  const p = shape.props;
  const metrics = geometryMeasurements(p);
  const minX = p.kind === 'circle' ? p.ax - p.radius : Math.min(p.ax, p.bx, p.cx);
  const maxX = p.kind === 'circle' ? p.ax + p.radius : Math.max(p.ax, p.bx, p.cx);
  const minY = p.kind === 'circle' ? p.ay - p.radius : Math.min(p.ay, p.by, p.cy);
  const maxY = p.kind === 'circle' ? p.ay + p.radius : Math.max(p.ay, p.by, p.cy);
  const scale = Math.max(
    0.0001,
    Math.min(
      Math.max(1, p.w - 88) / Math.max(0.01, maxX - minX),
      Math.max(1, p.h - 100) / Math.max(0.01, maxY - minY),
    ),
  );
  const x = (n: number) => p.w / 2 + (n - (minX + maxX) / 2) * scale;
  const y = (n: number) => (p.h - 26) / 2 - (n - (minY + maxY) / 2) * scale;
  return (
    <HTMLContainer className="board-subject" style={{ width: p.w, height: p.h }}>
      <svg
        width={p.w}
        height={p.h}
        role="img"
        aria-label={p.kind === 'triangle' ? 'Треугольник ABC' : 'Окружность с центром A'}
      >
        {p.kind === 'circle' ? (
          <>
            <circle
              cx={x(p.ax)}
              cy={y(p.ay)}
              r={p.radius * scale}
              className="board-geometry-line"
            />
            <line
              x1={x(p.ax)}
              y1={y(p.ay)}
              x2={x(p.ax + p.radius)}
              y2={y(p.ay)}
              className="board-axis"
            />
            <circle cx={x(p.ax)} cy={y(p.ay)} r="3" fill="currentColor" />
            <text x={x(p.ax) - 14} y={y(p.ay) - 8}>
              A
            </text>
            {p.showLengths ? (
              <text x="18" y={p.h - 16}>
                r = {p.radius} · C = {(2 * Math.PI * p.radius).toFixed(2)}
              </text>
            ) : null}
          </>
        ) : (
          <>
            <polygon
              points={`${x(p.ax)},${y(p.ay)} ${x(p.bx)},${y(p.by)} ${x(p.cx)},${y(p.cy)}`}
              className="board-geometry-line"
            />
            {(
              [
                ['A', p.ax, p.ay],
                ['B', p.bx, p.by],
                ['C', p.cx, p.cy],
              ] as const
            ).map(([label, px, py]) => (
              <g key={label}>
                <circle cx={x(px)} cy={y(py)} r="3" fill="currentColor" />
                <text x={x(px) + 7} y={y(py) - 8}>
                  {label}
                  {p.showAngles ? ` ${metrics.angles[label]?.toFixed(1) ?? '—'}°` : ''}
                </text>
              </g>
            ))}
            {p.showLengths ? (
              <text x="18" y={p.h - 16}>
                AB {metrics.lengths.AB.toFixed(2)} · BC {metrics.lengths.BC.toFixed(2)} · CA{' '}
                {metrics.lengths.CA.toFixed(2)}
              </text>
            ) : null}
          </>
        )}
      </svg>
    </HTMLContainer>
  );
}
function PythonContent({ shape }: { shape: PythonShape }) {
  return (
    <HTMLContainer
      className="board-subject board-python"
      style={{ width: shape.props.w, height: shape.props.h }}
    >
      <div className="board-code-title">
        Python <span>версия {shape.props.version}</span>
      </div>
      <pre>{shape.props.source || '# Выберите блок, чтобы добавить код'}</pre>
    </HTMLContainer>
  );
}
class FormulaUtil extends BaseBoxShapeUtil<FormulaShape> {
  static override type = 'math-formula' as const;
  static override props = formulaProps;
  override getDefaultProps() {
    return { w: 320, h: 140, source: 'y = \\frac{x^2}{2}' };
  }
  override canEdit() {
    return false;
  }
  override onResize(shape: FormulaShape, info: TLResizeInfo<FormulaShape>) {
    return resizeBox(shape, info, {
      minWidth: 160,
      minHeight: 100,
      maxWidth: 4000,
      maxHeight: 4000,
    });
  }
  override component(shape: FormulaShape) {
    return <FormulaContent shape={shape} />;
  }
  override getIndicatorPath(shape: FormulaShape) {
    const path = new Path2D();
    path.rect(0, 0, shape.props.w, shape.props.h);
    return path;
  }
}
class GraphUtil extends BaseBoxShapeUtil<GraphShape> {
  static override type = 'math-graph' as const;
  static override props = graphProps;
  override getDefaultProps() {
    return { w: 420, h: 320, expression: 'a*sin(x)', a: 1, xMin: -6, xMax: 6, yMin: -3, yMax: 3 };
  }
  override canEdit() {
    return false;
  }
  override onResize(shape: GraphShape, info: TLResizeInfo<GraphShape>) {
    return resizeBox(shape, info, {
      minWidth: 160,
      minHeight: 100,
      maxWidth: 4000,
      maxHeight: 4000,
    });
  }
  override component(shape: GraphShape) {
    return <GraphContent shape={shape} />;
  }
  override getIndicatorPath(shape: GraphShape) {
    const path = new Path2D();
    path.rect(0, 0, shape.props.w, shape.props.h);
    return path;
  }
}
class GeometryUtil extends BaseBoxShapeUtil<GeometryShape> {
  static override type = 'math-geometry' as const;
  static override props = geometryProps;
  override getDefaultProps() {
    return {
      w: 400,
      h: 320,
      kind: 'triangle' as const,
      ax: 0,
      ay: 0,
      bx: 4,
      by: 0,
      cx: 1,
      cy: 3,
      radius: 2,
      showLengths: true,
      showAngles: true,
    };
  }
  override canEdit() {
    return false;
  }
  override onResize(shape: GeometryShape, info: TLResizeInfo<GeometryShape>) {
    return resizeBox(shape, info, {
      minWidth: 160,
      minHeight: 100,
      maxWidth: 4000,
      maxHeight: 4000,
    });
  }
  override component(shape: GeometryShape) {
    return <GeometryContent shape={shape} />;
  }
  override getIndicatorPath(shape: GeometryShape) {
    const path = new Path2D();
    path.rect(0, 0, shape.props.w, shape.props.h);
    return path;
  }
}
class PythonUtil extends BaseBoxShapeUtil<PythonShape> {
  static override type = 'code-python' as const;
  static override props = pythonProps;
  override getDefaultProps() {
    return { w: 460, h: 280, source: '', version: 1 };
  }
  override canEdit() {
    return false;
  }
  override onResize(shape: PythonShape, info: TLResizeInfo<PythonShape>) {
    return resizeBox(shape, info, {
      minWidth: 160,
      minHeight: 100,
      maxWidth: 4000,
      maxHeight: 4000,
    });
  }
  override component(shape: PythonShape) {
    return <PythonContent shape={shape} />;
  }
  override getIndicatorPath(shape: PythonShape) {
    const path = new Path2D();
    path.rect(0, 0, shape.props.w, shape.props.h);
    return path;
  }
}
const shapeUtils = [FormulaUtil, GraphUtil, GeometryUtil, PythonUtil];

/** CodeMirror and its Python grammar load only after a Python object is selected. */
function PythonInput({
  value,
  onChange,
  readOnly = false,
}: {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<import('@codemirror/view').EditorView | null>(null);
  const applyingValue = useRef(false);
  const latest = useRef({ value, onChange, readOnly });
  const configureReadOnly = useRef<((readOnly: boolean) => void) | null>(null);
  const [ready, setReady] = useState(false);
  const [fallbackFocused, setFallbackFocused] = useState(false);
  useEffect(() => {
    latest.current = { value, onChange, readOnly };
    if (view.current && view.current.state.doc.toString() !== value) {
      applyingValue.current = true;
      try {
        view.current.dispatch({
          changes: { from: 0, to: view.current.state.doc.length, insert: value },
        });
      } finally {
        applyingValue.current = false;
      }
    }
  }, [value, onChange, readOnly]);
  useEffect(() => {
    configureReadOnly.current?.(readOnly);
  }, [readOnly]);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      import('@codemirror/state'),
      import('@codemirror/view'),
      import('@codemirror/lang-python'),
      import('@codemirror/commands'),
    ])
      .then(([state, cm, lang, commands]) => {
        if (cancelled || !host.current) return;
        const editability = new state.Compartment();
        const editable = (readOnly: boolean) => [
          state.EditorState.readOnly.of(readOnly),
          cm.EditorView.editable.of(!readOnly),
        ];
        view.current = new cm.EditorView({
          parent: host.current,
          state: state.EditorState.create({
            doc: latest.current.value,
            extensions: [
              lang.python(),
              cm.lineNumbers(),
              cm.highlightActiveLine(),
              commands.history(),
              cm.keymap.of([...commands.defaultKeymap, ...commands.historyKeymap]),
              editability.of(editable(latest.current.readOnly)),
              state.EditorState.transactionFilter.of((transaction) =>
                transaction.newDoc.length <= BOARD_SOURCE_LIMITS.python ? transaction : [],
              ),
              cm.EditorView.contentAttributes.of({ 'aria-label': 'Исходный код Python' }),
              cm.EditorView.updateListener.of((update) => {
                if (update.docChanged && !latest.current.readOnly && !applyingValue.current)
                  latest.current.onChange(update.state.doc.toString());
              }),
            ],
          }),
        });
        configureReadOnly.current = (readOnly) =>
          view.current?.dispatch({ effects: editability.reconfigure(editable(readOnly)) });
        setReady(true);
      })
      .catch(() => {
        /* The accessible textarea remains a usable fallback. */
      });
    return () => {
      cancelled = true;
      view.current?.destroy();
      view.current = null;
      configureReadOnly.current = null;
    };
  }, []);
  return (
    <>
      <div ref={host} className="board-codemirror" hidden={!ready || fallbackFocused} />
      {!ready || fallbackFocused ? (
        <textarea
          className="board-python-fallback"
          aria-label="Исходный код Python"
          value={value}
          onChange={(e) => {
            // The lazy module promise can settle before React's value effect.
            latest.current.value = e.target.value;
            onChange(e.target.value);
          }}
          // Never replace an active input between focus and its native input
          // events, including a continuing IME composition or a fast paste.
          onFocus={() => setFallbackFocused(true)}
          onBlur={() => setFallbackFocused(false)}
          readOnly={readOnly}
          maxLength={BOARD_SOURCE_LIMITS.python}
          rows={10}
          spellCheck={false}
        />
      ) : null}
    </>
  );
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <div className="board-field">
      <label htmlFor={id}>{label}</label>
      {Children.map(children, (child) =>
        isValidElement<{ id?: string }>(child) ? cloneElement(child, { id }) : child,
      )}
    </div>
  );
}
function SubjectInspector({
  shape,
  editor,
  readOnly,
  mathDrafts,
  draftChanged,
  confirmApplied,
}: {
  shape: Exclude<BoardSubjectShape, PythonShape>;
  editor: Editor;
  readOnly: boolean;
  mathDrafts?: MathDraftBook;
  draftChanged?: () => void;
  confirmApplied?: () => void;
}) {
  const [fallbackBook] = useState(() => new MathDraftBook());
  const book = mathDrafts ?? fallbackBook;
  const asMath = (record: Exclude<BoardSubjectShape, PythonShape>): MathSubject => ({
    id: record.id,
    type: record.type,
    props: record.props as unknown as Record<string, MathValue>,
  });
  const entry = readOnly ? undefined : book.get(shape.id);
  const draft = (readOnly ? shape.props : book.view(asMath(shape))) as typeof shape.props;
  const numericDraft = entry?.numericDraft ?? {};
  const [error, setError] = useState('');
  let conflicts: string[] = [];
  if (entry) {
    try {
      conflicts = book.plan(shape.id, asMath(shape)).conflicts;
    } catch {
      /* Partial numeric input is validated on Apply. */
    }
  }
  function change(name: string, value: MathValue, numeric = false) {
    if (readOnly) return;
    try {
      const latest = latestShape();
      const current = latest?.type === shape.type ? latest : shape;
      if (numeric) book.setNumeric(asMath(current), name, String(value));
      else book.setField(asMath(current), name, value);
      setError('');
      draftChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Проверьте значения.');
    }
  }
  function latestShape() {
    const latest = editor.getShape(shape.id);
    return latest && isBoardSubjectShape(latest) && latest.type !== 'code-python'
      ? latest
      : undefined;
  }
  function field(name: string, label: string) {
    return (
      <Field label={label} key={name}>
        <input
          type="text"
          inputMode="decimal"
          value={numericDraft[name] ?? String((draft as unknown as Record<string, unknown>)[name])}
          onChange={(e) => change(name, e.target.value, true)}
          readOnly={readOnly}
        />
      </Field>
    );
  }
  function apply() {
    if (readOnly) return;
    try {
      const latest = latestShape();
      const plan = book.plan(shape.id, latest ? asMath(latest) : undefined);
      if (plan.conflicts.length) {
        setError('Другой участник изменил те же поля. Выберите способ разрешения конфликта.');
        return;
      }
      if (!latest || !Object.keys(plan.patch).length) return;
      validateBoardRecord({ ...latest, props: { ...latest.props, ...plan.patch } });
      editor.markHistoryStoppingPoint('Изменение математического объекта');
      editor.updateShape({ id: latest.id, type: latest.type, props: plan.patch } as TLShapePartial<
        Exclude<BoardSubjectShape, PythonShape>
      >);
      book.markApplied(shape.id, plan.patch);
      draftChanged?.();
      confirmApplied?.();
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Проверьте значения.');
    }
  }
  return (
    <div className="board-inspector-content">
      <h3>
        {shape.type === 'math-formula'
          ? 'Формула LaTeX'
          : shape.type === 'math-graph'
            ? 'График функции'
            : 'Геометрия'}
      </h3>
      {shape.type === 'math-formula' && 'source' in draft ? (
        <Field label="Исходная формула">
          <textarea
            value={draft.source}
            maxLength={BOARD_SOURCE_LIMITS.formula}
            rows={5}
            onChange={(e) => change('source', e.target.value)}
            readOnly={readOnly}
            spellCheck={false}
          />
        </Field>
      ) : null}
      {shape.type === 'math-graph' && 'expression' in draft ? (
        <>
          <Field label="y =">
            <input
              value={draft.expression}
              maxLength={512}
              onChange={(e) => change('expression', e.target.value)}
              readOnly={readOnly}
              spellCheck={false}
            />
          </Field>
          <p className="board-hint">
            x, a · + − * / ^ · sin, cos, sqrt, abs, exp, log. Углы в радианах.
          </p>
          {field('a', 'Параметр a')}
          <div className="board-fields-grid">
            {field('xMin', 'x от')}
            {field('xMax', 'x до')}
            {field('yMin', 'y от')}
            {field('yMax', 'y до')}
          </div>
        </>
      ) : null}
      {shape.type === 'math-geometry' && 'kind' in draft ? (
        <>
          <Field label="Фигура">
            <select
              value={draft.kind}
              onChange={(e) => change('kind', e.target.value)}
              disabled={readOnly}
            >
              <option value="triangle">Треугольник ABC</option>
              <option value="circle">Окружность</option>
            </select>
          </Field>
          <div className="board-fields-grid">
            {field('ax', 'A · x')}
            {field('ay', 'A · y')}
            {draft.kind === 'triangle' ? (
              <>
                {field('bx', 'B · x')}
                {field('by', 'B · y')}
                {field('cx', 'C · x')}
                {field('cy', 'C · y')}
              </>
            ) : (
              field('radius', 'Радиус')
            )}
          </div>
          <label className="board-check">
            <input
              type="checkbox"
              checked={draft.showLengths}
              onChange={(e) => change('showLengths', e.target.checked)}
              disabled={readOnly}
            />
            Длины
          </label>
          {draft.kind === 'triangle' ? (
            <label className="board-check">
              <input
                type="checkbox"
                checked={draft.showAngles}
                onChange={(e) => change('showAngles', e.target.checked)}
                disabled={readOnly}
              />
              Углы
            </label>
          ) : null}
        </>
      ) : null}
      {!readOnly && conflicts.length ? (
        <div className="board-conflict" role="status">
          <p>
            Другой участник изменил те же поля: {conflicts.join(', ')}. Черновик сохранён.
            Перечитайте доску или оставьте свои значения, затем нажмите «Применить».
          </p>
          <details>
            <summary>Текущие значения на доске</summary>
            <pre>
              {JSON.stringify(
                Object.fromEntries(
                  conflicts.map((key) => [
                    key,
                    (shape.props as unknown as Record<string, MathValue>)[key],
                  ]),
                ),
                null,
                2,
              )}
            </pre>
          </details>
          <button
            className="board-secondary"
            onClick={() => {
              try {
                const latest = latestShape();
                book.rebase(shape.id, latest ? asMath(latest) : undefined);
                draftChanged?.();
                setError('');
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Объект недоступен.');
              }
            }}
          >
            Оставить мои значения
          </button>
        </div>
      ) : null}
      {entry ? (
        <p className="board-hint" role="status">
          {Object.keys(entry.applied).length
            ? 'Изменения применены. Черновик остаётся до подтверждения записи.'
            : 'Есть локальный черновик. Нажмите «Применить» или экспортируйте его.'}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="board-error">
          {error}
        </p>
      ) : null}
      {!readOnly ? (
        <div className="board-button-row">
          <button onClick={apply}>Применить</button>
          <button
            className="board-secondary"
            onClick={() => {
              book.discard(shape.id);
              draftChanged?.();
              setError('');
            }}
          >
            Перечитать с доски
          </button>
        </div>
      ) : null}
      <p className="board-hint">
        Исходные данные сохраняются вместе с объектом. Размер и положение меняются на доске.
      </p>
    </div>
  );
}
function PythonInspector({
  shape,
  boardId,
  readOnly,
  drafts,
  draftChanged,
  documentConfirmed = true,
}: {
  shape: PythonShape;
  boardId: string;
  readOnly: boolean;
  drafts: Map<string, PythonDraft>;
  draftChanged: () => void;
  documentConfirmed?: boolean;
}) {
  const [draft, setDraft] = useState<PythonDraft>(
    () =>
      drafts.get(shape.id) ?? {
        source: shape.props.source,
        baseSource: shape.props.source,
        expectedVersion: shape.props.version,
      },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const remoteChanged = shape.props.version > draft.expectedVersion;
  const dirty = draft.source !== draft.baseSource;
  function remember(next: PythonDraft) {
    setDraft(next);
    if (next.source !== next.baseSource) drafts.set(shape.id, next);
    else drafts.delete(shape.id);
    draftChanged();
  }
  async function apply() {
    if (busy || readOnly || !documentConfirmed || !dirty) return;
    setBusy(true);
    setError('');
    const submitted = { ...draft };
    try {
      const response = await fetch(
        `/api/board-access/${encodeURIComponent(boardId)}/code/${encodeURIComponent(shape.id)}`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            expectedVersion: submitted.expectedVersion,
            source: submitted.source,
          }),
        },
      );
      if (response.status === 409) {
        setConflict(true);
        throw new Error('Код изменён другим участником. Ваш черновик сохранён здесь.');
      }
      if (!response.ok)
        throw new Error(
          response.status === 404
            ? 'Блок удалён или доступ закрыт. Экспортируйте черновик.'
            : 'Не удалось применить код. Черновик сохранён здесь.',
        );
      const result = (await response.json()) as { version: number };
      if (!Number.isSafeInteger(result.version) || result.version <= submitted.expectedVersion)
        throw new Error('Не удалось проверить подтверждение версии.');
      remember({
        source: submitted.source,
        baseSource: submitted.source,
        expectedVersion: result.version,
      });
      setConflict(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось применить код.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="board-inspector-content">
      <h3>
        Python <small>версия {shape.props.version}</small>
      </h3>
      <PythonInput
        value={readOnly ? shape.props.source : draft.source}
        onChange={(source) => remember({ ...draft, source })}
        readOnly={readOnly || busy}
      />
      <p className="board-hint">Код хранится как учебный материал. Выполнение не подключено.</p>
      {remoteChanged || conflict ? (
        <div className="board-conflict" role="status">
          <p>
            На доске есть другая версия. Одновременные изменения применяются целыми версиями;
            объедините текст вручную.
          </p>
          <details>
            <summary>Текущий код на доске</summary>
            <pre>{shape.props.source || '(пусто)'}</pre>
          </details>
          {!readOnly ? (
            <div className="board-button-row">
              <button
                className="board-secondary"
                onClick={() => {
                  remember({
                    source: shape.props.source,
                    baseSource: shape.props.source,
                    expectedVersion: shape.props.version,
                  });
                  setConflict(false);
                  setError('');
                }}
              >
                Загрузить текущий
              </button>
              <button
                className="board-secondary"
                onClick={() => {
                  remember({
                    ...draft,
                    baseSource: shape.props.source,
                    expectedVersion: shape.props.version,
                  });
                  setConflict(false);
                }}
              >
                Использовать моё объединение
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="board-error">
          {error}
        </p>
      ) : null}
      {!readOnly ? (
        <button
          onClick={() => void apply()}
          disabled={
            busy || !documentConfirmed || !dirty || draft.source.length > BOARD_SOURCE_LIMITS.python
          }
        >
          {busy ? 'Применяем…' : 'Применить код'}
        </button>
      ) : null}
      {dirty ? (
        <p className="board-hint" role="status">
          Есть локальный черновик. Нажмите «Применить код» или экспортируйте его.
        </p>
      ) : null}
      {dirty && !documentConfirmed ? (
        <p className="board-hint" role="status">
          Дождитесь подтверждения объекта доски. Черновик кода остаётся здесь.
        </p>
      ) : null}
    </div>
  );
}

export default function BoardEditor(props: BoardEditorProps) {
  return <BoardEditorSession key={props.boardId} {...props} />;
}
function useBoardColorScheme() {
  const [colorScheme, setColorScheme] = useState<'light' | 'dark'>(() =>
    document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
  );
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setColorScheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'),
    );
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);
  return colorScheme;
}

/** Immutable history has its own local store and never starts a live sync connection. */
export function BoardSnapshotViewer({
  snapshot,
  licenseKey,
}: {
  snapshot: unknown;
  licenseKey?: string;
}) {
  const prepared = useMemo(() => {
    try {
      return {
        store: createTLStore({
          schema: boardSchema,
          snapshot: toBoardStoreSnapshot(snapshot),
          assets: localAssets,
        }),
        error: '',
      };
    } catch (error) {
      return {
        store: null,
        error: error instanceof Error ? error.message : 'Не удалось открыть версию.',
      };
    }
  }, [snapshot]);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [drafts] = useState(() => new Map<string, PythonDraft>());
  const colorScheme = useBoardColorScheme();
  const selected = useValue('saved subject', () => editor?.getOnlySelectedShape() ?? null, [
    editor,
  ]);
  const mount = useCallback((mounted: Editor) => {
    mounted.updateInstanceState({ isReadonly: true });
    mounted.user.updateUserPreferences({ locale: 'ru' });
    mounted.zoomToFit({ animation: { duration: 0 } });
    setEditor(mounted);
  }, []);
  const subject = selected && isBoardSubjectShape(selected) ? selected : null;
  if (!prepared.store)
    return (
      <div className="board-editor board-unavailable" role="alert">
        {prepared.error}
      </div>
    );
  return (
    <div className="board-editor" data-testid="board-snapshot-viewer" data-dirty="false">
      <div className="board-editor-bar">
        <div className="board-connection" role="status">
          Сохранённая версия · только просмотр
        </div>
      </div>
      <div className="board-editor-workspace">
        <div className="board-canvas" aria-label="Сохранённая версия учебной доски">
          <Tldraw
            store={prepared.store}
            shapeUtils={shapeUtils}
            assetUrls={assetUrls}
            licenseKey={licenseKey}
            onMount={mount}
            colorScheme={colorScheme}
            overrides={uiOverrides}
            acceptedImageMimeTypes={imageTypes}
            acceptedVideoMimeTypes={videoTypes}
          />
        </div>
        {subject && editor ? (
          <aside
            className="board-inspector"
            aria-label="Данные сохранённого объекта"
            onKeyDown={(event) => event.stopPropagation()}
          >
            {subject.type === 'code-python' ? (
              <PythonInspector
                key={subject.id}
                shape={subject}
                boardId=""
                readOnly
                drafts={drafts}
                draftChanged={() => {}}
              />
            ) : (
              <SubjectInspector key={subject.id} shape={subject} editor={editor} readOnly />
            )}
          </aside>
        ) : null}
      </div>
    </div>
  );
}
function BoardEditorSession({ boardId, role, licenseKey }: BoardEditorProps) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [progress, setProgress] = useState(initialProgress);
  const progressRef = useRef(initialProgress);
  const lastStore = useRef<TLStore | null>(null);
  const contentProof = useRef<BoardContentProof | null>(null);
  const proofStateRef = useRef<BoardProofState>(INITIAL_BOARD_PROOF_STATE);
  const [proofView, setProofView] = useState<{ store: TLStore | null; state: BoardProofState }>({
    store: null,
    state: INITIAL_BOARD_PROOF_STATE,
  });
  const [drafts] = useState(() => new Map<string, PythonDraft>());
  const [mathDrafts] = useState(() => new MathDraftBook());
  const [knownCodeIds] = useState(() => new Set<string>());
  const initialViewPlaced = useRef(false);
  const colorScheme = useBoardColorScheme();
  const [draftVersion, setDraftVersion] = useState(0);
  const [exportError, setExportError] = useState('');
  const updateProgress = useCallback((patch: Partial<SyncProgress>) => {
    progressRef.current = { ...progressRef.current, ...patch };
    setProgress(progressRef.current);
  }, []);
  const connect = useCallback(
    ({ sessionId, storeId }: { sessionId: string; storeId: string }) => {
      const uri = new URL(
        `/api/board-access/${encodeURIComponent(boardId)}/sync`,
        window.location.href,
      );
      uri.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      uri.searchParams.set('sessionId', sessionId);
      uri.searchParams.set('storeId', storeId);
      const adapter = new NativeClientWebSocketAdapter(() => uri.href);
      const pending = new Set<number>();
      const send = adapter.sendMessage.bind(adapter);
      adapter.sendMessage = (rawMessage) => {
        const message = rawMessage as ObservedNativeMessage;
        if (
          message.type === 'push' &&
          typeof message.clientClock === 'number' &&
          message.diff &&
          Object.keys(message.diff).length
        ) {
          pending.add(message.clientClock);
          updateProgress({ pending: pending.size });
          contentProof.current?.setTransportPending(pending.size);
        }
        send(rawMessage);
      };
      const remove = adapter.onReceiveMessage((rawMessage) => {
        const message = rawMessage as ObservedNativeMessage;
        if (message.type === 'connect') {
          pending.clear();
          updateProgress({ pending: 0 });
          contentProof.current?.setTransportPending(0);
          contentProof.current?.requestCheck();
          return;
        }
        const events = message.type === 'data' ? (message.data ?? []) : [message];
        for (const event of events) {
          if (
            event.type !== 'push_result' ||
            typeof event.clientClock !== 'number' ||
            !pending.has(event.clientClock)
          )
            continue;
          pending.delete(event.clientClock);
          if (event.action === 'discard') updateProgress({ pending: pending.size, rejected: true });
          else
            updateProgress({
              pending: pending.size,
              ackAt: Date.now(),
            });
          contentProof.current?.setTransportPending(pending.size);
          contentProof.current?.requestCheck();
        }
      });
      const close = adapter.close.bind(adapter);
      adapter.close = () => {
        remove();
        close();
      };
      return adapter;
    },
    [boardId, updateProgress],
  );
  const users = useMemo(
    () => ({
      currentUser: atom(
        'anonymous board participant',
        role === 'viewer'
          ? null
          : UserRecordType.create({
              id: createUserId(crypto.randomUUID()),
              name: role === 'owner' ? 'Преподаватель' : 'Участник',
              color: '#7763d6',
            }),
      ),
    }),
    [role],
  );
  const synced = useSync({ connect, schema: boardSchema, assets: localAssets, users });
  const selected = useValue('selected subject', () => editor?.getOnlySelectedShape() ?? null, [
    editor,
  ]);
  const readOnly = role === 'viewer';
  const connectedStore = synced.status === 'synced-remote' ? synced.store : null;
  const connected = synced.status === 'synced-remote' && synced.connectionStatus === 'online';
  const proofState =
    proofView.store === connectedStore ? proofView.state : INITIAL_BOARD_PROOF_STATE;
  useEffect(() => {
    if (!connectedStore) return;
    lastStore.current = connectedStore;
    const proof = new BoardContentProof({
      readRecords: () => Object.values(connectedStore.getStoreSnapshot('document').store),
      async fetchStatus(signal) {
        const response = await fetch(`/api/board-access/${encodeURIComponent(boardId)}/status`, {
          credentials: 'same-origin',
          cache: 'no-store',
          signal,
        });
        if (!response.ok) throw new Error('Не удалось проверить запись.');
        return (await response.json()) as DurableBoardStatus;
      },
      onChange(state) {
        if (state.confirmed) {
          const records = Object.values(connectedStore.getStoreSnapshot('document').store);
          const mathRecords = records.filter(
            (record) =>
              record.typeName === 'shape' &&
              isBoardSubjectShape(record) &&
              record.type !== 'code-python',
          ) as unknown as MathSubject[];
          if (mathDrafts.confirm(mathRecords)) setDraftVersion((version) => version + 1);
          for (const record of records)
            if (record.typeName === 'shape' && record.type === 'code-python')
              knownCodeIds.add(record.id);
        }
        proofStateRef.current = state;
        setProofView({ store: connectedStore, state });
      },
    });
    contentProof.current = proof;
    proof.setTransportPending(progressRef.current.pending);
    const remove: (() => void)[] = [];
    for (const typeName of connectedStore.scopedTypes.document) {
      remove.push(
        connectedStore.sideEffects.registerAfterCreateHandler(typeName, (_record, source) =>
          proof.changed(source),
        ),
      );
      remove.push(
        connectedStore.sideEffects.registerAfterChangeHandler(typeName, (_before, _after, source) =>
          proof.changed(source),
        ),
      );
      remove.push(
        connectedStore.sideEffects.registerAfterDeleteHandler(typeName, (_record, source) =>
          proof.changed(source),
        ),
      );
    }
    return () => {
      remove.forEach((dispose) => dispose());
      proof.dispose();
      if (contentProof.current === proof) contentProof.current = null;
    };
  }, [connectedStore, boardId, mathDrafts, knownCodeIds]);
  useEffect(() => {
    contentProof.current?.setConnected(connected);
  }, [connected, connectedStore]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (
        proofStateRef.current.dirty ||
        progressRef.current.pending ||
        drafts.size ||
        mathDrafts.size
      ) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [drafts, mathDrafts]);
  const mount = useCallback(
    (mounted: Editor) => {
      mounted.updateInstanceState({ isReadonly: role === 'viewer' });
      mounted.user.updateUserPreferences({ locale: 'ru' });
      mounted.registerExternalContentHandler('url', null);
      mounted.registerExternalContentHandler('embed', null);
      mounted.registerExternalAssetHandler('url', null);
      // The sync store is hydrated before native onMount. Show saved material on
      // first open, including phones; later reconnects/theme changes keep the camera.
      if (!initialViewPlaced.current) {
        initialViewPlaced.current = true;
        if (mounted.getCurrentPageShapeIds().size)
          mounted.zoomToFit({ animation: { duration: 0 } });
      }
      setEditor(mounted);
    },
    [role],
  );
  useEffect(() => {
    editor?.updateInstanceState({ isReadonly: readOnly });
  }, [editor, readOnly]);
  function add(type: BoardSubjectShape['type']) {
    if (!editor || readOnly) return;
    const id = createShapeId();
    const center = editor.getViewportPageBounds().center;
    editor.markHistoryStoppingPoint('Новый учебный объект');
    editor.createShape({ id, type, x: center.x - 180, y: center.y - 120 });
    editor.setCurrentTool('select');
    editor.select(id);
  }
  function exportRecovery() {
    try {
      const store = lastStore.current;
      const localSnapshot = store ? store.getStoreSnapshot('document') : null;
      const payload = {
        format: 'tutorflow-board-recovery',
        version: 1,
        board: localSnapshot
          ? {
              format: 'tutorflow-board',
              version: 1,
              engine: 'tldraw',
              engineVersion: '5.6.0',
              schemaVersion: 1,
              document: {
                documents: Object.values(localSnapshot.store).map((state) => ({
                  state,
                  lastChangedClock: 0,
                })),
                schema: localSnapshot.schema,
                clock: 0,
                documentClock: 0,
                tombstones: {},
                tombstoneHistoryStartsAtClock: 0,
              },
            }
          : null,
        exportedAt: new Date().toISOString(),
        pythonDrafts: Object.fromEntries(drafts),
        mathDrafts: Object.fromEntries(mathDrafts.drafts),
        unconfirmedChanges: proofStateRef.current.dirty || progressRef.current.pending > 0,
      };
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
      );
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `tutorflow-board-${boardId}-recovery.json`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setExportError('');
    } catch {
      setExportError(
        'Не удалось экспортировать доску. Оставьте страницу открытой и скопируйте локальные черновики.',
      );
    }
  }
  const dirty = proofState.dirty || progress.pending > 0;
  const status =
    synced.status === 'error'
      ? 'Ошибка синхронизации'
      : progress.rejected
        ? 'Сервер отклонил изменения'
        : synced.status === 'loading'
          ? 'Подключаем доску…'
          : synced.connectionStatus === 'offline'
            ? dirty
              ? 'Нет соединения · изменения ожидают отправки'
              : 'Нет соединения'
            : dirty
              ? 'Есть изменения · ожидаем подтверждения'
              : proofState.failed
                ? 'Не удалось проверить запись'
                : mathDrafts.size || drafts.size
                  ? 'Есть неприменённые черновики'
                  : proofState.confirmed
                    ? 'Изменения подтверждены сервером'
                    : 'Проверяем содержимое доски…';
  const subject = selected && isBoardSubjectShape(selected) ? selected : null;
  return (
    <div
      className="board-editor"
      data-testid="board-editor"
      data-dirty={dirty || drafts.size > 0 || mathDrafts.size > 0}
      data-confirmed-fingerprint={
        connected &&
        !progress.rejected &&
        !dirty &&
        !drafts.size &&
        !mathDrafts.size &&
        proofState.confirmed
          ? (proofState.fingerprint ?? undefined)
          : undefined
      }
      data-proof={
        proofState.confirmed
          ? 'confirmed'
          : proofState.checking
            ? 'checking'
            : proofState.failed
              ? 'failed'
              : 'unconfirmed'
      }
      data-confirmed-clock={
        proofState.confirmed ? (proofState.documentClock ?? undefined) : undefined
      }
      data-ack-at={progress.ackAt ?? undefined}
      data-draft-version={draftVersion}
    >
      <div className="board-editor-bar">
        <div className="board-connection" role="status" aria-live="polite">
          <span
            className={
              synced.status === 'error' || progress.rejected
                ? 'board-dot board-dot-error'
                : dirty
                  ? 'board-dot board-dot-pending'
                  : 'board-dot'
            }
          />
          {status}
          {role !== 'owner' ? (
            <span className="board-viewer-label">
              {readOnly ? 'Только просмотр' : 'Гость · редактирование'}
            </span>
          ) : null}
          {mathDrafts.size ? (
            <span className="board-viewer-label">Черновики математики: {mathDrafts.size}</span>
          ) : null}
          {drafts.size ? (
            <span className="board-viewer-label">Черновики Python: {drafts.size}</span>
          ) : null}
        </div>
        {proofState.failed && connected ? (
          <button className="board-secondary" onClick={() => contentProof.current?.requestCheck()}>
            Проверить запись
          </button>
        ) : null}
        <button className="board-secondary" onClick={exportRecovery}>
          Экспорт для восстановления
        </button>
      </div>
      {exportError ? (
        <p role="alert" className="board-error">
          {exportError}
        </p>
      ) : null}
      {synced.status === 'error' || progress.rejected ? (
        <div className="board-recovery" role="alert">
          <strong>Не удалось подтвердить изменения.</strong>
          <p>
            Оставьте страницу открытой, экспортируйте доступную копию и локальные черновики. После
            экспорта можно перезагрузить доску.
          </p>
          <button className="board-secondary" onClick={() => window.location.reload()}>
            Перезагрузить
          </button>
        </div>
      ) : null}
      {!readOnly ? (
        <div className="board-add-bar" aria-label="Добавить учебный объект">
          <span>Добавить</span>
          <button
            onClick={() => add('math-formula')}
            disabled={!editor || synced.status === 'error' || progress.rejected}
          >
            Формулу
          </button>
          <button
            onClick={() => add('math-graph')}
            disabled={!editor || synced.status === 'error' || progress.rejected}
          >
            График
          </button>
          <button
            onClick={() => add('math-geometry')}
            disabled={!editor || synced.status === 'error' || progress.rejected}
          >
            Геометрию
          </button>
          <button
            onClick={() => add('code-python')}
            disabled={!editor || synced.status === 'error' || progress.rejected}
          >
            Python
          </button>
        </div>
      ) : null}
      <div className="board-editor-workspace">
        <div className="board-canvas" aria-label="Совместная учебная доска">
          {synced.status !== 'error' ? (
            <Tldraw
              store={synced}
              shapeUtils={shapeUtils}
              assetUrls={assetUrls}
              licenseKey={licenseKey}
              onMount={mount}
              colorScheme={colorScheme}
              overrides={uiOverrides}
              acceptedImageMimeTypes={imageTypes}
              acceptedVideoMimeTypes={videoTypes}
              maxAssetSize={175_000}
              maxImageDimension={1600}
            />
          ) : (
            <div className="board-unavailable">
              Соединение с доской недоступно. Воспользуйтесь восстановлением выше.
            </div>
          )}
        </div>
        {subject && editor && synced.status !== 'error' ? (
          <aside
            className="board-inspector"
            aria-label="Данные выбранного объекта"
            onKeyDown={(event) => event.stopPropagation()}
          >
            {subject.type === 'code-python' ? (
              <PythonInspector
                key={subject.id}
                shape={subject}
                boardId={boardId}
                readOnly={readOnly}
                drafts={drafts}
                draftChanged={() => setDraftVersion((v) => v + 1)}
                documentConfirmed={connected && knownCodeIds.has(subject.id)}
              />
            ) : (
              <SubjectInspector
                key={readOnly ? `${subject.id}:${JSON.stringify(subject.props)}` : subject.id}
                shape={subject}
                editor={editor}
                readOnly={readOnly}
                mathDrafts={mathDrafts}
                draftChanged={() => setDraftVersion((version) => version + 1)}
                confirmApplied={() => contentProof.current?.requestCheck()}
              />
            )}
          </aside>
        ) : null}
      </div>
    </div>
  );
}
