import * as Dialog from '@radix-ui/react-dialog';
import {
  ArrowLeft,
  ArrowUpRight,
  CalendarDays,
  Check,
  ChevronRight,
  CircleAlert,
  Inbox,
  LoaderCircle,
  Plus,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  Children,
  cloneElement,
  isValidElement,
  useId,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import type { Lesson, LessonStatus } from '../shared/domain';
import { formatMoney } from '../shared/domain';
import { dateTime, initials, useWorkspace } from './lib';

export function Button({
  children,
  variant = 'primary',
  className = '',
  busy = false,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  busy?: boolean;
}) {
  return (
    <button
      className={`button ${variant} ${className}`}
      {...props}
      disabled={props.disabled || busy}
    >
      {busy && <LoaderCircle size={16} className="spin" />}
      {children}
    </button>
  );
}
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className={`dialog ${wide ? 'wide' : ''}`}>
          <div className="dialog-heading">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              <Dialog.Description>
                {description || 'Заполните данные и сохраните изменения.'}
              </Dialog.Description>
            </div>
            <Dialog.Close className="icon-button" aria-label="Закрыть">
              <X size={20} />
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function Confirm({
  open,
  title,
  children,
  onClose,
  onConfirm,
  busy,
  label = 'Подтвердить',
  danger = false,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
  onConfirm: () => void;
  busy?: boolean;
  label?: string;
  danger?: boolean;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description="Проверьте действие перед подтверждением."
    >
      <div className="confirm-text">{children}</div>
      <div className="form-actions">
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          Назад
        </Button>
        <Button variant={danger ? 'danger' : 'primary'} busy={busy} onClick={onConfirm}>
          {label}
        </Button>
      </div>
    </Modal>
  );
}
export function Field({
  label,
  hint,
  children,
  className = '',
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  const controlId = useId();
  const hintId = `${controlId}-hint`;
  return (
    <div className={`field ${className}`}>
      <label htmlFor={controlId}>{label}</label>
      {Children.map(children, (child) => {
        if (
          isValidElement<{ id?: string; 'aria-describedby'?: string }>(child) &&
          typeof child.type === 'string' &&
          ['input', 'select', 'textarea'].includes(child.type)
        ) {
          return cloneElement(child, {
            id: controlId,
            'aria-describedby': hint ? hintId : child.props['aria-describedby'],
          });
        }
        return child;
      })}
      {hint && <small id={hintId}>{hint}</small>}
    </div>
  );
}
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="heading-actions">{actions}</div>}
    </div>
  );
}
export function Empty({
  icon: Icon = Inbox,
  title,
  text,
  action,
  compact = false,
}: {
  icon?: LucideIcon;
  title: string;
  text: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={`empty ${compact ? 'compact' : ''}`}>
      <div className="empty-icon">
        <Icon size={25} strokeWidth={1.5} />
      </div>
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}
export function Loading() {
  return (
    <div className="skeletons" aria-label="Загрузка" role="status">
      <div className="skeleton title" />
      <div className="skeleton" />
      <div className="skeleton" />
      <div className="skeleton short" />
    </div>
  );
}
export function ErrorState({ text, retry }: { text: string; retry: () => void }) {
  return (
    <Empty
      icon={CircleAlert}
      title="Не удалось загрузить данные"
      text={text}
      action={
        <Button variant="secondary" onClick={retry}>
          Попробовать ещё раз
        </Button>
      }
    />
  );
}
export function Status({ status }: { status: LessonStatus }) {
  const labels = { PLANNED: 'Запланировано', COMPLETED: 'Проведено', CANCELLED: 'Отменено' };
  return (
    <span className={`badge status-${status.toLowerCase()}`}>
      <span className="status-dot" />
      {labels[status]}
    </span>
  );
}
export function Avatar({
  name,
  size = '',
  seed = '',
}: {
  name: string;
  size?: 'large' | 'small' | '';
  seed?: string;
}) {
  const color = (name + seed).split('').reduce((a, c) => a + c.charCodeAt(0), 0) % 5;
  return (
    <span className={`avatar avatar-${color} ${size}`} aria-hidden="true">
      {initials(name)}
    </span>
  );
}
export function LessonList({
  lessons,
  showDate = false,
  calendarLabels,
}: {
  lessons: Lesson[];
  showDate?: boolean;
  calendarLabels?: ReadonlyMap<string, string>;
}) {
  const { me } = useWorkspace();
  return (
    <div className="lesson-list">
      {lessons.map((lesson) => (
        <Link
          to={`/lessons/${lesson.id}`}
          key={lesson.id}
          className={`lesson-row ${lesson.status === 'CANCELLED' ? 'cancelled' : ''}`}
        >
          <div className="lesson-time">
            <strong>{dateTime(lesson.startsAt, me.settings.timezone, 'HH:mm')}</strong>
            <span>
              {showDate
                ? dateTime(lesson.startsAt, me.settings.timezone, 'd MMM')
                : `${lesson.duration} мин`}
            </span>
          </div>
          <Avatar name={lesson.studentName} size="small" />
          <div className="lesson-description">
            <strong>{lesson.studentName}</strong>
            <span>
              {lesson.topic || lesson.subject}
              {lesson.topic && <span className="dot-separator">·</span>}
              {lesson.topic && lesson.subject}
            </span>
          </div>
          <div className="lesson-state">
            <Status status={lesson.status} />
            {calendarLabels?.has(lesson.id) && (
              <small className="calendar-google-status">
                Google · {calendarLabels.get(lesson.id)}
              </small>
            )}
            <span className="muted">
              {lesson.paidAmount ? (
                <span className="text-green">
                  <Check size={12} /> Оплачено
                </span>
              ) : (
                formatMoney(lesson.price)
              )}
            </span>
          </div>
          <ChevronRight size={17} className="row-arrow" />
        </Link>
      ))}
    </div>
  );
}
export function SectionTitle({ title, extra }: { title: string; extra?: ReactNode }) {
  return (
    <div className="section-title">
      <h2>{title}</h2>
      {extra}
    </div>
  );
}
export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link className="back-link" to={to}>
      <ArrowLeft size={15} />
      {children}
    </Link>
  );
}
export function AddLessonButton({
  onClick,
  label = 'Запланировать урок',
}: {
  onClick: () => void;
  label?: string;
}) {
  return (
    <Button onClick={onClick}>
      <Plus size={17} />
      {label}
    </Button>
  );
}
export function Metric({
  label,
  value,
  helper,
  tone = '',
}: {
  label: string;
  value: ReactNode;
  helper?: string;
  tone?: string;
}) {
  return (
    <div className={`metric ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {helper && <small>{helper}</small>}
    </div>
  );
}
export function ScheduleEmpty({ onAdd }: { onAdd?: () => void }) {
  return (
    <Empty
      icon={CalendarDays}
      compact
      title="Время для новых планов"
      text="Здесь появятся занятия. Запланируйте урок — мы сохраним всё важное."
      action={
        onAdd && (
          <Button variant="secondary" onClick={onAdd}>
            <Plus size={16} />
            Добавить занятие
          </Button>
        )
      }
    />
  );
}
export function TextLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link className="text-link" to={to}>
      {children}
      <ArrowUpRight size={15} />
    </Link>
  );
}
