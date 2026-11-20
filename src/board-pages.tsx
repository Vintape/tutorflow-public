import { Component, lazy, Suspense, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowUpRight,
  Copy,
  Download,
  History,
  Link2,
  Plus,
  Presentation,
  Settings2,
  Share2,
  Trash2,
  Unlink,
} from 'lucide-react';
import { toast } from 'sonner';
import type {
  Board,
  BoardInvitation,
  BoardLinkInput,
  BoardLinks,
  BoardRole,
  LessonBoard,
} from '../shared/boards';
import type { Lesson, LessonDetail, Student } from '../shared/domain';
import {
  Button,
  Confirm,
  Empty,
  ErrorState,
  Field,
  Loading,
  Modal,
  PageHeader,
} from './components';
import { ApiError, api, dateTime, errorMessage, useApi, useTask, useWorkspace } from './lib';
import './board-pages.css';
import { BoardNavigationGuard, leaveConfirmedBoard } from './board-navigation-guard';

const BoardEditor = lazy(() => import('./board-editor'));
const BoardSnapshotViewer = lazy(() =>
  import('./board-editor').then((module) => ({ default: module.BoardSnapshotViewer })),
);
interface BoardAccess {
  boardId: string;
  title: string;
  role: 'owner' | BoardRole;
  expiresAt?: string;
  licenseKey?: string;
}
interface BoardVersion {
  id: string;
  label: string;
  createdAt: string;
}
interface SnapshotExport {
  format: 'tutorflow-board';
  version: 1;
  document: unknown;
}
interface LessonContext {
  lessonId: string;
  studentId: string;
  label: string;
}
const roles = { owner: 'Владелец', editor: 'Редактирование', viewer: 'Только просмотр' };

function canLeaveBoard() {
  return (
    !document.querySelector('.board-editor-region [data-dirty="true"]') ||
    window.confirm(
      'На доске есть неподтверждённые изменения или черновики. Перед выходом можно сохранить файл восстановления в редакторе. Покинуть доску?',
    )
  );
}

async function downloadJson(path: string, filename: string) {
  const document = await api<unknown>(path);
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' }),
  );
  const anchor = window.document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  window.document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    URL.revokeObjectURL(url);
  }
}

export function BoardsPage() {
  const [query] = useSearchParams();
  const lessonId = query.get('lessonId');
  return lessonId ? <LessonBoardLibrary key={lessonId} lessonId={lessonId} /> : <BoardLibrary />;
}

function LessonBoardLibrary({ lessonId }: { lessonId: string }) {
  const { me } = useWorkspace();
  const lesson = useApi<LessonDetail>(`/api/lessons/${encodeURIComponent(lessonId)}`);
  if (lesson.loading) return <Loading />;
  if (lesson.error || !lesson.data) return <ErrorState text={lesson.error} retry={lesson.reload} />;
  return (
    <BoardLibrary
      context={{
        lessonId: lesson.data.lesson.id,
        studentId: lesson.data.lesson.studentId,
        label: `${lesson.data.lesson.studentName} · ${dateTime(lesson.data.lesson.startsAt, me.settings.timezone)}`,
      }}
    />
  );
}

function BoardLibrary({ context }: { context?: LessonContext }) {
  const { revision, me } = useWorkspace();
  const boards = useApi<Board[]>('/api/boards', revision);
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [search, setSearch] = useState('');
  const request = useRef<{ title: string; id: string } | null>(null);
  const { busy, run } = useTask();
  async function create(event: FormEvent) {
    event.preventDefault();
    await run(async () => {
      const name = title.trim();
      if (!name) return;
      if (!request.current || request.current.title !== name)
        request.current = { title: name, id: crypto.randomUUID() };
      const board = await api<Board>('/api/boards', 'POST', {
        title: name,
        requestId: request.current.id,
      });
      if (context)
        await api(`/api/boards/${board.id}/links`, 'POST', {
          lessonId: context.lessonId,
          studentId: context.studentId,
        });
      navigate(
        context
          ? `/boards/${board.id}?${new URLSearchParams({ lessonId: context.lessonId })}`
          : `/boards/${board.id}`,
      );
    });
  }
  async function resume(board: Board) {
    await run(async () => {
      await api('/api/boards', 'POST', { title: board.title, requestId: board.requestId });
      boards.reload();
      navigate(`/boards/${board.id}`);
    });
  }
  const visible = boards.data?.filter((board) =>
    board.title.toLocaleLowerCase('ru').includes(search.toLocaleLowerCase('ru')),
  );
  return (
    <>
      {context && (
        <Link className="back-link" to={`/lessons/${context.lessonId}`}>
          <ArrowLeft size={15} />К занятию
        </Link>
      )}
      <PageHeader
        eyebrow="УЧЕБНЫЕ МАТЕРИАЛЫ"
        title={context ? 'Доска для занятия' : 'Мои доски'}
        description={
          context
            ? context.label
            : 'Возвращайтесь к материалам, продолжайте работу или начинайте с независимой копии.'
        }
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus size={17} />
            Создать доску
          </Button>
        }
      />
      {context && (
        <div className="board-context-note">
          Создайте новую доску или явно свяжите существующую с этим занятием. Открытие доски само по
          себе не меняет связи.
        </div>
      )}
      <div className="board-library-search">
        <Field label="Найти доску">
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Название доски"
          />
        </Field>
      </div>
      {boards.loading ? (
        <Loading />
      ) : boards.error || !boards.data ? (
        <ErrorState text={boards.error} retry={boards.reload} />
      ) : !visible?.length ? (
        <Empty
          icon={Presentation}
          title={search ? 'Доски не найдены' : 'Здесь будут ваши доски'}
          text={
            search
              ? 'Попробуйте другое название.'
              : 'Одна доска может сопровождать несколько занятий. Её материалы сохраняются отдельно от расписания.'
          }
          action={
            !search && (
              <Button onClick={() => setCreating(true)}>
                <Plus size={16} />
                Создать первую доску
              </Button>
            )
          }
        />
      ) : (
        <div className="board-library-grid">
          {visible.map((board) => (
            <BoardCard
              key={board.id}
              board={board}
              context={context}
              timezone={me.settings.timezone}
              busy={busy}
              onResume={() => void resume(board)}
            />
          ))}
        </div>
      )}
      <Modal
        open={creating}
        onClose={() => {
          if (!busy) setCreating(false);
        }}
        title="Новая доска"
        description={
          context
            ? 'После создания доска будет связана с этим занятием и учеником.'
            : 'Дайте материалам понятное название.'
        }
      >
        <form className="form" onSubmit={create}>
          <Field label="Название доски">
            <input
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              required
              maxLength={200}
              placeholder="Например, квадратные уравнения"
              disabled={busy}
            />
          </Field>
          <div className="form-actions">
            <Button
              variant="secondary"
              type="button"
              onClick={() => setCreating(false)}
              disabled={busy}
            >
              Отмена
            </Button>
            <Button type="submit" busy={busy}>
              {context ? 'Создать и связать' : 'Создать доску'}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}

