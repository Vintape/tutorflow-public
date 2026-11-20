import { useState, type FormEvent } from 'react';
import { DateTime } from 'luxon';
import { toast } from 'sonner';
import { CalendarDays, CircleAlert } from 'lucide-react';
import type { Lesson, Student } from '../shared/domain';
import { calendarBusyPath, type GoogleCalendarBusy } from '../shared/google-calendar';
import { localToUTC, parseMoney } from '../shared/domain';
import { api, ApiError, errorMessage, useApi, useTask, useWorkspace } from './lib';
import { Button, Field, Loading, Modal, ErrorState } from './components';

export function StudentDialog({ onClose, initial }: { onClose: () => void; initial?: Student }) {
  const { changed } = useWorkspace();
  const { busy, run } = useTask();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await run(async () => {
      await api(
        initial ? `/api/students/${initial.id}` : '/api/students',
        initial ? 'PUT' : 'POST',
        {
          name: data.get('name'),
          subject: data.get('subject'),
          level: data.get('level'),
          price: parseMoney(String(data.get('price'))),
          duration: Number(data.get('duration')),
          goal: data.get('goal'),
          notes: data.get('notes'),
        },
      );
      toast.success(initial ? 'Данные ученика обновлены' : 'Ученик добавлен');
      changed();
      onClose();
    });
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={initial ? 'Редактировать ученика' : 'Новый ученик'}
      description="Достаточно имени, предмета и обычной стоимости урока."
    >
      <form onSubmit={submit} className="form">
        <Field label="Имя или псевдоним">
          <input
            name="name"
            placeholder="Например, Саша"
            defaultValue={initial?.name}
            required
            maxLength={100}
            autoComplete="off"
            autoFocus
          />
        </Field>
        <div className="form-grid">
          <Field label="Предмет">
            <input
              name="subject"
              placeholder="Математика"
              list="subjects"
              defaultValue={initial?.subject}
              required
              maxLength={80}
            />
          </Field>
          <Field label="Класс или уровень">
            <input
              name="level"
              placeholder="8 класс"
              defaultValue={initial?.level}
              maxLength={80}
            />
          </Field>
        </div>
        <datalist id="subjects">
          {['Математика', 'Русский язык', 'Английский язык', 'Информатика', 'Физика', 'Химия'].map(
            (v) => (
              <option key={v}>{v}</option>
            ),
          )}
        </datalist>
        <div className="form-grid">
          <Field label="Стоимость урока, ₽">
            <input
              name="price"
              inputMode="decimal"
              placeholder="1 500"
              defaultValue={initial ? String(initial.price / 100) : '1500'}
              required
            />
          </Field>
          <Field label="Длительность, мин">
            <input
              name="duration"
              type="number"
              min={15}
              max={480}
              defaultValue={initial?.duration ?? 60}
              required
            />
          </Field>
        </div>
        <Field label="Цель обучения · необязательно">
          <input
            name="goal"
            placeholder="Подготовиться к ОГЭ, разобраться в предмете…"
            defaultValue={initial?.goal}
            maxLength={2000}
          />
        </Field>
        <Field
          label="Заметки для себя · необязательно"
          hint="Эти заметки остаются в карточке ученика и не передаются ИИ."
        >
          <textarea
            name="notes"
            rows={3}
            defaultValue={initial?.notes}
            maxLength={5000}
            placeholder="Что важно помнить об учебном процессе"
          />
        </Field>
        {initial && (
          <p className="form-hint">
            Изменение цены и длительности действует только для новых занятий.
          </p>
        )}
        <div className="form-actions">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button type="submit" busy={busy}>
            {initial ? 'Сохранить изменения' : 'Добавить ученика'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
export function LessonDialog({
  onClose,
  studentId,
  initial,
  day,
}: {
  onClose: () => void;
  studentId?: string;
  initial?: Lesson;
  day?: string;
}) {
  const { revision } = useWorkspace();
  const state = useApi<Student[]>('/api/students', revision);
  return (
    <Modal
      open
      onClose={onClose}
      title={initial ? 'Изменить занятие' : 'Запланировать урок'}
      description="Цена и длительность подставятся из карточки ученика."
    >
      {state.loading ? (
        <Loading />
      ) : state.error ? (
        <ErrorState text={state.error} retry={state.reload} />
      ) : (
        <LessonForm
          students={state.data || []}
          onClose={onClose}
          studentId={studentId}
          initial={initial}
          day={day}
        />
      )}
    </Modal>
  );
}
function LessonForm({
  students,
  onClose,
  studentId,
  initial,
  day,
}: {
  students: Student[];
  onClose: () => void;
  studentId?: string;
  initial?: Lesson;
  day?: string;
}) {
  const { me, changed } = useWorkspace();
  const [selected, setSelected] = useState(
    initial?.studentId || studentId || students[0]?.id || '',
  );
  const selectedStudent = students.find((s) => s.id === selected);
  const [price, setPrice] = useState(String((initial?.price ?? selectedStudent?.price ?? 0) / 100));
  const [duration, setDuration] = useState(initial?.duration ?? selectedStudent?.duration ?? 60);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [allowConflict, setAllowConflict] = useState(false);
  const timezone = me.settings.timezone;
  const date = initial
    ? DateTime.fromISO(initial.startsAt).setZone(timezone)
    : day
      ? DateTime.fromISO(day, { zone: timezone }).set({ hour: 16 })
      : DateTime.now().setZone(timezone).plus({ hours: 1 }).startOf('hour');
  const [startsAt, setStartsAt] = useState(() => date.toFormat("yyyy-MM-dd'T'HH:mm"));
  const [confirmGoogleOverlap, setConfirmGoogleOverlap] = useState(false);
  const selectedTime = DateTime.fromISO(startsAt, { zone: timezone });
  const busyDay = (selectedTime.isValid ? selectedTime : date).startOf('day');
  const googleBusy = useApi<GoogleCalendarBusy>(
    calendarBusyPath(busyDay.toUTC().toISO()!, busyDay.plus({ days: 2 }).toUTC().toISO()!),
  );
  const googleOverlap =
    selectedTime.isValid &&
    googleBusy.data?.status === 'ready' &&
    googleBusy.data.intervals.some(
      ({ start, end }) =>
        Date.parse(end) > selectedTime.toMillis() &&
        Date.parse(start) < selectedTime.plus({ minutes: duration }).toMillis(),
    );
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (busy || (googleOverlap && !confirmGoogleOverlap)) return;
    setBusy(true);
    try {
      const payload = {
        startsAt: localToUTC(String(data.get('startsAt')), timezone),
        duration,
        price: parseMoney(price),
        topic: data.get('topic'),
        allowConflict,
      };
      await api(
        initial ? `/api/lessons/${initial.id}` : '/api/lessons',
        initial ? 'PATCH' : 'POST',
        initial ? { ...payload, version: initial.version } : { ...payload, studentId: selected },
      );
      toast.success(initial ? 'Занятие обновлено' : 'Занятие запланировано');
      changed();
      onClose();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'CONFLICT') setConflict(true);
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  if (!students.length && !initial)
    return (
      <div className="empty compact">
        <CalendarDays size={30} />
        <h3>Сначала добавьте ученика</h3>
        <p>После этого можно будет запланировать первое занятие.</p>
        <Button variant="secondary" onClick={onClose}>
          Понятно
        </Button>
      </div>
    );
  return (
    <form onSubmit={submit} className="form">
      <Field label="Ученик">
        <select
          value={selected}
          disabled={Boolean(initial || studentId)}
          required
          onChange={(e) => {
            const student = students.find((s) => s.id === e.target.value);
            setSelected(e.target.value);
            if (student) {
              setPrice(String(student.price / 100));
              setDuration(student.duration);
              setConfirmGoogleOverlap(false);
            }
          }}
        >
          {initial && !selectedStudent && (
            <option value={initial.studentId}>{initial.studentName}</option>
          )}
          {students.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} · {s.subject}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Дата и время" hint={`Часовой пояс: ${timezone}`}>
        <input
          name="startsAt"
          type="datetime-local"
          value={startsAt}
          onChange={(event) => {
            setStartsAt(event.target.value);
            setConfirmGoogleOverlap(false);
          }}
          required
        />
      </Field>
      <div className="form-grid">
        <Field label="Длительность, мин">
          <input
            type="number"
            min={15}
            max={480}
            value={duration}
            onChange={(e) => {
              setDuration(Number(e.target.value));
              setConfirmGoogleOverlap(false);
            }}
            required
          />
        </Field>
        <Field label="Стоимость урока, ₽">
          <input
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            required
          />
        </Field>
      </div>
      <Field label="Тема · необязательно">
        <input
          name="topic"
          placeholder="Например, квадратные уравнения"
          maxLength={200}
          defaultValue={initial?.topic}
        />
      </Field>
      {googleOverlap && (
        <div className="callout warning">
          <CircleAlert size={18} />
          <div>
            <strong>В это время вы заняты по Google Календарю</strong>
            <label className="check-label">
              <input
                type="checkbox"
                checked={confirmGoogleOverlap}
                onChange={(event) => setConfirmGoogleOverlap(event.target.checked)}
              />
              Сохранить занятие на это время
            </label>
          </div>
        </div>
      )}
      {(googleBusy.data?.status === 'unavailable' || googleBusy.error) && (
        <p className="form-hint" role="status">
          Занятость Google сейчас неизвестна.
        </p>
      )}
      {conflict && (
        <div className="callout warning">
          <CircleAlert size={18} />
          <div>
            <strong>В расписании есть пересечение</strong>
            <label className="check-label">
              <input
                type="checkbox"
                checked={allowConflict}
                onChange={(e) => setAllowConflict(e.target.checked)}
              />
              Разрешить наложение для этого урока
            </label>
          </div>
        </div>
      )}
      <div className="form-actions">
        <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
          Отмена
        </Button>
        <Button type="submit" busy={busy} disabled={googleOverlap && !confirmGoogleOverlap}>
          {initial ? 'Сохранить изменения' : 'Запланировать'}
        </Button>
      </div>
    </form>
  );
}
