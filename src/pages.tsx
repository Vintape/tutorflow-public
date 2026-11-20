import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { DateTime } from 'luxon';
import {
  Archive,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Clock3,
  Edit3,
  LayoutGrid,
  List,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Sun,
  Users,
  Wallet,
} from 'lucide-react';
import { toast } from 'sonner';
import { GoogleCalendarSettingsCard } from './google-calendar-settings';
import type { Finance, Lesson, Overview, Student } from '../shared/domain';
import { formatMoney } from '../shared/domain';
import {
  calendarBusyPath,
  calendarStateLabels,
  type GoogleCalendarBusy,
  type GoogleCalendarLessonState,
} from '../shared/google-calendar';
import { api, applyTheme, dateTime, today, useApi, useTask, useWorkspace } from './lib';
import {
  AddLessonButton,
  Avatar,
  BackLink,
  Button,
  Confirm,
  Empty,
  ErrorState,
  Field,
  LessonList,
  Loading,
  Metric,
  PageHeader,
  ScheduleEmpty,
  SectionTitle,
  TextLink,
} from './components';
import { LessonDialog, StudentDialog } from './forms';

export function Dashboard() {
  const { me, revision } = useWorkspace();
  const state = useApi<Overview>('/api/overview', revision);
  const [addStudent, setAddStudent] = useState(false),
    [addLesson, setAddLesson] = useState(false);
  const now = today(me.settings.timezone);
  if (state.loading) return <Loading />;
  if (state.error || !state.data) return <ErrorState text={state.error} retry={state.reload} />;
  const data = state.data;
  return (
    <>
      <PageHeader
        eyebrow={now.toFormat('cccc, d MMMM')}
        title={`Хорошего дня, ${me.user.name.split(' ')[0]}.`}
        description="Немного порядка — и больше времени на любимое дело."
        actions={
          <AddLessonButton
            onClick={() => (me.studentCount ? setAddLesson(true) : setAddStudent(true))}
            label={me.studentCount ? 'Запланировать урок' : 'Добавить ученика'}
          />
        }
      />
      {!data.activeStudents && (
        <div className="welcome-banner">
          <div className="welcome-copy">
            <span className="badge welcome-badge">
              <Sparkles size={13} />
              НАЧНЁМ ЗНАКОМСТВО
            </span>
            <h2>
              Ваше спокойное
              <br />
              рабочее пространство.
            </h2>
            <p>
              Добавьте первого ученика, запланируйте урок
              <br className="desktop-break" /> и почувствуйте, как всё встаёт на свои места.
            </p>
            <Button onClick={() => setAddStudent(true)}>
              Добавить первого ученика
              <ArrowRight size={16} />
            </Button>
          </div>
          <div className="welcome-art" aria-hidden="true">
            <span className="art-orbit" />
            <span className="art-book">
              <BookOpen size={72} strokeWidth={1.1} />
            </span>
            <span className="art-check">
              <Check size={26} />
            </span>
            <span className="art-calendar">
              <CalendarDays size={30} strokeWidth={1.4} />
            </span>
            <span className="art-star">✦</span>
          </div>
        </div>
      )}
      <div className="dashboard-grid">
        <div className="dashboard-main">
          <section className="panel">
            <SectionTitle
              title="Сегодня"
              extra={
                <span className="count-label">
                  Занятий: {data.today.filter((l) => l.status !== 'CANCELLED').length}
                </span>
              }
            />
            {data.today.length ? (
              <LessonList lessons={data.today} />
            ) : (
              <ScheduleEmpty
                onAdd={() => (me.studentCount ? setAddLesson(true) : setAddStudent(true))}
              />
            )}
            <div className="panel-footer">
              <TextLink to="/schedule">Открыть расписание</TextLink>
              <span>{me.settings.timezone.split('/').pop()?.replaceAll('_', ' ')}</span>
            </div>
          </section>
          <section className="panel attention-panel">
            <SectionTitle
              title="Требует внимания"
              extra={
                <span className="subtle-icon">
                  <ClipboardCheck size={18} />
                </span>
              }
            />
            {data.attention.length ? (
              <div className="attention-list">
                {data.attention.map((lesson) => (
                  <Link key={lesson.id} to={`/lessons/${lesson.id}`}>
                    <div className="attention-icon">
                      <BookOpen size={17} />
                    </div>
                    <div>
                      <strong>Отчёт · {lesson.studentName}</strong>
                      <span>
                        {dateTime(lesson.startsAt, me.settings.timezone, 'd MMMM')} ·{' '}
                        {lesson.reportStatus === 'DRAFT'
                          ? 'Черновик ждёт проверки'
                          : 'Сохраните впечатления об уроке'}
                      </span>
                    </div>
                    <ArrowUpRight size={18} />
                  </Link>
                ))}
              </div>
            ) : (
              <div className="all-clear">
                <span>
                  <Check size={20} />
                </span>
                <div>
                  <strong>Всё под контролем</strong>
                  <p>
                    Здесь появятся проведённые занятия, для которых нужно подготовить или проверить
                    отчёт.
                  </p>
                </div>
              </div>
            )}
          </section>
        </div>
        <aside className="dashboard-aside">
          <section className="panel next-lesson">
            <SectionTitle title="Следующее занятие" extra={<Clock3 size={17} />} />
            {data.next ? (
              <>
                <div className="next-student">
                  <Avatar name={data.next.studentName} size="large" />
                  <h3>{data.next.studentName}</h3>
                  <p>
                    {data.next.subject} · {data.next.level || 'Индивидуальное занятие'}
                  </p>
                </div>
                <div className="next-details">
                  <span>
                    <CalendarDays size={15} />
                    {dateTime(data.next.startsAt, me.settings.timezone, 'd MMMM, ccc')}
                  </span>
                  <strong>
                    {dateTime(data.next.startsAt, me.settings.timezone, 'HH:mm')}
                    <span> · {data.next.duration} мин</span>
                  </strong>
                </div>
                <Link className="button secondary full-width" to={`/lessons/${data.next.id}`}>
                  Открыть занятие
                  <ArrowRight size={15} />
                </Link>
              </>
            ) : (
              <div className="next-empty">
                <CalendarDays size={33} strokeWidth={1.2} />
                <p>
                  Ближайших занятий
                  <br />
                  пока нет
                </p>
                <button
                  className="text-button"
                  onClick={() => (me.studentCount ? setAddLesson(true) : setAddStudent(true))}
                >
                  Добавить в расписание
                  <Plus size={14} />
                </button>
              </div>
            )}
          </section>
          <section className="month-card">
            <div className="month-heading">
              <span>
                <Wallet size={17} />
                Этот месяц
              </span>
              <Link to="/finance" aria-label="Открыть финансы">
                <ArrowUpRight size={18} />
              </Link>
            </div>
            <strong className="month-income">{formatMoney(data.finance.received)}</strong>
            <p>получено за {now.toFormat('LLLL')}</p>
            <div className="month-lines">
              <span>
                Начислено<strong>{formatMoney(data.finance.accrued)}</strong>
              </span>
              <span>
                Не оплачено · за всё время
                <strong className={data.finance.debt ? 'text-amber' : ''}>
                  {formatMoney(data.finance.debt)}
                </strong>
              </span>
              <span>
                Проведено занятий<strong>{data.finance.completedCount}</strong>
              </span>
            </div>
            <Link className="text-link" to="/finance">
              Подробнее о финансах
              <ArrowRight size={15} />
            </Link>
          </section>
        </aside>
      </div>
      <div className="workflow-note">
        <Sparkles size={16} />
        <span>
          После урока достаточно короткой заметки. Хороший отчёт начинается с ваших наблюдений.
        </span>
      </div>
      {addStudent && <StudentDialog onClose={() => setAddStudent(false)} />}
      {addLesson && <LessonDialog onClose={() => setAddLesson(false)} />}
    </>
  );
}
export function StudentsPage() {
  const { revision } = useWorkspace();
  const [archived, setArchived] = useState(false),
    [search, setSearch] = useState(''),
    [add, setAdd] = useState(false);
  const state = useApi<Student[]>(`/api/students?archived=${archived}`, revision);
  const filtered = (state.data || []).filter((s) =>
    `${s.name} ${s.subject} ${s.level}`
      .toLocaleLowerCase('ru')
      .includes(search.toLocaleLowerCase('ru')),
  );
  return (
    <>
      <PageHeader
        eyebrow="КАЖДЫЙ УЧЕНИК ВАЖЕН"
        title="Ученики"
        description="Цели, история занятий и маленькие шаги к большим результатам."
        actions={
          <Button onClick={() => setAdd(true)}>
            <Plus size={17} />
            Добавить ученика
          </Button>
        }
      />
      <div className="list-toolbar">
        <div className="tabs">
          <button className={!archived ? 'active' : ''} onClick={() => setArchived(false)}>
            Активные{!archived && state.data && <span>{state.data.length}</span>}
          </button>
          <button className={archived ? 'active' : ''} onClick={() => setArchived(true)}>
            <Archive size={14} />
            Архив
          </button>
        </div>
        <div className="search-field">
          <Search size={17} />
          <input
            aria-label="Найти ученика"
            placeholder="Имя, предмет или класс"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>
      {state.loading ? (
        <Loading />
      ) : state.error ? (
        <ErrorState text={state.error} retry={state.reload} />
      ) : !filtered.length ? (
        <div className="panel">
          <Empty
            icon={Users}
            title={
              search
                ? 'Никого не нашли'
                : archived
                  ? 'В архиве пока пусто'
                  : 'Первый ученик — начало порядка'
            }
            text={
              search
                ? 'Попробуйте другое имя или предмет.'
                : archived
                  ? 'История архивных учеников останется доступной здесь.'
                  : 'Добавьте ученика, чтобы планировать уроки и сохранять учебный прогресс.'
            }
            action={
              !search &&
              !archived && (
                <Button onClick={() => setAdd(true)}>
                  <Plus size={16} />
                  Добавить первого ученика
                </Button>
              )
            }
          />
        </div>
      ) : (
        <div className="student-grid">
          {filtered.map((student) => (
            <Link to={`/students/${student.id}`} className="student-card" key={student.id}>
              <div className="student-card-top">
                <Avatar name={student.name} seed={student.id} />
                <ArrowUpRight size={18} />
              </div>
              <h2>{student.name}</h2>
              <p>
                {student.subject}
                <span className="dot-separator">·</span>
                {student.level || 'Уровень не указан'}
              </p>
              {student.goal && <div className="student-goal">{student.goal}</div>}
              <div className="student-card-bottom">
                <span>
                  <strong>{formatMoney(student.price)}</strong> / {student.duration} мин
                </span>
                <span>{student.completedCount || 0} проведено</span>
              </div>
              {Boolean(student.debt) && (
                <div className="student-debt">Не оплачено: {formatMoney(student.debt!)}</div>
              )}
            </Link>
          ))}
        </div>
      )}
      {add && <StudentDialog onClose={() => setAdd(false)} />}
    </>
  );
}
interface StudentDetail {
  student: Student;
  lessons: Lesson[];
  hasMore: boolean;
  next: { id: string; startsAt: string } | null;
  summary: { completed: number; accrued: number; received: number };
}
export function StudentPage() {
  const { id } = useParams();
  const { me, revision, changed } = useWorkspace();
  const state = useApi<StudentDetail>(`/api/students/${id}`, revision);
  const [edit, setEdit] = useState(false),
    [plan, setPlan] = useState(false),
    [archive, setArchive] = useState(false);
  const { busy, run } = useTask();
  if (state.loading) return <Loading />;
  if (state.error || !state.data) return <ErrorState text={state.error} retry={state.reload} />;
  const { student, lessons, summary, next } = state.data;
  return (
    <>
      <BackLink to="/students">Все ученики</BackLink>
      <div className="student-profile-heading">
        <Avatar name={student.name} size="large" />
        <div>
          <div className="eyebrow">
            {student.archivedAt ? 'УЧЕНИК В АРХИВЕ' : 'КАРТОЧКА УЧЕНИКА'}
          </div>
          <h1>{student.name}</h1>
          <p>
            {student.subject} · {student.level || 'Уровень не указан'}
          </p>
        </div>
        <div className="heading-actions">
          <Button variant="secondary" onClick={() => setEdit(true)}>
            <Edit3 size={16} />
            Изменить
          </Button>
          {!student.archivedAt && <AddLessonButton onClick={() => setPlan(true)} />}
        </div>
      </div>
      <div className="metrics-row">
        <Metric label="Проведено занятий" value={summary.completed} />
        <Metric label="Начислено за всё время" value={formatMoney(summary.accrued)} />
        <Metric label="Получено за всё время" value={formatMoney(summary.received)} />
        <Metric
          label="Не оплачено"
          value={formatMoney(summary.accrued - summary.received)}
          tone={summary.accrued > summary.received ? 'amber' : ''}
        />
      </div>
      <div className="detail-grid">
        <section className="panel">
          <SectionTitle
            title="История занятий"
            extra={
              <span className="count-label">
                {lessons.length}
                {state.data.hasMore ? '+' : ''}
              </span>
            }
          />
          {lessons.length ? (
            <LessonList lessons={lessons} showDate />
          ) : (
            <Empty
              compact
              icon={BookOpen}
              title="История начинается с урока"
              text="Здесь будут занятия, ваши заметки и отчёты."
              action={
                !student.archivedAt && (
                  <Button variant="secondary" onClick={() => setPlan(true)}>
                    Запланировать урок
                  </Button>
                )
              }
            />
          )}
          {state.data.hasMore && (
            <div className="panel-footer">
              <span>Показаны последние 100 занятий. Полная история доступна в экспорте.</span>
            </div>
          )}
        </section>
        <aside className="stack">
          <section className="panel info-panel">
            <h2>Об ученике</h2>
            <div className="info-item">
              <span>Цель обучения</span>
              <p>{student.goal || 'Пока не указана'}</p>
            </div>
            <div className="info-item">
              <span>Обычный урок</span>
              <p>
                {student.duration} минут · {formatMoney(student.price)}
              </p>
            </div>
            <div className="info-item">
              <span>Заметки для себя</span>
              <p className="preserve-lines">
                {student.notes || 'Добавьте важные детали учебного процесса через «Изменить».'}
              </p>
            </div>
          </section>
          <section className="panel info-panel">
            <h2>Ближайший урок</h2>
            {next ? (
              <Link className="next-link" to={`/lessons/${next.id}`}>
                <CalendarDays size={18} />
                <span>{dateTime(next.startsAt, me.settings.timezone, 'd MMMM, HH:mm')}</span>
                <ArrowUpRight size={16} />
              </Link>
            ) : (
              <p className="muted">Пока не запланирован</p>
            )}
          </section>
          <Button variant="ghost" onClick={() => setArchive(true)}>
            <Archive size={16} />
            {student.archivedAt ? 'Вернуть из архива' : 'В архив'}
          </Button>
        </aside>
      </div>
      {edit && <StudentDialog initial={student} onClose={() => setEdit(false)} />}
      {plan && <LessonDialog studentId={student.id} onClose={() => setPlan(false)} />}
      <Confirm
        open={archive}
        title={student.archivedAt ? 'Вернуть ученика?' : 'Переместить в архив?'}
        onClose={() => setArchive(false)}
        busy={busy}
        label={student.archivedAt ? 'Вернуть' : 'В архив'}
        onConfirm={() =>
          void run(async () => {
            await api(`/api/students/${student.id}/archive`, 'POST', {
              archived: !student.archivedAt,
            });
            toast.success(student.archivedAt ? 'Ученик снова активен' : 'Ученик в архиве');
            setArchive(false);
            changed();
          })
        }
      >
        История занятий, отчёты и оплаты сохранятся.{' '}
        {student.archivedAt
          ? 'Вы снова сможете планировать новые занятия.'
          : 'Уже запланированные занятия останутся в расписании. Новые можно будет создать после возвращения ученика из архива.'}
      </Confirm>
    </>
  );
}
export function SchedulePage() {
  const { me, revision } = useWorkspace();
  const zone = me.settings.timezone;
  const [week, setWeek] = useState(() => today(zone).startOf('week').toISODate()!);
  const [view, setView] = useState<'week' | 'list'>('week');
  const [plan, setPlan] = useState<string | null>(null);
  const first = DateTime.fromISO(week, { zone }).setLocale('ru');
  const last = first.plus({ days: 7 });
  const state = useApi<{ lessons: Lesson[]; hasMore: boolean }>(
    `/api/lessons?from=${encodeURIComponent(first.toUTC().toISO()!)}&to=${encodeURIComponent(last.toUTC().toISO()!)}`,
    revision,
  );
  const calendarSync = useApi<GoogleCalendarLessonState[]>(
    '/api/integrations/google-calendar/states',
    revision,
  );
  const googleBusy = useApi<GoogleCalendarBusy>(
    calendarBusyPath(first.toUTC().toISO()!, last.toUTC().toISO()!),
    revision,
  );
  const syncStates = new Map(
    calendarSync.data?.map((entry) => [entry.lessonId, calendarStateLabels[entry.status]]),
  );
  const waiting = calendarSync.data?.some((entry) => entry.status === 'pending');
  const reloadCalendar = calendarSync.reload;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(reloadCalendar, 8000);
    return () => clearInterval(timer);
  }, [waiting, reloadCalendar]);
  const days = Array.from({ length: 7 }, (_, i) => first.plus({ days: i }));
  const lessons = state.data?.lessons || [];
  function busyOn(day: DateTime) {
    if (googleBusy.data?.status !== 'ready') return null;
    const endOfDay = day.plus({ days: 1 });
    return googleBusy.data.intervals.flatMap((interval) => {
      const start = DateTime.max(day, DateTime.fromISO(interval.start).setZone(zone));
      const end = DateTime.min(endOfDay, DateTime.fromISO(interval.end).setZone(zone));
      if (!(start < end)) return [];
      const format = `${start.toFormat('HH:mm')}–${end.equals(endOfDay) ? '24:00' : end.toFormat('HH:mm')}`;
      return [
        <div className="calendar-google-busy" key={interval.start + interval.end}>
          Занято · {format}
        </div>,
      ];
    });
  }
  function changeWeek(amount: number) {
    setWeek(first.plus({ weeks: amount }).toISODate()!);
  }
  return (
    <>
      <PageHeader
        eyebrow="ВРЕМЯ ПОД КОНТРОЛЕМ"
        title="Расписание"
        description="Все занятия на неделю. И место для важных планов."
        actions={<AddLessonButton onClick={() => setPlan(today(zone).toISODate()!)} />}
      />
      <div className="calendar-toolbar">
        <div className="calendar-navigation">
          <Button
            variant="secondary"
            onClick={() => setWeek(today(zone).startOf('week').toISODate()!)}
          >
            Сегодня
          </Button>
          <button
            className="icon-button bordered"
            aria-label="Предыдущая неделя"
            onClick={() => changeWeek(-1)}
          >
            <ChevronLeft size={18} />
          </button>
          <button
            className="icon-button bordered"
            aria-label="Следующая неделя"
            onClick={() => changeWeek(1)}
          >
            <ChevronRight size={18} />
          </button>
          <h2>
            {first.toFormat('d MMM')} — {last.minus({ days: 1 }).toFormat('d MMM yyyy')}
          </h2>
        </div>
        <div className="tabs calendar-tabs">
          <button className={view === 'week' ? 'active' : ''} onClick={() => setView('week')}>
            <LayoutGrid size={15} />
            Неделя
          </button>
          <button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}>
            <List size={16} />
            Список
          </button>
        </div>
      </div>
      {(googleBusy.data?.status === 'unavailable' || googleBusy.error) && (
        <p className="form-hint" role="status">
          Занятость Google сейчас неизвестна. Расписание TutorFlow доступно.
        </p>
      )}
      {state.loading ? (
        <Loading />
      ) : state.error ? (
        <ErrorState text={state.error} retry={state.reload} />
      ) : (
        <>
          <div className={`week-grid ${view === 'list' ? 'hide' : ''}`}>
            {days.map((day) => {
              const dayLessons = lessons.filter(
                (l) => DateTime.fromISO(l.startsAt).setZone(zone).toISODate() === day.toISODate(),
              );
              const isToday = day.hasSame(today(zone), 'day');
              return (
                <div className={`week-day ${isToday ? 'is-today' : ''}`} key={day.toISODate()}>
                  <button
                    className="week-day-heading"
                    onClick={() => setPlan(day.toISODate()!)}
                    aria-label={`Добавить занятие ${day.toFormat('d MMMM')}`}
                  >
                    <span>{day.toFormat('ccc')}</span>
                    <strong>{day.day}</strong>
                    <Plus size={13} />
                  </button>
                  <div className="week-day-body">
                    {busyOn(day)}
                    {dayLessons.map((lesson) => (
                      <Link
                        to={`/lessons/${lesson.id}`}
                        key={lesson.id}
                        className={`calendar-lesson calendar-${lesson.status.toLowerCase()}`}
                      >
                        <span className="calendar-time">
                          {dateTime(lesson.startsAt, zone, 'HH:mm')}
                          <span>{lesson.duration} мин</span>
                        </span>
                        <strong>{lesson.studentName}</strong>
                        <span>{lesson.subject}</span>
                        <span className="calendar-lesson-topic">
                          {lesson.topic || lesson.level || 'Индивидуальный урок'}
                        </span>
                        <div className="calendar-status">
                          {lesson.status === 'COMPLETED'
                            ? '✓ Проведено'
                            : lesson.status === 'CANCELLED'
                              ? 'Отменено'
                              : 'Запланировано'}
                        </div>
                        {syncStates.has(lesson.id) && (
                          <small className="calendar-google-status">
                            Google · {syncStates.get(lesson.id)}
                          </small>
                        )}
                      </Link>
                    ))}
                    <button className="calendar-add" onClick={() => setPlan(day.toISODate()!)}>
                      <Plus size={15} />
                      <span>Занятие</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          <div className={`schedule-list ${view === 'week' ? 'mobile-only' : ''}`}>
            {days.map((day) => {
              const dayLessons = lessons.filter(
                (l) => DateTime.fromISO(l.startsAt).setZone(zone).toISODate() === day.toISODate(),
              );
              return (
                <section className="panel day-list" key={day.toISODate()}>
                  <SectionTitle
                    title={day.toFormat('cccc, d MMMM')}
                    extra={
                      <button
                        className="icon-button"
                        aria-label={`Добавить занятие ${day.toFormat('d MMMM')}`}
                        onClick={() => setPlan(day.toISODate()!)}
                      >
                        <Plus size={17} />
                      </button>
                    }
                  />
                  {busyOn(day)}
                  {dayLessons.length ? (
                    <LessonList lessons={dayLessons} calendarLabels={syncStates} />
                  ) : !busyOn(day)?.length ? (
                    <div className="day-empty">
                      Свободный день<span>Можно запланировать что-то хорошее</span>
                    </div>
                  ) : null}
                </section>
              );
            })}
          </div>
          {state.data?.hasMore && (
            <p className="form-hint">
              Показаны первые 100 занятий недели. Полная история доступна в экспорте.
            </p>
          )}
          <div className="calendar-legend">
            <span>
              <i className="legend-planned" />
              Запланировано
            </span>
            <span>
              <i className="legend-completed" />
              Проведено
            </span>
            <span>
              <i className="legend-cancelled" />
              Отменено
            </span>
            <span className="legend-timezone">Время: {zone}</span>
          </div>
        </>
      )}
      {plan && <LessonDialog day={plan} onClose={() => setPlan(null)} />}
    </>
  );
}
export function FinancePage() {
  const { me, revision, changed } = useWorkspace();
  const [month, setMonth] = useState(() => today(me.settings.timezone).toFormat('yyyy-MM'));
  const [pay, setPay] = useState<Lesson | null>(null);
  const [paidDate, setPaidDate] = useState(() => today(me.settings.timezone).toISODate()!);
  const { busy, run } = useTask();
  const state = useApi<Finance>(`/api/finance?month=${month}`, revision);
  const date = DateTime.fromISO(`${month}-01`).setLocale('ru');
  return (
    <>
      <PageHeader
        eyebrow="ЦИФРЫ, КОТОРЫМ МОЖНО ДОВЕРЯТЬ"
        title="Финансы"
        description="Проведённые занятия, фактические поступления и ничего лишнего."
        actions={
          <div className="month-selector">
            <button
              className="icon-button"
              aria-label="Предыдущий месяц"
              onClick={() => setMonth(date.minus({ months: 1 }).toFormat('yyyy-MM'))}
            >
              <ChevronLeft size={18} />
            </button>
            <label>
              <span className="sr-only">Месяц финансового отчёта</span>
              <input
                type="month"
                value={month}
                onChange={(e) => {
                  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(e.target.value)) setMonth(e.target.value);
                }}
              />
            </label>
            <button
              className="icon-button"
              aria-label="Следующий месяц"
              onClick={() => setMonth(date.plus({ months: 1 }).toFormat('yyyy-MM'))}
            >
              <ChevronRight size={18} />
            </button>
          </div>
        }
      />
      {state.loading ? (
        <Loading />
      ) : state.error || !state.data ? (
        <ErrorState text={state.error} retry={state.reload} />
      ) : (
        <>
          <div className="metrics-row finance-metrics">
            <Metric
              label="Получено"
              value={formatMoney(state.data.received)}
              helper="По дате фактической оплаты"
              tone="green"
            />
            <Metric
              label="Начислено"
              value={formatMoney(state.data.accrued)}
              helper="За проведённые уроки месяца"
            />
            <Metric
              label="Не оплачено"
              value={formatMoney(state.data.debt)}
              helper="За всё время, включая архив"
              tone={state.data.debt ? 'amber' : ''}
            />
            <Metric
              label="Запланировано"
              value={formatMoney(state.data.planned)}
              helper="Будущие уроки этого месяца"
            />
          </div>
          <section className="panel">
            <SectionTitle
              title="Ожидают оплаты"
              extra={<span className="count-label">Уроков: {state.data.unpaid.length}</span>}
            />
            {state.data.unpaid.length ? (
              <div className="finance-table">
                <div className="table-header">
                  <span>Ученик и занятие</span>
                  <span>Дата урока</span>
                  <span>Сумма</span>
                  <span />
                </div>
                {state.data.unpaid.map((lesson) => (
                  <div className="finance-row" key={lesson.id}>
                    <Link className="finance-student" to={`/lessons/${lesson.id}`}>
                      <Avatar name={lesson.studentName} size="small" />
                      <div>
                        <strong>{lesson.studentName}</strong>
                        <span>{lesson.subject}</span>
                      </div>
                    </Link>
                    <span className="finance-date">
                      {dateTime(lesson.startsAt, me.settings.timezone, 'd MMM, HH:mm')}
                    </span>
                    <strong>{formatMoney(lesson.price)}</strong>
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setPaidDate(today(me.settings.timezone).toISODate()!);
                        setPay(lesson);
                      }}
                    >
                      <Check size={15} />
                      Оплачено
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <Empty
                compact
                icon={Wallet}
                title="Неоплаченных занятий нет"
                text="Когда вы проведёте платный урок, здесь можно будет отметить поступление."
              />
            )}
          </section>
          <section className="panel payment-history">
            <SectionTitle
              title="История поступлений"
              extra={<span className="count-label">{date.toFormat('LLLL yyyy')}</span>}
            />
            {state.data.payments.length ? (
              <div className="payment-list">
                {state.data.payments.map((payment) => (
                  <Link
                    to={`/lessons/${payment.lessonId}`}
                    key={payment.id}
                    className={`payment-row ${payment.voidedAt ? 'reversed' : ''}`}
                  >
                    <span className="payment-icon">
                      <ArrowDownToLine size={17} />
                    </span>
                    <div>
                      <strong>{payment.studentName}</strong>
                      <span>
                        {dateTime(payment.paidAt, me.settings.timezone, 'd MMMM yyyy')} ·{' '}
                        {payment.voidedAt ? 'Отметка отменена' : 'Оплата урока'}
                      </span>
                    </div>
                    <strong>
                      {payment.voidedAt ? '' : '+'}
                      {formatMoney(payment.amount)}
                    </strong>
                    <ArrowUpRight size={16} />
                  </Link>
                ))}
              </div>
            ) : (
              <Empty
                compact
                icon={Clock3}
                title="В этом месяце пока нет поступлений"
                text="Отмеченные оплаты появятся здесь по фактической дате получения денег."
              />
            )}
          </section>
          <p className="form-hint finance-note">
            Проведено за месяц: {state.data.completedCount}. В пилоте учитывается полная оплата
            каждого урока; предоплаты и частичные платежи пока не поддерживаются.
          </p>
        </>
      )}
      <Confirm
        open={Boolean(pay)}
        title="Отметить оплату?"
        label="Подтвердить поступление"
        busy={busy}
        onClose={() => setPay(null)}
        onConfirm={() =>
          void run(async () => {
            if (!pay) return;
            const paidAt = DateTime.fromISO(paidDate, { zone: me.settings.timezone })
              .set({ hour: 12 })
              .toUTC();
            const actual =
              paidAt.toMillis() > Date.now() ? new Date().toISOString() : paidAt.toISO();
            await api(`/api/lessons/${pay.id}/payment`, 'POST', { paidAt: actual });
            toast.success('Оплата отмечена');
            setPay(null);
            changed();
          })
        }
      >
        <p>
          {pay?.studentName} · {formatMoney(pay?.price ?? 0)}. Подтвердите, что деньги уже получены.
        </p>
        <Field label="Дата получения">
          <input
            type="date"
            value={paidDate}
            max={today(me.settings.timezone).toISODate()!}
            onChange={(e) => setPaidDate(e.target.value)}
            required
          />
        </Field>
      </Confirm>
    </>
  );
}
export function SettingsPage() {
  const { me, changed } = useWorkspace();
  const { busy, run } = useTask();
  const [theme, setTheme] = useState(me.settings.theme);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await run(async () => {
      await api('/api/settings', 'PUT', {
        name: data.get('name'),
        timezone: data.get('timezone'),
        theme,
      });
      applyTheme(theme);
      changed();
      toast.success('Настройки сохранены');
    });
  }
  async function download() {
    await run(async () => {
      const data = await api('/api/export');
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = 'tutorflow-export.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast.success('Экспорт подготовлен');
    });
  }
  return (
    <>
      <PageHeader
        eyebrow="УДОБНО ИМЕННО ВАМ"
        title="Настройки"
        description="Несколько деталей, чтобы пространство стало вашим."
      />
      <div className="settings-grid">
        <section className="panel settings-panel">
          <SectionTitle title="Профиль и пространство" extra={<Settings2 size={18} />} />
          <form className="form" onSubmit={submit}>
            <Field label="Ваше имя">
              <input name="name" defaultValue={me.user.name} required maxLength={100} />
            </Field>
            <Field
              label="Электронная почта"
              hint="Для изменения адреса потребуется подключение подтверждения через почту."
            >
              <input value={me.user.email} disabled />
            </Field>
            <Field
              label="Часовой пояс"
              hint="Расписание и месячные финансовые границы используют этот часовой пояс."
            >
              <input
                name="timezone"
                defaultValue={me.settings.timezone}
                list="timezones"
                required
              />
              <datalist id="timezones">
                {[
                  'Europe/Moscow',
                  'Europe/Kaliningrad',
                  'Europe/Samara',
                  'Asia/Yekaterinburg',
                  'Asia/Novosibirsk',
                  'Asia/Krasnoyarsk',
                  'Asia/Irkutsk',
                  'Asia/Vladivostok',
                  'Europe/Berlin',
                  'Asia/Tbilisi',
                  'UTC',
                ].map((zone) => (
                  <option key={zone}>{zone}</option>
                ))}
              </datalist>
            </Field>
            <fieldset className="theme-field">
              <legend>Оформление</legend>
              <div className="theme-options">
                {[
                  { value: 'light' as const, label: 'Светлое', icon: Sun },
                  { value: 'dark' as const, label: 'Тёмное', icon: Sparkles },
                  { value: 'system' as const, label: 'Как в системе', icon: LayoutGrid },
                ].map(({ value, label, icon: Icon }) => (
                  <label className={theme === value ? 'selected' : ''} key={value}>
                    <input
                      type="radio"
                      name="theme"
                      value={value}
                      checked={theme === value}
                      onChange={() => setTheme(value)}
                    />
                    <Icon size={19} />
                    {label}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="form-actions">
              <Button busy={busy} type="submit">
                Сохранить настройки
              </Button>
            </div>
          </form>
        </section>
        <aside className="stack">
          <GoogleCalendarSettingsCard />
          <section className="panel info-panel">
            <div className="settings-icon">
              <Sparkles size={21} />
            </div>
            <h2>Помощник с отчётами</h2>
            <p>
              ИИ помогает оформить ваши наблюдения. Каждый отчёт остаётся черновиком до вашей
              проверки.
            </p>
            <span className={`badge ${me.ai.available ? 'status-completed' : 'neutral'}`}>
              {me.ai.available ? 'Подключён' : 'Пока не подключён'}
            </span>
            <p className="form-hint">
              {me.ai.available
                ? `Использовано сегодня: ${me.ai.usedToday} из ${me.ai.dailyLimit}. Лимит обновляется в полночь вашего часового пояса.`
                : 'Ручные отчёты доступны всегда. Для подключения ИИ администратору нужен ключ API; инструкция есть в README проекта.'}
            </p>
          </section>
          <section className="panel info-panel">
            <div className="settings-icon">
              <ArrowDownToLine size={21} />
            </div>
            <h2>Ваши данные — с вами</h2>
            <p>Скачайте учеников, занятия, отчёты и историю оплат одним файлом JSON.</p>
            <Button variant="secondary" busy={busy} onClick={download}>
              <ArrowDownToLine size={16} />
              Экспортировать данные
            </Button>
          </section>
          <div className="settings-footnote">
            <p>
              Восстановление пароля через почту пока не подключено. Управляемое удаление аккаунта
              выполняет администратор по процедуре из README.
            </p>
          </div>
        </aside>
      </div>
    </>
  );
}
