export type GoogleCalendarStatus =
  | 'unavailable'
  | 'disconnected'
  | 'pending_calendar'
  | 'calendar_uncertain'
  | 'ready'
  | 'connected'
  | 'needs_reconnect';

export interface GoogleCalendarSettings {
  status: GoogleCalendarStatus;
  futureLessons: number;
  hasCalendar: boolean;
  canReadBusy?: boolean;
}

export interface GoogleCalendarBusyInterval {
  start: string;
  end: string;
}
export interface GoogleCalendarBusy {
  status: 'inactive' | 'ready' | 'unavailable';
  intervals: GoogleCalendarBusyInterval[];
}

export function calendarBusyPath(from: string, to: string) {
  return `/api/integrations/google-calendar/busy?${new URLSearchParams({ from, to })}`;
}

export interface GoogleCalendarLessonState {
  lessonId: string;
  status: 'pending' | 'synced' | 'needs_review' | 'reconnect';
  eventLink: string | null;
  reason: string | null;
}

export const calendarStateLabels: Record<GoogleCalendarLessonState['status'], string> = {
  pending: 'Ожидает отправки',
  synced: 'Синхронизировано',
  needs_review: 'Нужна проверка',
  reconnect: 'Подключите Google снова',
};
