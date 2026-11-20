import {
  lazy,
  StrictMode,
  Suspense,
  useCallback,
  useEffect,
  useState,
  type FormEvent,
} from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  createBrowserRouter,
  RouterProvider,
  Link,
  NavLink,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom';
import {
  ArrowRight,
  BookOpen,
  CalendarDays,
  Check,
  CheckCheck,
  ChevronRight,
  GraduationCap,
  LayoutDashboard,
  Presentation,
  LogOut,
  Menu,
  Settings,
  ShieldCheck,
  Sparkles,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import { Toaster, toast } from 'sonner';
import type { Me } from '../shared/domain';
import { api, applyTheme, dateTime, errorMessage, initials, WorkspaceProvider } from './lib';
import { Button, ErrorState, Field, Loading } from './components';
import {
  Dashboard,
  StudentsPage,
  StudentPage,
  SchedulePage,
  FinancePage,
  SettingsPage,
} from './pages';
import './styles.css';
const LessonPage = lazy(() =>
  import('./report-page').then((module) => ({ default: module.LessonPage })),
);
const BoardsPage = lazy(() => import('./board-pages').then((m) => ({ default: m.BoardsPage })));
const BoardPage = lazy(() => import('./board-pages').then((m) => ({ default: m.BoardPage })));
const GuestBoardPage = lazy(() => import('./board-pages').then((m) => ({ default: m.GuestBoardPage })));

function Brand({ light = false }: { light?: boolean }) {
  return (
    <Link to="/" className={`brand ${light ? 'light' : ''}`} aria-label="TutorFlow — главная">
      <span className="brand-icon">
        <GraduationCap size={24} strokeWidth={1.8} />
      </span>
      <span>
        Tutor<span className="brand-flow">Flow</span>
        <small>пространство репетитора</small>
      </span>
    </Link>
  );
}

function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const load = useCallback(async () => {
    try {
      const data = await api<Me>('/api/me');
      setMe(data);
      applyTheme(data.settings.theme);
      setError('');
    } catch (error) {
      if (error && typeof error === 'object' && 'status' in error && error.status === 401)
        setMe(null);
      else setError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    api<Me>('/api/me', 'GET', undefined, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) {
          setMe(data);
          applyTheme(data.settings.theme);
          setError('');
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted && error?.status !== 401) setError(errorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      if (me?.settings.theme === 'system') applyTheme('system');
    };
    media.addEventListener('change', handler);
    return () => media.removeEventListener('change', handler);
  }, [me?.settings.theme]);
  const changed = useCallback(() => {
    setRevision((v) => v + 1);
    void load();
  }, [load]);
  async function signOut() {
    try {
      await api('/api/auth/sign-out', 'POST', {});
      setMe(null);
      setRevision(0);
      applyTheme('light');
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }
  if (loading)
    return (
      <div className="app-loading">
        <Brand />
        <Loading />
      </div>
    );
  if (error)
    return (
      <div className="app-loading">
        <Brand />
        <ErrorState text={error} retry={load} />
      </div>
    );
  if (!me) return <AuthPage onSuccess={load} />;
  return (
    <WorkspaceProvider me={me} revision={revision} changed={changed} signOut={signOut}>
      <Suspense
        fallback={
          <div className="main-content">
            <Loading />
          </div>
        }
      >
        <Routes>
          <Route path="boards/:id" element={<BoardPage />} />
          <Route element={<Shell me={me} signOut={signOut} />}>
            <Route index element={<Dashboard />} />
            <Route path="students" element={<StudentsPage />} />
            <Route path="students/:id" element={<StudentPage />} />
            <Route path="schedule" element={<SchedulePage />} />
            <Route path="lessons/:id" element={<LessonPage />} />
            <Route path="finance" element={<FinancePage />} />
            <Route path="boards" element={<BoardsPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </Suspense>
    </WorkspaceProvider>
  );
}
const nav = [
  { to: '/', label: 'Главная', icon: LayoutDashboard },
  { to: '/students', label: 'Ученики', icon: Users },
  { to: '/schedule', label: 'Расписание', icon: CalendarDays },
  { to: '/boards', label: 'Доски', icon: Presentation },
  { to: '/finance', label: 'Финансы', icon: Wallet },
  { to: '/settings', label: 'Настройки', icon: Settings },
];
function Shell({ me, signOut }: { me: Me; signOut: () => Promise<void> }) {
  const [mobile, setMobile] = useState(false);
  const location = useLocation();
  const section =
    nav.find((n) => n.to !== '/' && location.pathname.startsWith(n.to))?.label ||
    (location.pathname.startsWith('/lessons') ? 'Занятие' : 'Главная');
  return (
    <div className="app-shell">
      {mobile && <div className="nav-backdrop" onClick={() => setMobile(false)} />}
      <aside className={`sidebar ${mobile ? 'is-open' : ''}`}>
        <div className="sidebar-brand">
          <Brand />
          <button
            className="icon-button mobile-close"
            onClick={() => setMobile(false)}
            aria-label="Закрыть меню"
          >
            <X size={20} />
          </button>
        </div>
        <div className="workspace-label">
          <span className="workspace-square">Л</span>
          <div>
            Личное пространство<small>Всё для ваших занятий</small>
          </div>
        </div>
        <div className="nav-label">РАБОЧЕЕ ПРОСТРАНСТВО</div>
        <nav aria-label="Основная навигация">
          {nav.filter((item) => item.to !== '/boards' || me.boards?.enabled).map(({ to, label, icon: Icon }) => (
            <NavLink
              end={to === '/'}
              key={to}
              to={to}
              onClick={() => setMobile(false)}
              className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
            >
              <Icon size={19} strokeWidth={1.7} />
              {label}
              {to === '/students' && me.studentCount > 0 && (
                <span className="nav-count">{me.studentCount}</span>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <span className="small-leaf">✦</span>
            <strong>Больше времени на главное</strong>
            <p>Провели урок — сохранили заметку. Всё остальное под рукой.</p>
          </div>
          <div className="account">
            <span className="account-avatar">{initials(me.user.name)}</span>
            <Link to="/settings" onClick={() => setMobile(false)}>
              <strong>{me.user.name}</strong>
              <span>Личный аккаунт</span>
            </Link>
            <button
              className="icon-button"
              onClick={() => void signOut()}
              aria-label="Выйти из аккаунта"
              title="Выйти из аккаунта"
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-area">
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="icon-button menu-toggle"
              aria-label="Открыть меню"
              onClick={() => setMobile(true)}
            >
              <Menu size={22} />
            </button>
            <span className="breadcrumb-workspace">Рабочее пространство</span>
            <ChevronRight size={14} className="breadcrumb-workspace" />
            <span>{section}</span>
          </div>
          <div className="topbar-right">
            <span className="early-access">
              <span />
              Ранний доступ
            </span>
            <span className="top-date">
              {dateTime(new Date().toISOString(), me.settings.timezone, 'd MMMM yyyy')}
            </span>
          </div>
        </header>
        <main className="main-content" key={location.pathname}>
          <Outlet />
        </main>
        <footer className="app-footer">
          <span>TutorFlow</span>
          <span>Меньше рутины. Больше преподавания.</span>
        </footer>
      </div>
    </div>
  );
}
function AuthPage({ onSuccess }: { onSuccess: () => Promise<void> }) {
  const [register, setRegister] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    const data = new FormData(event.currentTarget);
    try {
      await api(`/api/auth/${register ? 'sign-up' : 'sign-in'}/email`, 'POST', {
        email: String(data.get('email')).trim(),
        password: data.get('password'),
        ...(register ? { name: String(data.get('name')).trim() } : {}),
      });
      await onSuccess();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-page">
      <section className="auth-story">
        <Brand light />
        <div className="auth-story-inner">
          <div className="eyebrow light-text">ВАШЕ НОВОЕ РАБОЧЕЕ ПРОСТРАНСТВО</div>
          <h1>
            Больше времени
            <br />
            на преподавание.
            <br />
            <span>Меньше — на рутину.</span>
          </h1>
          <p>
            Ученики, занятия, отчёты и оплаты.
            <br />
            Всё важное в одном спокойном месте.
          </p>
          <div className="auth-illustration" aria-hidden="true">
            <div className="orbit orbit-1" />
            <div className="orbit orbit-2" />
            <div className="illustration-center">
              <GraduationCap size={60} strokeWidth={1.2} />
            </div>
            <span className="floating-icon one">
              <CalendarDays size={24} />
            </span>
            <span className="floating-icon two">
              <BookOpen size={24} />
            </span>
            <span className="floating-icon three">
              <CheckCheck size={24} />
            </span>
            <span className="illustration-star">✦</span>
          </div>
          <div className="auth-benefits">
            <span>
              <Check size={16} />
              Расписание под контролем
            </span>
            <span>
              <Check size={16} />
              Заметка превращается в отчёт
            </span>
            <span>
              <Check size={16} />
              Понятный учёт оплат
            </span>
          </div>
        </div>
        <div className="auth-tagline">Провели урок — остальное под контролем.</div>
      </section>
      <section className="auth-form-area">
        <div className="auth-mobile-brand">
          <Brand />
        </div>
        <div className="auth-form-card">
          <span className="auth-welcome-icon">
            <Sparkles size={24} strokeWidth={1.5} />
          </span>
          <h2>{register ? 'Начните с чистого листа' : 'Рады видеть вас снова'}</h2>
          <p>
            {register
              ? 'Создайте своё пространство для учеников и занятий.'
              : 'Ваши ученики и планы уже ждут вас.'}
          </p>
          <div className="auth-tabs">
            <button
              className={!register ? 'active' : ''}
              onClick={() => {
                setRegister(false);
                setError('');
              }}
            >
              Вход
            </button>
            <button
              className={register ? 'active' : ''}
              onClick={() => {
                setRegister(true);
                setError('');
              }}
            >
              Регистрация
            </button>
          </div>
          <form key={String(register)} onSubmit={submit} className="form">
            {register && (
              <Field label="Как к вам обращаться">
                <input
                  name="name"
                  autoComplete="name"
                  placeholder="Ваше имя"
                  required
                  maxLength={100}
                />
              </Field>
            )}
            <Field label="Электронная почта">
              <input
                name="email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                required
                maxLength={254}
              />
            </Field>
            <Field label="Пароль" hint={register ? 'Не меньше 10 символов' : undefined}>
              <input
                name="password"
                type="password"
                autoComplete={register ? 'new-password' : 'current-password'}
                placeholder={register ? 'Придумайте надёжный пароль' : 'Введите пароль'}
                minLength={register ? 10 : 1}
                maxLength={128}
                required
              />
            </Field>
            {error && (
              <div className="inline-error" role="alert">
                {error}
              </div>
            )}
            <Button type="submit" busy={busy} className="full-width">
              {register ? 'Создать пространство' : 'Войти в TutorFlow'}
              <ArrowRight size={17} />
            </Button>
          </form>
          <p className="auth-note">
            <ShieldCheck size={16} />
            Ваши учебные записи доступны только вам.
          </p>
          {!register && (
            <p className="auth-support">
              Восстановление пароля через почту пока не подключено. Сохраните пароль в надёжном
              месте.
            </p>
          )}
        </div>
        <div className="auth-bottom">Создано для тех, кто помогает учиться.</div>
      </section>
    </div>
  );
}

const root =
  (import.meta.hot?.data.root as Root | undefined) || createRoot(document.getElementById('root')!);
if (import.meta.hot) import.meta.hot.data.root = root;
function RootRoutes() {
  return (
    <>
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="join/:id" element={<GuestBoardPage />} />
          <Route path="*" element={<App />} />
        </Routes>
      </Suspense>
      <Toaster position="bottom-right" richColors closeButton />
    </>
  );
}
const router = createBrowserRouter([{ path: '*', element: <RootRoutes /> }]);
root.render(<StrictMode><RouterProvider router={router} /></StrictMode>);