function BoardCard({
  board,
  context,
  timezone,
  busy,
  onResume,
}: {
  board: Board;
  context?: LessonContext;
  timezone: string;
  busy: boolean;
  onResume: () => void;
}) {
  return (
    <article className="board-library-card panel">
      <div className="board-library-symbol">
        <Presentation size={26} strokeWidth={1.5} />
      </div>
      <h2>
        {context || board.state !== 'ACTIVE' ? (
          board.title
        ) : (
          <Link to={`/boards/${board.id}`}>{board.title}</Link>
        )}
      </h2>
      <p className="muted">Изменена {dateTime(board.updatedAt, timezone)}</p>
      {board.state === 'CREATING' ? (
        <Button variant="secondary" busy={busy} onClick={onResume}>
          Продолжить создание
        </Button>
      ) : (
        <>
          {!context && (
            <Link className="board-open-link" to={`/boards/${board.id}`}>
              Открыть доску
              <ArrowUpRight size={16} />
            </Link>
          )}
          {context && <ContextBoardLink boardId={board.id} context={context} />}
        </>
      )}
    </article>
  );
}

function ContextBoardLink({ boardId, context }: { boardId: string; context: LessonContext }) {
  const links = useApi<BoardLinks>(`/api/boards/${boardId}/links`);
  const { busy, run } = useTask();
  const linked = links.data?.lessons.find((link) => link.lessonId === context.lessonId);
  if (links.loading)
    return (
      <p className="board-small-note" role="status">
        Проверяем связь с занятием…
      </p>
    );
  if (links.error)
    return (
      <Button variant="ghost" onClick={links.reload}>
        Повторить проверку связи
      </Button>
    );
  return (
    <>
      <Link
        className="board-open-link"
        to={
          linked?.snapshotId
            ? `/boards/${boardId}?version=${encodeURIComponent(linked.snapshotId)}`
            : `/boards/${boardId}`
        }
      >
        {linked?.snapshotId ? 'Открыть версию занятия' : 'Открыть доску'}
        <ArrowUpRight size={16} />
      </Link>
      {linked ? (
        <span className="board-linked-badge">
          <Link2 size={14} />
          {linked.snapshotId ? 'Связана версия занятия' : 'Связана с занятием'}
        </span>
      ) : (
        <Button
          variant="secondary"
          busy={busy}
          onClick={() =>
            void run(async () => {
              await api(`/api/boards/${boardId}/links`, 'POST', {
                lessonId: context.lessonId,
                studentId: context.studentId,
              });
              links.reload();
              toast.success('Доска связана с занятием');
            })
          }
        >
          <Link2 size={15} />
          Связать с этим занятием
        </Button>
      )}
    </>
  );
}

class EditorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div className="board-canvas-message">
        <ErrorState
          text="Не удалось открыть редактор. Проверьте соединение и повторите загрузку."
          retry={() => window.location.reload()}
        />
      </div>
    ) : (
      this.props.children
    );
  }
}

function Canvas({ access }: { access: BoardAccess }) {
  return (
    <main className="board-editor-region" aria-label="Рабочая область доски">
      <BoardNavigationGuard boardId={access.boardId} />
      <EditorBoundary>
        <Suspense
          fallback={
            <div className="board-canvas-message">
              <Loading />
              <p>Открываем доску…</p>
            </div>
          }
        >
          <BoardEditor boardId={access.boardId} role={access.role} licenseKey={access.licenseKey} />
        </Suspense>
      </EditorBoundary>
    </main>
  );
}

