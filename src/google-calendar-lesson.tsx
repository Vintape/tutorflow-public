import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { calendarStateLabels, type GoogleCalendarLessonState } from '../shared/google-calendar';
import { Button } from './components';
import { api, useApi, useTask, useWorkspace } from './lib';

export function GoogleCalendarLesson({ lessonId }: { lessonId: string }) {
  const { revision } = useWorkspace();
  const path = '/api/integrations/google-calendar/states';
  const state = useApi<GoogleCalendarLessonState[]>(
    `${path}?${new URLSearchParams({ lessonId })}`,
    revision,
  );
  const item = state.data?.[0];
  const { busy, run } = useTask();
  const reload = state.reload;
  const pending = item?.status === 'pending';
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(reload, 8000);
    return () => clearInterval(timer);
  }, [pending, reload]);
  if (!item) return null;
  return (
    <section className="panel note-panel lesson-boards" aria-labelledby="lesson-google-calendar">
      <h2 id="lesson-google-calendar">Google Календарь</h2>
      <p role="status" className="section-description">
        {calendarStateLabels[item.status]}
      </p>
      {item.reason === 'offline_cancellation' && (
        <p className="form-hint">
          Урок отменён, пока Google был отключён. Его копия всё ещё в календаре.
        </p>
      )}
      {item.eventLink && (
        <a className="button secondary" href={item.eventLink} target="_blank" rel="noreferrer">
          Открыть в Google Календаре
        </a>
      )}
      {item.status === 'reconnect' && (
        <Link className="button secondary" to="/settings">
          Открыть настройки
        </Link>
      )}
      {item.status === 'needs_review' && (
        <div className="lesson-board-links">
          <Button
            variant="secondary"
            busy={busy}
            onClick={() =>
              void run(async () => {
                await api(`${path}/${lessonId}`, 'POST', { resolution: 'keep' });
                reload();
              })
            }
          >
            Оставить как есть
          </Button>
          <Button
            variant="secondary"
            busy={busy}
            onClick={() =>
              void run(async () => {
                await api(`${path}/${lessonId}`, 'POST', { resolution: 'restore' });
                reload();
              })
            }
          >
            {item.reason === 'offline_cancellation'
              ? 'Сверить и удалить копию'
              : 'Сверить и обновить копию'}
          </Button>
        </div>
      )}
    </section>
  );
}
