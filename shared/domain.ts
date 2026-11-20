import { DateTime } from 'luxon';
import { z } from 'zod';

export const lessonStatuses = ['PLANNED', 'COMPLETED', 'CANCELLED'] as const;
export type LessonStatus = (typeof lessonStatuses)[number];
const text = (max: number) => z.string().trim().max(max);
export const moneySchema = z.number().int().min(0).max(100_000_000);
export const durationSchema = z.number().int().min(15).max(480);
export const studentInput = z
  .object({
    name: text(100).min(1, 'Укажите имя или псевдоним'),
    subject: text(80).min(1, 'Укажите предмет'),
    level: text(80).default(''),
    price: moneySchema,
    duration: durationSchema,
    goal: text(2000).default(''),
    notes: text(5000).default(''),
  })
  .strict();
export const lessonInput = z
  .object({
    studentId: z.string().uuid(),
    startsAt: z.iso.datetime({ offset: true }),
    duration: durationSchema.optional(),
    price: moneySchema.optional(),
    topic: text(200).default(''),
    allowConflict: z.boolean().default(false),
  })
  .strict();
// Patch fields deliberately have no creation defaults: omitted topic must stay unchanged.
export const lessonPatch = z
  .object({
    startsAt: z.iso.datetime({ offset: true }).optional(),
    duration: durationSchema.optional(),
    price: moneySchema.optional(),
    topic: text(200).optional(),
    allowConflict: z.boolean().optional(),
    status: z.enum(lessonStatuses).optional(),
    note: text(8000).optional(),
    homework: text(2000).optional(),
    version: z.number().int().positive(),
  })
  .strict();
export const reportContent = z
  .object({
    topic: text(1000),
    coveredMaterial: text(2500),
    strengths: text(2500),
    difficulties: text(2500),
    homework: text(2000),
    nextSteps: text(2500),
    summary: text(2500),
  })
  .strict();
export type ReportContent = z.infer<typeof reportContent>;
export const emptyReport: ReportContent = {
  topic: '',
  coveredMaterial: '',
  strengths: '',
  difficulties: '',
  homework: '',
  nextSteps: '',
  summary: '',
};
export const reportLabels: Record<keyof ReportContent, string> = {
  topic: 'Тема занятия',
  coveredMaterial: 'Что изучили',
  strengths: 'Что получилось',
  difficulties: 'Над чем поработаем',
  homework: 'Домашнее задание',
  nextSteps: 'План следующего занятия',
  summary: 'Комментарий',
};
export const reportInput = z
  .object({
    content: reportContent,
    approve: z.boolean().default(false),
    version: z.number().int().nonnegative(),
  })
  .strict();
export const reportStyle = z.enum(['short', 'standard', 'detailed']);
export type ReportStyle = z.infer<typeof reportStyle>;
export const settingsInput = z
  .object({
    name: text(100).min(1),
    timezone: z
      .string()
      .refine((v) => DateTime.now().setZone(v).isValid, 'Неизвестный часовой пояс'),
    theme: z.enum(['light', 'dark', 'system']),
  })
  .strict();

export interface Student {
  id: string;
  ownerId: string;
  name: string;
  subject: string;
  level: string;
  price: number;
  duration: number;
  goal: string;
  notes: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  completedCount?: number;
  debt?: number;
}
export interface Lesson {
  id: string;
  ownerId: string;
  studentId: string;
  startsAt: string;
  duration: number;
  price: number;
  topic: string;
  status: LessonStatus;
  note: string;
  homework: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  studentName: string;
  subject: string;
  level: string;
  archivedAt: string | null;
  reportStatus: 'DRAFT' | 'APPROVED' | null;
  paidAmount: number;
}
export interface LessonReport {
  id: string;
  ownerId: string;
  lessonId: string;
  content: ReportContent;
  originalNote: string;
  source: 'MANUAL' | 'AI';
  style: ReportStyle;
  status: 'DRAFT' | 'APPROVED';
  version: number;
  generatedAt: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface Payment {
  id: string;
  ownerId: string;
  lessonId: string;
  amount: number;
  paidAt: string;
  voidedAt: string | null;
  createdAt: string;
  studentName?: string;
  startsAt?: string;
}
export interface Settings {
  ownerId: string;
  timezone: string;
  theme: 'light' | 'dark' | 'system';
}
export interface Me {
  user: { id: string; name: string; email: string };
  settings: Settings;
  ai: { available: boolean; dailyLimit: number; usedToday: number };
  studentCount: number;
  boards?: { enabled: boolean };
}
export interface Finance {
  month: string;
  accrued: number;
  received: number;
  debt: number;
  planned: number;
  completedCount: number;
  unpaid: Lesson[];
  payments: Payment[];
}
export interface Overview {
  today: Lesson[];
  next: Lesson | null;
  attention: Lesson[];
  finance: Omit<Finance, 'unpaid' | 'payments'>;
  activeStudents: number;
}
export interface LessonDetail {
  lesson: Lesson;
  report: LessonReport | null;
  payments: Payment[];
}

export function formatMoney(kopecks: number): string {
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: kopecks % 100 === 0 ? 0 : 2,
  }).format(kopecks / 100);
}
export function parseMoney(value: string): number {
  const normalized = value.trim().replace(',', '.');
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(normalized))
    throw new Error('Укажите сумму в рублях, не более двух знаков после запятой');
  const [rubles, fraction = ''] = normalized.split('.');
  return moneySchema.parse(Number(rubles) * 100 + Number(fraction.padEnd(2, '0')));
}
export function monthBounds(month: string, timezone: string): { from: string; to: string } {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('Некорректный месяц');
  const date = DateTime.fromISO(`${month}-01`, { zone: timezone });
  if (!date.isValid) throw new Error('Некорректный месяц');
  return {
    from: date.startOf('month').toUTC().toISO()!,
    to: date.plus({ months: 1 }).startOf('month').toUTC().toISO()!,
  };
}
export function localToUTC(value: string, timezone: string): string {
  const date = DateTime.fromISO(value, { zone: timezone });
  // Reject nonexistent DST wall times instead of silently shifting an appointment.
  if (!date.isValid || date.toFormat("yyyy-MM-dd'T'HH:mm") !== value.slice(0, 16))
    throw new Error('Такого времени нет в выбранном часовом поясе');
  if (date.getPossibleOffsets().length > 1)
    throw new Error('Это время неоднозначно из-за перевода часов. Выберите другое время');
  return date.toUTC().toISO()!;
}
export function reportText(content: ReportContent): string {
  return (Object.keys(reportLabels) as (keyof ReportContent)[])
    .filter((key) => content[key].trim())
    .map((key) => `${reportLabels[key]}: ${content[key].trim()}`)
    .join('\n\n');
}
export function overlaps(
  a: { startsAt: string; duration: number },
  b: { startsAt: string; duration: number },
): boolean {
  const aStart = Date.parse(a.startsAt),
    bStart = Date.parse(b.startsAt);
  return aStart < bStart + b.duration * 60000 && bStart < aStart + a.duration * 60000;
}