export function BoardPage() {
  const { id = '' } = useParams();
  const [query] = useSearchParams();
  const versionId = query.get('version');
  const lessonId = query.get('lessonId') || undefined;
  return versionId ? (
    <SnapshotBoard key={`${id}:${versionId}`} id={id} versionId={versionId} lessonId={lessonId} />
  ) : (
    <OwnerBoard key={id} id={id} lessonId={lessonId} />
  );
}

function SnapshotBoard({
  id,
  versionId,
  lessonId,
}: {
  id: string;
  versionId: string;
  lessonId?: string;
}) {
  const navigate = useNavigate();
  const { me } = useWorkspace();
  const board = useApi<Board>(`/api/boards/${encodeURIComponent(id)}`);
  const access = useApi<BoardAccess>(`/api/board-access/${encodeURIComponent(id)}/session`);
  const versions = useApi<BoardVersion[]>(`/api/boards/${encodeURIComponent(id)}/versions`);
  const document = useApi<SnapshotExport>(
    `/api/boards/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}/export`,
  );
  const operation = useRef<string | null>(null);
  const { busy, run } = useTask();
  if (board.loading || access.loading || document.loading)
    return (
      <div className="board-page-loading">
        <Loading />
      </div>
    );
  if (
    board.error ||
    access.error ||
    document.error ||
    !board.data ||
    !access.data ||
    !document.data
  )
    return (
      <div className="board-page-loading">
        <Link className="back-link" to={`/boards/${id}`}>
          <ArrowLeft size={15} />К текущей доске
        </Link>
        <ErrorState
          text={board.error || access.error || document.error}
          retry={() => {
            board.reload();
            access.reload();
            versions.reload();
            document.reload();
          }}
        />
      </div>
    );
  const version = versions.data?.find((item) => item.id === versionId);
  return (
    <div className="board-fullscreen board-snapshot">
      <header className="board-topbar">
        <Link
          className="board-back"
          to={lessonId ? `/lessons/${encodeURIComponent(lessonId)}` : `/boards/${id}`}
        >
          <ArrowLeft size={19} />
          <span>Текущая доска</span>
        </Link>
        <div className="board-topbar-title">
          <h1>{version?.label || 'Сохранённая версия'}</h1>
          <span>
            {board.data.title} · Только просмотр
            {version ? ` · ${dateTime(version.createdAt, me.settings.timezone)}` : ''}
          </span>
        </div>
        <div className="board-snapshot-actions">
          <Button
            variant="secondary"
            busy={busy}
            onClick={() =>
              void run(() =>
                downloadJson(
                  `/api/boards/${id}/versions/${versionId}/export`,
                  `tutorflow-version-${versionId}.json`,
                ),
              )
            }
          >
            <Download size={16} />
            JSON
          </Button>
          <Button
            busy={busy}
            onClick={() =>
              void run(async () => {
                operation.current ??= crypto.randomUUID();
                const created = await api<Board>(`/api/boards/${id}/copy`, 'POST', {
                  requestId: operation.current,
                  snapshotId: versionId,
                  title: `${board.data!.title.slice(0, 95)} — ${(version?.label || 'версия').slice(0, 95)}`,
                });
                navigate(`/boards/${created.id}`);
                toast.success('Открыта независимая копия сохранённой версии');
              })
            }
          >
            <Copy size={16} />
            Восстановить копией
          </Button>
        </div>
      </header>
      <div className="board-snapshot-notice" role="status">
        <History size={15} />
        Сохранённая версия не изменяется. Чтобы продолжить работу с ней, создайте копию.
      </div>
      <main className="board-editor-region" aria-label="Сохранённая версия доски">
        <EditorBoundary>
          <Suspense
            fallback={
              <div className="board-canvas-message">
                <Loading />
                <p>Открываем сохранённую версию…</p>
              </div>
            }
          >
            <BoardSnapshotViewer
              snapshot={document.data.document}
              licenseKey={access.data.licenseKey}
            />
          </Suspense>
        </EditorBoundary>
      </main>
    </div>
  );
}

