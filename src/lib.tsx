import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { DateTime } from 'luxon';
import { toast } from 'sonner';
import type { Me } from '../shared/domain';

export class ApiError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  method = 'GET',
  data?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: data === undefined ? undefined : JSON.stringify(data),
    signal,
  });
  const body = await response.json();
  if (!response.ok) {
    const translations: Record<string, string> = {
      INVALID_EMAIL_OR_PASSWORD: 'Неверная почта или пароль',
      USER_ALREADY_EXISTS: 'Аккаунт с такой почтой уже есть',
      USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: 'Аккаунт с такой почтой уже есть',
      PASSWORD_TOO_SHORT: 'Пароль должен содержать минимум 10 символов',
      INVALID_EMAIL: 'Проверьте адрес почты',
      TOO_MANY_REQUESTS: 'Слишком много попыток. Подождите минуту.',
    };
    throw new ApiError(
      translations[body.code] || body.error || body.message || 'Не удалось выполнить действие',
      body.code || 'ERROR',
      response.status,
    );
  }
  return body as T;
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Не удалось выполнить действие';
}
export function useTask() {
  const [busy, setBusy] = useState(false);
  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    if (busy) return;
    setBusy(true);
    try {
      return await fn();
    } catch (error) {
      toast.error(errorMessage(error));
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return { busy, run };
}
interface WorkspaceContext {
  me: Me;
  revision: number;
  changed: () => void;
  signOut: () => Promise<void>;
}
const Context = createContext<WorkspaceContext | null>(null);
export const useWorkspace = () => {
  const context = useContext(Context);
  if (!context) throw new Error('Workspace provider missing');
  return context;
};
export function WorkspaceProvider({
  me,
  revision,
  changed,
  signOut,
  children,
}: WorkspaceContext & { children: ReactNode }) {
  return <Context.Provider value={{ me, revision, changed, signOut }}>{children}</Context.Provider>;
}
export function useApi<T>(url: string, revision = 0) {
  const [state, setState] = useState<{ data: T | null; error: string; key: string; url: string }>({
    data: null,
    error: '',
    key: '',
    url: '',
  });
  const [attempt, setAttempt] = useState(0);
  const key = `${url}:${revision}:${attempt}`;
  const reload = useCallback(() => setAttempt((v) => v + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    api<T>(url, 'GET', undefined, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setState({ data, error: '', key, url });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setState({ data: null, error: errorMessage(error), key, url });
      });
    return () => controller.abort();
  }, [url, key]);
  return {
    data: state.url === url ? state.data : null,
    error: state.key === key ? state.error : '',
    loading: state.key !== key,
    reload,
  };
}
export function dateTime(value: string, zone: string, format = 'd MMM, HH:mm') {
  return DateTime.fromISO(value).setZone(zone).setLocale('ru').toFormat(format);
}
export function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((v) => v[0])
    .join('')
    .toUpperCase();
}
export function today(zone: string) {
  return DateTime.now().setZone(zone).setLocale('ru');
}
export function applyTheme(theme: Me['settings']['theme']) {
  document.documentElement.dataset.theme =
    theme === 'system'
      ? matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : theme;
}
