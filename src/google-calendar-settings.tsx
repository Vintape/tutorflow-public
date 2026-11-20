import { useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import type { GoogleCalendarSettings, GoogleCalendarStatus } from '../shared/google-calendar';
import { Button, Confirm, ErrorState, Field, Loading } from './components';
import { api, useApi, useTask } from './lib';

const path = '/api/integrations/google-calendar';
const labels: Record<GoogleCalendarStatus, string> = {
  unavailable: 'Сервер ещё не настроен',
  disconnected: 'Не подключён',
  pending_calendar: 'Доступ получен',
  calendar_uncertain: 'Проверьте календарь в Google',
  ready: 'Календарь создан',
  connected: 'Подключён',
  needs_reconnect: 'Подключите снова',
};
const feedback: Record<string, string> = {
  authorized: 'Доступ Google подтверждён.',
  'invalid-state': 'Срок подключения истёк или открыта другая сессия. Начните подключение заново.',
  denied: 'Разрешение Google не получено.',
  'different-account': 'Подключите тот же аккаунт Google, который использовался ранее.',
  failed: 'Не удалось подтвердить доступ Google.',
};

export function GoogleCalendarSettingsCard() {
  const [query, setQuery] = useSearchParams();
  const state = useApi<GoogleCalendarSettings>(path);
  const [calendarId, setCalendarId] = useState('');
  const [confirmation, setConfirmation] = useState<'sync' | 'disconnect' | 'retry-calendar'>();
  const { busy, run } = useTask();
  const status = state.data?.status;
  const callback = query.get('googleCalendar') ?? '';
  const connectable = status === 'disconnected' || status === 'needs_reconnect';
  async function update(
    action: 'calendar' | 'sync' | 'disconnect' | 'busy/disable',
    body: Record<string, unknown> = {},
  ) {
    await run(async () => {
      try {
        await api(path + '/' + action, 'POST', body);
        setConfirmation(undefined);
      } finally {
        state.reload();
      }
    });
  }
  async function connect(includeBusy = false) {
    await run(async () => {
      const { authorizationUrl } = await api<{ authorizationUrl: string }>(
        path + '/connect',
        'POST',
        { includeBusy },
      );
      if (query.has('googleCalendar')) setQuery({}, { replace: true });
      window.location.assign(authorizationUrl);
    });
  }
  return (
    <section className="panel info-panel">
      <div className="settings-icon">
        <CalendarDays size={21} />
      </div>
      <h2>Google Календарь</h2>
      <p>Отправляйте время занятий в отдельный календарь TutorFlow.</p>
      {state.loading && !status ? (
        <Loading />
      ) : state.error ? (
        <ErrorState text={state.error} retry={state.reload} />
      ) : status ? (
        <>
          <span className={`badge ${status === 'connected' ? 'status-completed' : 'neutral'}`}>
            {labels[status]}
          </span>
          {callback && Object.hasOwn(feedback, callback) && (
            <p role="status">{feedback[callback]}</p>
          )}
          {connectable && (
            <Button variant="secondary" busy={busy} onClick={() => void connect()}>
              {status === 'needs_reconnect' ? 'Подключить снова' : 'Подключить Google'}
            </Button>
          )}
          {status === 'pending_calendar' && (
            <Button variant="secondary" busy={busy} onClick={() => void update('calendar')}>
              Создать календарь TutorFlow
            </Button>
          )}
          {status === 'calendar_uncertain' && (
            <>
              <form
                className="form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void update('calendar', { existingCalendarId: calendarId.trim() });
                }}
              >
                <p>
                  Если календарь TutorFlow появился в Google, скопируйте его идентификатор из
                  настроек календаря.
                </p>
                <Field label="Идентификатор календаря">
                  <input
                    value={calendarId}
                    onChange={(event) => setCalendarId(event.target.value)}
                    maxLength={1024}
                    required
                  />
                </Field>
                <Button variant="secondary" type="submit" disabled={!calendarId.trim()} busy={busy}>
                  Проверить календарь
                </Button>
              </form>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => setConfirmation('retry-calendar')}
              >
                Календарь не появился в Google
              </Button>
            </>
          )}
          {status === 'ready' && (
            <Button variant="secondary" busy={busy} onClick={() => setConfirmation('sync')}>
              Включить отправку
            </Button>
          )}
          {status === 'connected' && (
            <Button
              variant="secondary"
              busy={busy}
              onClick={() =>
                void (state.data?.canReadBusy ? update('busy/disable') : connect(true))
              }
            >
              {state.data?.canReadBusy
                ? 'Скрыть занятость Google'
                : 'Показать занятость из личного календаря'}
            </Button>
          )}
          {status !== 'unavailable' && status !== 'disconnected' && (
            <Button variant="ghost" disabled={busy} onClick={() => setConfirmation('disconnect')}>
              Отключить Google
            </Button>
          )}
          {confirmation && (
            <Confirm
              open
              title={
                confirmation === 'sync'
                  ? 'Включить отправку занятий?'
                  : confirmation === 'disconnect'
                    ? 'Отключить Google Календарь?'
                    : 'Повторить создание календаря?'
              }
              label={
                confirmation === 'sync'
                  ? 'Отправлять занятия'
                  : confirmation === 'disconnect'
                    ? 'Отключить'
                    : 'Проверил, создать снова'
              }
              busy={busy}
              onClose={() => setConfirmation(undefined)}
              onConfirm={() =>
                void (confirmation === 'retry-calendar'
                  ? update('calendar', { retryAfterReview: true })
                  : update(confirmation))
              }
            >
              {confirmation === 'sync'
                ? `Будущих запланированных занятий к отправке: ${state.data?.futureLessons ?? 0}. В Google отправятся время и длительность.`
                : confirmation === 'disconnect'
                  ? 'Новые занятия перестанут отправляться. Ранее отправленные события останутся в Google.'
                  : 'Сначала убедитесь, что календарь TutorFlow не появился в списке календарей Google.'}
            </Confirm>
          )}
        </>
      ) : null}
    </section>
  );
}