function OwnerBoard({ id, lessonId }: { id: string; lessonId?: string }) {
  const board = useApi<Board>(`/api/boards/${encodeURIComponent(id)}`);
  const access = useApi<BoardAccess>(`/api/board-access/${encodeURIComponent(id)}/session`);
  const [management, setManagement] = useState(false);
  const [renamed, setRenamed] = useState<Board | null>(null);
  if (board.loading || access.loading)
    return (
      <div className="board-page-loading">
        <Loading />
      </div>
    );
  if (board.error || access.error || !board.data || !access.data)
    return (
      <div className="board-page-loading">
        <Link className="back-link" to="/boards">
          <ArrowLeft size={15} />
          Все доски
        </Link>
        <ErrorState
          text={board.error || access.error}
          retry={() => {
            board.reload();
            access.reload();
          }}
        />
      </div>
    );
  return (
    <div className="board-fullscreen">
      <header className="board-topbar">
        <Link
          className="board-back"
          to={lessonId ? `/lessons/${encodeURIComponent(lessonId)}` : '/boards'}
          aria-label={lessonId ? 'К уроку' : 'Вернуться к списку досок'}
        >
          <ArrowLeft size={19} />
          <span>{lessonId ? 'К уроку' : 'Все доски'}</span>
        </Link>
        <div className="board-topbar-title">
          <h1>{(renamed ?? board.data).title}</h1>
          <span>Личная доска · можно пригласить участников</span>
        </div>
        <Button variant="secondary" onClick={() => setManagement(true)} aria-haspopup="dialog">
          <Settings2 size={17} />
          Управление
        </Button>
      </header>
      {lessonId && <LessonVersionBar key={lessonId} boardId={id} lessonId={lessonId} />}
      <Canvas access={access.data} />
      <Modal
        open={management}
        onClose={() => setManagement(false)}
        title="Управление доской"
        description="Материалы, версии, связи и доступ участников."
      >
        {management && (
          <BoardManagement
            board={renamed ?? board.data}
            onRenamed={setRenamed}
            onClose={() => setManagement(false)}
          />
        )}
      </Modal>
    </div>
  );
}

interface LessonVersionRequest {
  id: string;
  fingerprint: string;
  versionId?: string;
}

function readLessonVersionRequest(key: string): LessonVersionRequest | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? 'null') as LessonVersionRequest | null;
    return value &&
      typeof value.id === 'string' &&
      /^[0-9a-f]{64}$/.test(value.fingerprint) &&
      (value.versionId === undefined || value.versionId === value.id)
      ? value
      : null;
  } catch {
    return null;
  }
}

function LessonVersionBar({ boardId, lessonId }: { boardId: string; lessonId: string }) {
  const encodedLesson = encodeURIComponent(lessonId);
  const boards = useApi<LessonBoard[]>(`/api/lessons/${encodedLesson}/boards`);
  const current = boards.data?.find((item) => item.id === boardId);
  const { me } = useWorkspace();
  const storageKey = `lesson-board-version:${me.user.id}:${boardId}:${lessonId}`;
  const [initialRequest] = useState(() => readLessonVersionRequest(storageKey));
  const pending = useRef<LessonVersionRequest | null>(initialRequest);
  const [saved, setSaved] = useState<string>();
  const [unlinked, setUnlinked] = useState(initialRequest?.versionId);
  const [message, setMessage] = useState(
    initialRequest?.versionId ? 'Версия сохранена. Завершите привязку к уроку.' : '',
  );
  const { busy, run } = useTask();
  function remember(request: LessonVersionRequest | null) {
    pending.current = request;
    try {
      if (request) sessionStorage.setItem(storageKey, JSON.stringify(request));
      else sessionStorage.removeItem(storageKey);
    } catch {
      // The same request remains retryable in this page if browser storage is disabled.
    }
  }
  async function save() {
    setMessage('');
    await run(async () => {
      let versionId = unlinked;
      if (!versionId) {
        if (!pending.current) {
          const fingerprint = document.querySelector<HTMLElement>(
            '.board-editor-region [data-confirmed-fingerprint]',
          )?.dataset.confirmedFingerprint;
          if (!fingerprint) {
            setMessage('Дождитесь сохранения доски и примените черновики перед созданием версии.');
            return;
          }
          remember({ id: crypto.randomUUID(), fingerprint });
        }
        const request = pending.current;
        if (!request) return;
        try {
          versionId = (
            await api<BoardVersion>(`/api/boards/${boardId}/versions`, 'POST', {
              label: 'Материал урока',
              request: { id: request.id, fingerprint: request.fingerprint },
            })
          ).id;
          remember({ ...request, versionId });
          setUnlinked(versionId);
        } catch (error) {
          if (error instanceof ApiError && error.code === 'STALE_BOARD') remember(null);
          setMessage(errorMessage(error));
          return;
        }
      }
      try {
        await api(`/api/boards/${boardId}/links`, 'POST', { lessonId, snapshotId: versionId });
      } catch {
        setMessage('Версия сохранена. Связь с уроком пока не записана.');
        return;
      }
      setSaved(versionId);
      setUnlinked(undefined);
      remember(null);
    });
  }
  if (!current) return null;
  const versionId = saved ?? current.snapshotId;
  return (
    <div className="board-lesson-bar">
      <Button variant="secondary" busy={busy} onClick={() => void save()}>
        {unlinked ? 'Повторить привязку' : 'Сохранить версию к уроку'}
      </Button>
      {versionId && (
        <Link to={`/boards/${boardId}?${new URLSearchParams({ lessonId, version: versionId })}`}>
          {saved ? 'Версия урока сохранена' : 'Открыть версию урока'}
        </Link>
      )}
      <span role="status">{message}</span>
    </div>
  );
}

