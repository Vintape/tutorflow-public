import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { DateTime } from 'luxon';
import {
  BookOpen,
  CalendarDays,
  Check,
  CheckCheck,
  ChevronRight,
  Clock3,
  Copy,
  Edit3,
  FileText,
  RotateCcw,
  Save,
  ShieldCheck,
  Sparkles,
  Wallet,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  emptyReport,
  formatMoney,
  reportLabels,
  reportText,
  type LessonDetail,
  type LessonReport,
  type ReportContent,
  type ReportStyle,
} from '../shared/domain';
import type { LessonBoard } from '../shared/boards';
import { api, dateTime, today, useApi, useTask, useWorkspace } from './lib';
import {
  Avatar,
  BackLink,
  Button,
  Confirm,
  ErrorState,
  Field,
  Loading,
  Modal,
  Status,
} from './components';
import { LessonDialog } from './forms';
import { GoogleCalendarLesson } from './google-calendar-lesson';

export function LessonPage() {
  const { id } = useParams();
  const { revision } = useWorkspace();
  const state = useApi<LessonDetail>(`/api/lessons/${id}`, revision);
  if (state.loading && !state.data) return <Loading />;
  if (state.error || !state.data) return <ErrorState text={state.error} retry={state.reload} />;
  return <LessonEditor initial={state.data} key={id} />;
}
function LessonBoards({ lessonId }: { lessonId: string }) {
  const { revision } = useWorkspace();
  const boards = useApi<LessonBoard[]>(`/api/lessons/${lessonId}/boards`, revision);
  const lessonQuery = new URLSearchParams({ lessonId });
  return (
    <section className="panel note-panel lesson-boards" aria-labelledby="lesson-materials">
      <h2 id="lesson-materials">Материалы урока</h2>
      {boards.loading && !boards.data ? (
        <Loading />
      ) : boards.error ? (
        <ErrorState text={boards.error} retry={boards.reload} />
      ) : boards.data?.length ? (
        <ul>
          {boards.data.map(({ id, title, snapshotId }) => (
            <li key={id}>
              <strong>{title}</strong>
              <div className="lesson-board-links">
                <Link className="button secondary" to={`/boards/${id}?${lessonQuery}`}>
                  Продолжить доску
                </Link>
                {snapshotId && (
                  <Link
                    className="button secondary"
                    to={`/boards/${id}?${new URLSearchParams({ lessonId, version: snapshotId })}`}
                  >
                    Открыть версию урока
                  </Link>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="section-description">К этому уроку пока не привязана доска.</p>
      )}
      <Link className="button secondary" to={`/boards?${lessonQuery}`}>
        Создать или привязать доску
      </Link>
    </section>
  );
}

function LessonEditor({ initial }: { initial: LessonDetail }) {
  const { me, changed } = useWorkspace();
  const [lesson, setLesson] = useState(initial.lesson),
    [report, setReport] = useState(initial.report),
    [payments, setPayments] = useState(initial.payments);
  const [note, setNote] = useState(initial.lesson.note),
    [homework, setHomework] = useState(initial.lesson.homework);
  const [content, setContent] = useState<ReportContent>(
    initial.report?.content || {
      ...emptyReport,
      topic: initial.lesson.topic,
      homework: initial.lesson.homework,
    },
  );
  const [style, setStyle] = useState<ReportStyle>('standard');
  const [editing, setEditing] = useState(false),
    [generating, setGenerating] = useState(false),
    [confirm, setConfirm] = useState<'cancel' | 'pay' | 'reverse' | 'regenerate' | null>(null),
    [copyFallback, setCopyFallback] = useState('');
  const [paidDate, setPaidDate] = useState(() => today(me.settings.timezone).toISODate()!);
  const [clockNow, setClockNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setClockNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  const { busy, run } = useTask();
  const noteDirty = note !== lesson.note || homework !== lesson.homework;
  const contentDirty =
    JSON.stringify(content) !==
    JSON.stringify(
      report?.content || { ...emptyReport, topic: lesson.topic, homework: lesson.homework },
    );
  const approved = report?.status === 'APPROVED' && !contentDirty && !noteDirty;
  const past = Date.parse(lesson.startsAt) <= clockNow;
  const zone = me.settings.timezone;
  const activePayment = payments.find((p) => !p.voidedAt);
  const completed = lesson.status === 'COMPLETED';
  useEffect(() => {
    function warn(event: BeforeUnloadEvent) {
      if (noteDirty || contentDirty) {
        event.preventDefault();
        event.returnValue = '';
      }
    }
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [noteDirty, contentDirty]);
  async function sync() {
    const data = await api<LessonDetail>(`/api/lessons/${lesson.id}`);
    setLesson(data.lesson);
    setReport(data.report);
    setPayments(data.payments);
    changed();
    return data;
  }
  async function persistNote(status?: 'COMPLETED' | 'CANCELLED' | 'PLANNED') {
    const updated = await api<LessonDetail['lesson']>(`/api/lessons/${lesson.id}`, 'PATCH', {
      version: lesson.version,
      note,
      homework,
      ...(status ? { status } : {}),
    });
    setLesson(updated);
    if (!report)
      setContent((current) => ({
        ...current,
        topic: current.topic || updated.topic,
        homework: current.homework || updated.homework,
      }));
    const data = await sync();
    return data.lesson;
  }
  async function saveNote(event?: FormEvent) {
    event?.preventDefault();
    await run(async () => {
      await persistNote();
      toast.success('Заметка сохранена');
    });
  }
  async function saveReport(approve: boolean) {
    await run(async () => {
      if (noteDirty) {
        toast.error('Сначала сохраните заметку, чтобы отчёт соответствовал исходным данным');
        return;
      }
      const saved = await api<LessonReport>(`/api/lessons/${lesson.id}/report`, 'PUT', {
        content,
        approve,
        version: report?.version || 0,
      });
      setReport(saved);
      setContent(saved.content);
      changed();
      toast.success(approve ? 'Отчёт подтверждён и готов для родителя' : 'Черновик сохранён');
    });
  }
  async function generate() {
    setConfirm(null);
    await run(async () => {
      setGenerating(true);
      try {
        const current = noteDirty ? await persistNote() : lesson;
        const generated = await api<LessonReport>(
          `/api/lessons/${lesson.id}/report/generate`,
          'POST',
          { consent: true, style, version: current.version },
        );
        setReport(generated);
        setContent(generated.content);
        changed();
        toast.success('Черновик готов. Проверьте каждое поле перед подтверждением.');
      } finally {
        setGenerating(false);
      }
    });
  }
  async function copy() {
    await run(async () => {
      const data = await api<{ content: ReportContent }>(
        `/api/lessons/${lesson.id}/report/copy`,
        'POST',
        {},
      );
      const text = reportText(data.content);
      try {
        await navigator.clipboard.writeText(text);
        toast.success('Отчёт скопирован. Можно отправить родителю.');
      } catch {
        setCopyFallback(text);
      }
    });
  }
  async function confirmAction() {
    if (confirm === 'regenerate') {
      await generate();
      return;
    }
    await run(async () => {
      if (confirm === 'cancel') {
        await persistNote('CANCELLED');
        toast.success('Занятие отменено. Начисление снято.');
      }
      if (confirm === 'pay') {
        if (!paidDate) throw new Error('Укажите дату получения');
        const date = DateTime.fromISO(paidDate, { zone }).set({ hour: 12 });
        await api(`/api/lessons/${lesson.id}/payment`, 'POST', {
          paidAt: date.toMillis() > Date.now() ? new Date().toISOString() : date.toUTC().toISO(),
        });
        await sync();
        toast.success('Оплата отмечена');
      }
      if (confirm === 'reverse' && activePayment) {
        await api(`/api/payments/${activePayment.id}/reverse`, 'POST', {});
        await sync();
        toast.success('Отметка оплаты отменена. История сохранена.');
      }
      setConfirm(null);
    });
  }
  return (
    <>
      <BackLink to="/schedule">Расписание</BackLink>
      <div className="lesson-page-heading">
        <div className="lesson-title">
          <Avatar name={lesson.studentName} />
          <div>
            <div className="eyebrow">
              {lesson.subject} · {lesson.level || 'ИНДИВИДУАЛЬНОЕ ЗАНЯТИЕ'}
            </div>
            <h1>Урок · {lesson.studentName}</h1>
            <p>
              {dateTime(lesson.startsAt, zone, 'd MMMM yyyy')}
              <span className="dot-separator">·</span>
              {dateTime(lesson.startsAt, zone, 'HH:mm')} —{' '}
              {dateTime(
                DateTime.fromISO(lesson.startsAt).plus({ minutes: lesson.duration }).toISO()!,
                zone,
                'HH:mm',
              )}
            </p>
          </div>
        </div>
        <div className="heading-actions">
          <Status status={lesson.status} />
          <Button variant="secondary" onClick={() => setEditing(true)} disabled={busy}>
            <Edit3 size={16} />
            Изменить
          </Button>
        </div>
      </div>
      <div className="report-layout">
        <div className="report-main">
          {me.boards?.enabled && <LessonBoards lessonId={lesson.id} />}
          <GoogleCalendarLesson lessonId={lesson.id} />
          <section className="panel note-panel">
            <div className="report-section-heading">
              <div>
                <span className="section-step">01</span>
                <h2>Коротко об уроке</h2>
              </div>
              <span className="private-label">
                <ShieldCheck size={14} />
                Только для вас
              </span>
            </div>
            <p className="section-description">
              Что прошли, что получилось и на чём стоит остановиться. Пишите как удобно.
            </p>
            <form onSubmit={saveNote}>
              <Field label="Заметка преподавателя">
                <textarea
                  className="note-textarea"
                  aria-label="Заметка преподавателя"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={8000}
                  rows={5}
                  disabled={generating}
                  placeholder="Решали квадратные уравнения. Формулы понимает, но иногда ошибается при вычислении дискриминанта. На следующем уроке закрепим…"
                />
              </Field>
              <div className="textarea-meta">
                <span>Без обязательных формулировок</span>
                <span>{note.length} / 8 000</span>
              </div>
              <Field label="Домашнее задание · необязательно">
                <input
                  value={homework}
                  onChange={(e) => setHomework(e.target.value)}
                  maxLength={2000}
                  disabled={generating}
                  placeholder="Например, задачи 12–18"
                />
              </Field>
              <div className="note-actions">
                <span className={noteDirty ? 'unsaved' : 'saved-note'}>
                  {noteDirty ? (
                    'Есть несохранённые изменения'
                  ) : lesson.note ? (
                    <>
                      <Check size={14} />
                      Заметка сохранена
                    </>
                  ) : (
                    'Заметка поможет вспомнить важное'
                  )}
                </span>
                {lesson.status === 'PLANNED' ? (
                  <Button
                    type="button"
                    disabled={busy || !past}
                    busy={busy}
                    title={!past ? 'Занятие ещё не началось' : ''}
                    onClick={() =>
                      void run(async () => {
                        await persistNote('COMPLETED');
                        toast.success('Занятие проведено. Можно подготовить отчёт.');
                      })
                    }
                  >
                    <CheckCheck size={16} />
                    Завершить урок
                  </Button>
                ) : (
                  <Button type="submit" variant="secondary" disabled={!noteDirty} busy={busy}>
                    <Save size={15} />
                    Сохранить заметку
                  </Button>
                )}
              </div>
            </form>
          </section>
          <section className={`panel report-panel ${!completed ? 'report-not-ready' : ''}`}>
            <div className="report-section-heading">
              <div>
                <span className="section-step">02</span>
                <h2>Отчёт для родителя</h2>
              </div>
              <span className={`badge ${approved ? 'status-completed' : 'neutral'}`}>
                {approved ? (
                  <>
                    <Check size={13} />
                    Подтверждён
                  </>
                ) : report ? (
                  'Черновик'
                ) : (
                  'Новый отчёт'
                )}
              </span>
            </div>
            <p className="section-description">
              Ваши наблюдения — в понятном и аккуратном тексте. Последнее слово всегда за вами.
            </p>
            {!completed ? (
              <div className="report-locked">
                <FileText size={32} strokeWidth={1.3} />
                <h3>Сначала проведём урок</h3>
                <p>
                  {lesson.status === 'CANCELLED'
                    ? 'Для отменённого занятия отчёт не требуется.'
                    : past
                      ? 'Отметьте занятие проведённым — и можно будет подготовить отчёт.'
                      : 'После занятия сохраните заметку и подготовьте отчёт здесь.'}
                </p>
              </div>
            ) : (
              <>
                <div className="ai-toolbar">
                  <div>
                    <Sparkles size={19} />
                    <div>
                      <strong>Помочь с формулировками?</strong>
                      <span>
                        {me.ai.available
                          ? 'Сформируем черновик из вашей заметки'
                          : 'Ручной отчёт доступен. ИИ пока не подключён.'}
                      </span>
                    </div>
                  </div>
                  <div className="ai-controls">
                    <select
                      aria-label="Стиль отчёта"
                      value={style}
                      onChange={(e) => setStyle(e.target.value as ReportStyle)}
                      disabled={busy}
                    >
                      <option value="short">Кратко</option>
                      <option value="standard">Стандартно</option>
                      <option value="detailed">Подробно</option>
                    </select>
                    <Button
                      variant="primary"
                      disabled={!me.ai.available || !note.trim() || busy}
                      busy={generating}
                      onClick={() =>
                        report || contentDirty ? setConfirm('regenerate') : void generate()
                      }
                    >
                      <Sparkles size={15} />
                      {generating ? 'Готовим черновик…' : 'Сформировать'}
                    </Button>
                  </div>
                </div>
                {me.ai.available && (
                  <p className="ai-privacy">
                    Нажатие «Сформировать» отправит предмет, уровень и учебную заметку в OpenAI.
                    Проверьте, что в тексте нет личных данных. Имя ученика и известные контакты мы
                    скрываем.
                  </p>
                )}
                <fieldset className="report-fields" disabled={generating}>
                  {(Object.keys(reportLabels) as (keyof ReportContent)[]).map((key) => (
                    <Field label={reportLabels[key]} key={key}>
                      <textarea
                        aria-label={reportLabels[key]}
                        rows={key === 'topic' ? 1 : 2}
                        value={content[key]}
                        onChange={(e) => setContent((old) => ({ ...old, [key]: e.target.value }))}
                        maxLength={key === 'topic' ? 1000 : key === 'homework' ? 2000 : 2500}
                        placeholder={
                          key === 'topic'
                            ? 'О чём было занятие'
                            : key === 'homework'
                              ? 'Оставьте пустым, если не задавали'
                              : 'Только то, что действительно было на занятии'
                        }
                      />
                    </Field>
                  ))}
                </fieldset>
                <div className="review-reminder">
                  <ShieldCheck size={17} />
                  <span>
                    Проверьте факты перед отправкой. Изменение текста или исходной заметки
                    возвращает отчёт в черновик.
                  </span>
                </div>
                <div className="report-actions">
                  <Button
                    variant="secondary"
                    disabled={busy || noteDirty}
                    onClick={() => void saveReport(false)}
                  >
                    <Save size={15} />
                    Сохранить черновик
                  </Button>
                  {approved ? (
                    <Button disabled={busy} onClick={() => void copy()}>
                      <Copy size={15} />
                      Скопировать для родителя
                    </Button>
                  ) : (
                    <Button disabled={busy || noteDirty} onClick={() => void saveReport(true)}>
                      <CheckCheck size={16} />
                      Подтвердить отчёт
                    </Button>
                  )}
                </div>
                {noteDirty && (
                  <p className="inline-note">
                    Сначала сохраните изменения заметки, затем подтвердите отчёт.
                  </p>
                )}
                {contentDirty && <p className="inline-note">Изменения отчёта ещё не сохранены.</p>}
              </>
            )}
          </section>
        </div>
        <aside className="report-aside stack">
          <section className="panel info-panel lesson-info">
            <h2>Об этом занятии</h2>
            <dl>
              <div>
                <dt>
                  <CalendarDays size={15} />
                  Дата
                </dt>
                <dd>{dateTime(lesson.startsAt, zone, 'd MMMM yyyy')}</dd>
              </div>
              <div>
                <dt>
                  <Clock3 size={15} />
                  Длительность
                </dt>
                <dd>{lesson.duration} минут</dd>
              </div>
              <div>
                <dt>
                  <BookOpen size={15} />
                  Тема
                </dt>
                <dd>{lesson.topic || 'Не указана'}</dd>
              </div>
              <div>
                <dt>
                  <Wallet size={15} />
                  Стоимость
                </dt>
                <dd>{formatMoney(lesson.price)}</dd>
              </div>
            </dl>
            <Link className="student-inline-link" to={`/students/${lesson.studentId}`}>
              <Avatar name={lesson.studentName} size="small" />
              <span>Карточка ученика</span>
              <ChevronRight size={15} />
            </Link>
          </section>
          <section className="panel info-panel payment-panel">
            <h2>Оплата занятия</h2>
            <strong className="payment-amount">{formatMoney(lesson.price)}</strong>
            <span
              className={`badge ${activePayment ? 'status-completed' : lesson.status === 'CANCELLED' || !lesson.price ? 'neutral' : 'status-planned'}`}
            >
              {activePayment
                ? '✓ Оплачено'
                : lesson.status === 'CANCELLED'
                  ? 'Не начисляется'
                  : !lesson.price
                    ? 'Бесплатное занятие'
                    : completed
                      ? 'Ожидает оплаты'
                      : 'Начислится после урока'}
            </span>
            {activePayment ? (
              <>
                <p className="muted">
                  Получено {dateTime(activePayment.paidAt, zone, 'd MMMM yyyy')}
                </p>
                <Button variant="ghost" onClick={() => setConfirm('reverse')} disabled={busy}>
                  <RotateCcw size={14} />
                  Исправить отметку
                </Button>
              </>
            ) : completed && lesson.price > 0 ? (
              <>
                <p className="muted">Отмечайте только фактически полученные деньги.</p>
                <Button
                  className="full-width"
                  variant="secondary"
                  onClick={() => {
                    setPaidDate(today(zone).toISODate()!);
                    setConfirm('pay');
                  }}
                  disabled={busy}
                >
                  <Check size={16} />
                  Отметить оплату
                </Button>
              </>
            ) : (
              <p className="muted">
                {lesson.status === 'CANCELLED'
                  ? 'Отмена не создаёт задолженности.'
                  : 'Будущие занятия не считаются полученным доходом.'}
              </p>
            )}
            {payments.some((p) => p.voidedAt) && (
              <div className="reversal-history">
                {payments
                  .filter((p) => p.voidedAt)
                  .map((p) => (
                    <span key={p.id}>
                      Отметка {formatMoney(p.amount)} отменена{' '}
                      {dateTime(p.voidedAt!, zone, 'd MMM')}
                    </span>
                  ))}
              </div>
            )}
          </section>
          <div className="report-side-note">
            <Sparkles size={19} />
            <p>Хороший отчёт — это не много текста, а несколько точных наблюдений об ученике.</p>
          </div>
          {lesson.status !== 'CANCELLED' && !activePayment && (
            <Button variant="ghost" onClick={() => setConfirm('cancel')} disabled={busy}>
              Отменить занятие
            </Button>
          )}
          {lesson.status === 'CANCELLED' && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await persistNote('PLANNED');
                  toast.success('Занятие возвращено в расписание');
                })
              }
            >
              Вернуть в расписание
            </Button>
          )}
        </aside>
      </div>
      {editing && (
        <LessonDialog
          initial={lesson}
          onClose={() => {
            setEditing(false);
            void sync();
          }}
        />
      )}
      <Confirm
        open={Boolean(confirm)}
        title={
          confirm === 'cancel'
            ? 'Отменить занятие?'
            : confirm === 'reverse'
              ? 'Исправить отметку оплаты?'
              : confirm === 'regenerate'
                ? 'Сформировать новый черновик?'
                : 'Деньги уже получены?'
        }
        label={
          confirm === 'cancel'
            ? 'Отменить занятие'
            : confirm === 'reverse'
              ? 'Отменить отметку'
              : confirm === 'regenerate'
                ? 'Сформировать заново'
                : 'Подтвердить оплату'
        }
        danger={confirm === 'cancel' || confirm === 'reverse'}
        onClose={() => setConfirm(null)}
        busy={busy}
        onConfirm={() => void confirmAction()}
      >
        {confirm === 'cancel' ? (
          'Начисление за этот урок будет снято. Заметки и история сохранятся.'
        ) : confirm === 'reverse' ? (
          'Поступление перестанет учитываться в суммах. Запись сохранится в истории, а у занятия снова появится задолженность.'
        ) : confirm === 'regenerate' ? (
          'Текущий текст отчёта будет заменён новым черновиком. Он потребует повторной проверки.'
        ) : (
          <>
            <p>{formatMoney(lesson.price)} за этот урок. В пилоте поддерживается полная оплата.</p>
            <Field label="Дата получения">
              <input
                type="date"
                value={paidDate}
                max={today(zone).toISODate()!}
                onChange={(e) => setPaidDate(e.target.value)}
                required
              />
            </Field>
          </>
        )}
      </Confirm>
      <Modal
        open={Boolean(copyFallback)}
        onClose={() => setCopyFallback('')}
        title="Отчёт готов к копированию"
        description="Браузер ограничил доступ к буферу. Выделите и скопируйте текст вручную."
      >
        <textarea
          className="copy-fallback"
          value={copyFallback}
          readOnly
          rows={12}
          onFocus={(e) => e.currentTarget.select()}
          autoFocus
        />
        <div className="form-actions">
          <Button onClick={() => setCopyFallback('')}>Готово</Button>
        </div>
      </Modal>
    </>
  );
}