function BoardManagement({
  board,
  onRenamed,
  onClose,
}: {
  board: Board;
  onRenamed: (updated: Board) => void;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const { me } = useWorkspace();
  const [title, setTitle] = useState(board.title);
  const [deleting, setDeleting] = useState(false);
  const { busy, run } = useTask();
  const versions = useApi<BoardVersion[]>(`/api/boards/${board.id}/versions`);
  const requests = useRef(new Map<string, string>());
  async function copy(snapshotId?: string, label?: string) {
    if (!canLeaveBoard()) return;
    await run(async () => {
      const key = snapshotId || 'current';
      const requestId = requests.current.get(key) ?? crypto.randomUUID();
      requests.current.set(key, requestId);
      const created = await api<Board>(`/api/boards/${board.id}/copy`, 'POST', {
        requestId,
        ...(snapshotId
          ? {
              snapshotId,
              title: `${board.title.slice(0, 95)} — ${label?.slice(0, 95) || 'версия'}`,
            }
          : {}),
      });
      requests.current.delete(key);
      onClose();
      leaveConfirmedBoard(board.id, () => navigate(`/boards/${created.id}`));
      toast.success('Открыта независимая копия без приглашений');
    });
  }
  return (
    <div className="board-management">
      <details open className="board-management-section">
        <summary>
          <Settings2 size={17} />
          Название и копия
        </summary>
        <div className="board-section-content">
          <form
            className="form"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                const updated = await api<Board>(`/api/boards/${board.id}`, 'PATCH', {
                  title: title.trim(),
                });
                onRenamed(updated);
                toast.success('Название сохранено');
              });
            }}
          >
            <Field label="Название доски">
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                required
                maxLength={200}
                disabled={busy}
              />
            </Field>
            <Button
              variant="secondary"
              type="submit"
              busy={busy}
              disabled={!title.trim() || title.trim() === board.title}
            >
              Сохранить название
            </Button>
          </form>
          <Button variant="secondary" busy={busy} onClick={() => void copy()}>
            <Copy size={16} />
            Создать независимую копию
          </Button>
          <Button
            variant="ghost"
            busy={busy}
            onClick={() =>
              void run(() =>
                downloadJson(`/api/boards/${board.id}/export`, `tutorflow-board-${board.id}.json`),
              )
            }
          >
            <Download size={16} />
            Экспорт доски в JSON
          </Button>
          <p className="board-small-note">
            Копия получает свои материалы и доступ. Приглашения и связи исходной доски в неё не
            переносятся.
          </p>
        </div>
      </details>
      <details className="board-management-section">
        <summary>
          <History size={17} />
          Сохранённые версии
        </summary>
        <div className="board-section-content">
          <BoardHistory
            boardId={board.id}
            versions={versions}
            timezone={me.settings.timezone}
            busy={busy}
            onCopy={copy}
          />
        </div>
      </details>
      <details className="board-management-section">
        <summary>
          <Share2 size={17} />
          Пригласить и отозвать доступ
        </summary>
        <div className="board-section-content">
          <BoardSharing boardId={board.id} timezone={me.settings.timezone} />
        </div>
      </details>
      <details className="board-management-section">
        <summary>
          <Link2 size={17} />
          Ученики и занятия
        </summary>
        <div className="board-section-content">
          <BoardConnections
            boardId={board.id}
            versions={versions.data ?? []}
            timezone={me.settings.timezone}
          />
        </div>
      </details>
      <details className="board-management-section board-management-danger">
        <summary>
          <Trash2 size={17} />
          Удаление доски
        </summary>
        <div className="board-section-content">
          <p className="board-small-note">
            Удаление закрывает доступ всем участникам и удаляет саму доску. Ученики, занятия и
            оплаты сохранятся.
          </p>
          <Button variant="danger" onClick={() => setDeleting(true)}>
            Удалить доску
          </Button>
        </div>
      </details>
      <Confirm
        open={deleting}
        onClose={() => setDeleting(false)}
        title="Удалить эту доску?"
        danger
        label="Удалить доску"
        busy={busy}
        onConfirm={() =>
          void run(async () => {
            await api(`/api/boards/${board.id}`, 'DELETE');
            onClose();
            leaveConfirmedBoard(board.id, () => navigate('/boards'));
            toast.success('Доска удалена');
          })
        }
      >
        <p>
          Доска «{board.title}» и доступ участников будут удалены. Связанные занятия и ученики
          останутся. Перед удалением можно экспортировать материалы.
        </p>
      </Confirm>
    </div>
  );
}

function BoardHistory({
  boardId,
  versions,
  timezone,
  busy,
  onCopy,
}: {
  boardId: string;
  versions: ReturnType<typeof useApi<BoardVersion[]>>;
  timezone: string;
  busy: boolean;
  onCopy: (id: string, label: string) => Promise<void>;
}) {
  const [label, setLabel] = useState('');
  const task = useTask();
  return (
    <>
      <p className="board-small-note">
        Перед созданием версии дождитесь статуса «Изменения подтверждены сервером». Восстановление
        открывает новую копию, сохраняя текущую доску.
      </p>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void task.run(async () => {
            await api(`/api/boards/${boardId}/versions`, 'POST', { label: label.trim() });
            setLabel('');
            versions.reload();
            toast.success('Версия сохранена');
          });
        }}
      >
        <Field label="Название версии">
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            maxLength={100}
            required
            placeholder="Например, итог занятия 12 ноября"
            disabled={task.busy}
          />
        </Field>
        <Button type="submit" variant="secondary" busy={task.busy} disabled={!label.trim()}>
          Сохранить версию
        </Button>
      </form>
      {versions.loading ? (
        <Loading />
      ) : versions.error ? (
        <ErrorState text={versions.error} retry={versions.reload} />
      ) : !versions.data?.length ? (
        <p className="board-small-note">Сохранённых версий пока нет.</p>
      ) : (
        <ul className="board-record-list">
          {versions.data.map((version) => (
            <li key={version.id}>
              <div>
                <strong>{version.label}</strong>
                <small>{dateTime(version.createdAt, timezone)}</small>
              </div>
              <div className="board-record-actions">
                <Link
                  className="button secondary"
                  to={`/boards/${boardId}?version=${encodeURIComponent(version.id)}`}
                >
                  Открыть версию
                </Link>
                <Button
                  variant="secondary"
                  busy={busy}
                  onClick={() => void onCopy(version.id, version.label)}
                >
                  Восстановить копией
                </Button>
                <Button
                  variant="ghost"
                  busy={task.busy}
                  aria-label={`Экспорт версии ${version.label}`}
                  onClick={() =>
                    void task.run(() =>
                      downloadJson(
                        `/api/boards/${boardId}/versions/${version.id}/export`,
                        `tutorflow-version-${version.id}.json`,
                      ),
                    )
                  }
                >
                  <Download size={16} />
                  JSON
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function BoardSharing({ boardId, timezone }: { boardId: string; timezone: string }) {
  const invites = useApi<BoardInvitation[]>(`/api/boards/${boardId}/invites`);
  const [role, setRole] = useState<BoardRole>('editor');
  const [ttl, setTtl] = useState('60');
  const [uses, setUses] = useState('1');
  const [generated, setGenerated] = useState<{ id: string; url: string } | null>(null);
  const { busy, run } = useTask();
  return (
    <>
      <p className="board-small-note">
        Участник получит доступ только к этой доске. Отправляйте ссылку лично нужному человеку.
      </p>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            const result = await api<{ invite: BoardInvitation; token: string }>(
              `/api/boards/${boardId}/invites`,
              'POST',
              { role, ttlMinutes: Number(ttl), maxUses: Number(uses) },
            );
            setGenerated({
              id: result.invite.id,
              url: `${window.location.origin}/join/${boardId}#${result.token}`,
            });
            invites.reload();
          });
        }}
      >
        <Field label="Права участника">
          <select
            value={role}
            onChange={(event) => setRole(event.target.value as BoardRole)}
            disabled={busy}
          >
            <option value="editor">Редактирование</option>
            <option value="viewer">Только просмотр</option>
          </select>
        </Field>
        <div className="board-form-columns">
          <Field label="Срок доступа, минут">
            <input
              type="number"
              min={1}
              max={10080}
              required
              value={ttl}
              onChange={(event) => setTtl(event.target.value)}
              disabled={busy}
            />
          </Field>
          <Field label="Количество входов">
            <input
              type="number"
              min={1}
              max={1000}
              required
              value={uses}
              onChange={(event) => setUses(event.target.value)}
              disabled={busy}
            />
          </Field>
        </div>
        <Button type="submit" variant="secondary" busy={busy}>
          <Plus size={16} />
          Создать приглашение
        </Button>
      </form>
      {generated && (
        <div className="board-generated-link">
          <Field
            label="Ссылка приглашения"
            hint="Она видна только сейчас. Скопируйте до закрытия панели."
          >
            <input
              readOnly
              value={generated.url}
              onFocus={(event) => event.currentTarget.select()}
            />
          </Field>
          <Button
            variant="secondary"
            onClick={() =>
              void run(async () => {
                if (!navigator.clipboard)
                  throw new Error('Выделите и скопируйте ссылку из поля выше.');
                await navigator.clipboard.writeText(generated.url);
                toast.success('Ссылка скопирована');
              })
            }
          >
            <Copy size={15} />
            Скопировать ссылку
          </Button>
          <Button variant="ghost" onClick={() => setGenerated(null)}>
            Скрыть ссылку
          </Button>
        </div>
      )}
      {invites.loading ? (
        <Loading />
      ) : invites.error ? (
        <ErrorState text={invites.error} retry={invites.reload} />
      ) : !invites.data?.length ? (
        <p className="board-small-note">Приглашений пока нет.</p>
      ) : (
        <ul className="board-record-list">
          {invites.data.map((invite) => (
            <li key={invite.id}>
              <div>
                <strong>{roles[invite.role]}</strong>
                <small>
                  До {dateTime(invite.expiresAt, timezone)} · входы {invite.uses}/{invite.maxUses}
                </small>
                <small>
                  {invite.revokedAt
                    ? 'Доступ отозван'
                    : invite.uses >= invite.maxUses
                      ? 'Подключения использованы; доступ участника можно отозвать'
                      : 'Приглашение не отозвано'}
                </small>
              </div>
              {!invite.revokedAt && (
                <Button
                  variant="secondary"
                  busy={busy}
                  onClick={() =>
                    void run(async () => {
                      await api(`/api/boards/${boardId}/invites/${invite.id}/revoke`, 'POST', {});
                      if (generated?.id === invite.id) setGenerated(null);
                      invites.reload();
                      toast.success('Доступ отозван');
                    })
                  }
                >
                  Отозвать доступ
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function BoardConnections({
  boardId,
  versions,
  timezone,
}: {
  boardId: string;
  versions: BoardVersion[];
  timezone: string;
}) {
  const links = useApi<BoardLinks>(`/api/boards/${boardId}/links`);
  const active = useApi<Student[]>('/api/students');
  const archived = useApi<Student[]>('/api/students?archived=true');
  const [studentId, setStudentId] = useState('');
  const { busy, run } = useTask();
  const students = [...(active.data ?? []), ...(archived.data ?? [])];
  async function changeLink(data: BoardLinkInput, method = 'POST') {
    await run(async () => {
      await api(`/api/boards/${boardId}/links`, method, data);
      links.reload();
      toast.success(
        method === 'DELETE' ? 'Связь удалена. Материалы сохранены.' : 'Связь сохранена',
      );
    });
  }
  return (
    <>
      <p className="board-small-note">
        Одна доска может использоваться в нескольких занятиях. Удаление связи сохраняет доску и все
        материалы.
      </p>
      {active.error || archived.error ? (
        <ErrorState
          text={active.error || archived.error}
          retry={() => {
            active.reload();
            archived.reload();
          }}
        />
      ) : (
        <>
          <Field label="Ученик">
            <select
              value={studentId}
              onChange={(event) => setStudentId(event.target.value)}
              disabled={active.loading || archived.loading || busy}
            >
              <option value="">Выберите ученика</option>
              {students.map((student) => (
                <option key={student.id} value={student.id}>
                  {student.name}
                  {student.archivedAt ? ' · архив' : ''}
                </option>
              ))}
            </select>
          </Field>
          <Button
            variant="secondary"
            disabled={!studentId}
            busy={busy}
            onClick={() => void changeLink({ studentId })}
          >
            <Link2 size={15} />
            Связать с учеником
          </Button>
          {studentId && (
            <LessonConnectionPicker
              key={studentId}
              studentId={studentId}
              versions={versions}
              timezone={timezone}
              busy={busy}
              onLink={changeLink}
            />
          )}
        </>
      )}
      {links.loading ? (
        <Loading />
      ) : links.error ? (
        <ErrorState text={links.error} retry={links.reload} />
      ) : (
        <ul className="board-record-list">
          {links.data?.students.map((link) => (
            <li key={`student-${link.studentId}`}>
              <div>
                <Link to={`/students/${link.studentId}`}>
                  {students.find((student) => student.id === link.studentId)?.name ||
                    'Открыть ученика'}
                </Link>
                <small>Связь с учеником</small>
              </div>
              <Button
                variant="ghost"
                aria-label="Убрать связь с учеником"
                busy={busy}
                onClick={() => void changeLink({ studentId: link.studentId }, 'DELETE')}
              >
                <Unlink size={15} />
                Убрать связь
              </Button>
            </li>
          ))}
          {links.data?.lessons.map((link) => (
            <LinkedLessonRecord
              key={link.lessonId}
              link={link}
              versions={versions}
              timezone={timezone}
              busy={busy}
              onUnlink={() => changeLink({ lessonId: link.lessonId }, 'DELETE')}
            />
          ))}
          {!links.data?.students.length && !links.data?.lessons.length && (
            <li className="board-small-note">Связей пока нет.</li>
          )}
        </ul>
      )}
    </>
  );
}

function LinkedLessonRecord({
  link,
  versions,
  timezone,
  busy,
  onUnlink,
}: {
  link: BoardLinks['lessons'][number];
  versions: BoardVersion[];
  timezone: string;
  busy: boolean;
  onUnlink: () => Promise<void>;
}) {
  const lesson = useApi<LessonDetail>(`/api/lessons/${encodeURIComponent(link.lessonId)}`);
  return (
    <li>
      <div>
        <Link to={`/lessons/${link.lessonId}`}>
          {lesson.data
            ? `${lesson.data.lesson.studentName} · ${dateTime(lesson.data.lesson.startsAt, timezone)}`
            : 'Открыть занятие'}
          <ArrowUpRight size={13} />
        </Link>
        <small>
          {link.snapshotId
            ? `Версия: ${versions.find((version) => version.id === link.snapshotId)?.label || 'сохранённая'}`
            : 'Текущая доска'}
        </small>
        {lesson.error && (
          <button className="text-button" onClick={lesson.reload}>
            Повторить загрузку названия
          </button>
        )}
      </div>
      <Button
        variant="ghost"
        aria-label="Убрать связь с занятием"
        busy={busy}
        onClick={() => void onUnlink()}
      >
        <Unlink size={15} />
        Убрать связь
      </Button>
    </li>
  );
}

function LessonConnectionPicker({
  studentId,
  versions,
  timezone,
  busy,
  onLink,
}: {
  studentId: string;
  versions: BoardVersion[];
  timezone: string;
  busy: boolean;
  onLink: (data: BoardLinkInput) => Promise<void>;
}) {
  const [offset, setOffset] = useState(0);
  const lessons = useApi<{ lessons: Lesson[]; hasMore: boolean }>(
    `/api/lessons?studentId=${encodeURIComponent(studentId)}&offset=${offset}`,
  );
  const [lessonId, setLessonId] = useState('');
  const [snapshotId, setSnapshotId] = useState('');
  if (lessons.loading) return <Loading />;
  if (lessons.error) return <ErrorState text={lessons.error} retry={lessons.reload} />;
  return (
    <form
      className="form board-lesson-picker"
      onSubmit={(event) => {
        event.preventDefault();
        void onLink({ lessonId, snapshotId: snapshotId || null });
      }}
    >
      <Field label="Занятие">
        <select
          value={lessonId}
          onChange={(event) => setLessonId(event.target.value)}
          required
          disabled={busy}
        >
          <option value="">Выберите занятие</option>
          {lessons.data?.lessons.map((lesson) => (
            <option value={lesson.id} key={lesson.id}>
              {dateTime(lesson.startsAt, timezone)} · {lesson.topic || lesson.subject}
            </option>
          ))}
        </select>
      </Field>
      {(offset > 0 || lessons.data?.hasMore) && (
        <div className="board-record-actions">
          <Button
            type="button"
            variant="ghost"
            disabled={!offset}
            onClick={() => {
              setOffset((value) => Math.max(0, value - 100));
              setLessonId('');
            }}
          >
            Предыдущие
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={!lessons.data?.hasMore}
            onClick={() => {
              setOffset((value) => value + 100);
              setLessonId('');
            }}
          >
            Следующие
          </Button>
        </div>
      )}
      <Field label="Материал занятия">
        <select
          value={snapshotId}
          onChange={(event) => setSnapshotId(event.target.value)}
          disabled={busy}
        >
          <option value="">Текущая доска</option>
          {versions.map((version) => (
            <option key={version.id} value={version.id}>
              {version.label}
            </option>
          ))}
        </select>
      </Field>
      <Button type="submit" variant="secondary" busy={busy} disabled={!lessonId}>
        <Link2 size={15} />
        Связать с занятием
      </Button>
    </form>
  );
}

export function GuestBoardPage() {
  const { id = '' } = useParams();
  return <GuestBoard key={id} id={id} />;
}

function GuestBoard({ id }: { id: string }) {
  // Fragment secrets stay in component memory and are exchanged only by the
  // explicit join action. GET/prefetch does not consume an invitation.
  const [token, setToken] = useState(() => window.location.hash.slice(1));
  const [joined, setJoined] = useState<BoardAccess | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const session = useApi<BoardAccess>(`/api/board-access/${encodeURIComponent(id)}/session`);
  const access = joined ?? session.data;
  async function redeem() {
    if (busy || !/^[0-9a-f]{64}$/.test(token)) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<BoardAccess>(
        `/api/board-access/${encodeURIComponent(id)}/redeem`,
        'POST',
        { token },
      );
      window.history.replaceState(
        window.history.state,
        '',
        `${window.location.pathname}${window.location.search}`,
      );
      setToken('');
      setJoined(result);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  if (token)
    return (
      <div className="board-guest-entry">
        <div className="board-guest-card panel">
          <Presentation size={34} strokeWidth={1.4} />
          <div className="eyebrow">TUTORFLOW · СОВМЕСТНАЯ ДОСКА</div>
          <h1>Приглашение на доску</h1>
          <p>
            Присоединитесь, чтобы открыть учебные материалы. Доступ к этой доске выдаётся отдельно.
          </p>
          {!/^[0-9a-f]{64}$/.test(token) ? (
            <p className="inline-error" role="alert">
              Ссылка приглашения повреждена. Попросите владельца отправить новую.
            </p>
          ) : (
            <Button onClick={() => void redeem()} busy={busy}>
              Присоединиться
            </Button>
          )}
          {error && (
            <p className="inline-error" role="alert">
              {error} Если приглашение истекло или отозвано, попросите владельца создать новое.
            </p>
          )}
        </div>
      </div>
    );
  if (session.loading && !joined)
    return (
      <div className="board-page-loading">
        <Loading />
      </div>
    );
  if (!access)
    return (
      <div className="board-guest-entry">
        <div className="board-guest-card panel">
          <Presentation size={34} strokeWidth={1.4} />
          <h1>Доска недоступна</h1>
          <p>
            Доступ мог истечь или быть отозван. Откройте новую ссылку от владельца либо повторите
            проверку соединения.
          </p>
          <Button variant="secondary" onClick={session.reload}>
            Проверить доступ ещё раз
          </Button>
        </div>
      </div>
    );
  return (
    <div className="board-fullscreen board-guest">
      <header className="board-topbar">
        <Presentation size={23} />
        <div className="board-topbar-title">
          <h1>{access.title}</h1>
          <span>
            {roles[access.role]}
            {access.expiresAt ? ` · до ${new Date(access.expiresAt).toLocaleString('ru-RU')}` : ''}
          </span>
        </div>
        <span className="board-guest-brand">TutorFlow</span>
      </header>
      <Canvas access={access} />
    </div>
  );
}
