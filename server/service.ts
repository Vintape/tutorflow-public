import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import type { z } from 'zod';
import {
  monthBounds,
  type Student,
  type Lesson,
  type LessonReport,
  type Payment,
  type Settings,
  type Finance,
  type Overview,
  type LessonDetail,
  type ReportContent,
  type ReportStyle,
  type studentInput,
  type lessonInput,
  type lessonPatch,
  type reportInput,
} from '../shared/domain.js';
import type { Database, SQL } from './db.js';
import { AppError, assertFound } from './errors.js';
import { enqueueGoogleCalendarLesson } from './google-calendar/sync.js';

const lessonSelect = `SELECT l.*, s.name AS "studentName", s.subject, s.level, s."archivedAt",
  r.status AS "reportStatus", COALESCE(p.amount, 0)::integer AS "paidAmount"
  FROM lessons l JOIN students s ON s.id = l."studentId" AND s."ownerId" = l."ownerId"
  LEFT JOIN reports r ON r."lessonId" = l.id AND r."ownerId" = l."ownerId"
  LEFT JOIN payments p ON p."lessonId" = l.id AND p."ownerId" = l."ownerId" AND p."voidedAt" IS NULL`;

export class TutorService {
  constructor(public db: Database) {}

  async settings(owner: string): Promise<Settings> {
    await this.db.query('INSERT INTO settings ("ownerId") VALUES ($1) ON CONFLICT DO NOTHING', [
      owner,
    ]);
    return assertFound(
      (await this.db.query<Settings>('SELECT * FROM settings WHERE "ownerId"=$1', [owner]))[0],
    );
  }
  async listStudents(owner: string, archived = false): Promise<Student[]> {
    return this.db.query<Student>(
      `SELECT s.*,
      (SELECT count(*)::integer FROM lessons l WHERE l."ownerId"=$1 AND l."studentId"=s.id AND l.status='COMPLETED') AS "completedCount",
      (SELECT COALESCE(sum(l.price - COALESCE(p.amount,0)),0)::double precision FROM lessons l
        LEFT JOIN payments p ON p."lessonId"=l.id AND p."ownerId"=$1 AND p."voidedAt" IS NULL
        WHERE l."ownerId"=$1 AND l."studentId"=s.id AND l.status='COMPLETED') AS debt
      FROM students s WHERE s."ownerId"=$1 AND (s."archivedAt" IS NOT NULL)=$2 ORDER BY s.name, s.id`,
      [owner, archived],
    );
  }
  async student(owner: string, id: string, tx: SQL = this.db): Promise<Student> {
    return assertFound(
      (
        await tx.query<Student>('SELECT * FROM students WHERE "ownerId"=$1 AND id=$2', [owner, id])
      )[0],
    );
  }
  async createStudent(owner: string, data: z.infer<typeof studentInput>): Promise<Student> {
    return assertFound(
      (
        await this.db.query<Student>(
          `INSERT INTO students (id,"ownerId",name,subject,level,price,duration,goal,notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [
            randomUUID(),
            owner,
            data.name,
            data.subject,
            data.level,
            data.price,
            data.duration,
            data.goal,
            data.notes,
          ],
        )
      )[0],
    );
  }
  async updateStudent(
    owner: string,
    id: string,
    data: z.infer<typeof studentInput>,
  ): Promise<Student> {
    return assertFound(
      (
        await this.db.query<Student>(
          `UPDATE students SET name=$3, subject=$4, level=$5, price=$6, duration=$7, goal=$8, notes=$9, "updatedAt"=now()
      WHERE "ownerId"=$1 AND id=$2 RETURNING *`,
          [
            owner,
            id,
            data.name,
            data.subject,
            data.level,
            data.price,
            data.duration,
            data.goal,
            data.notes,
          ],
        )
      )[0],
    );
  }
  async archiveStudent(owner: string, id: string, archive: boolean): Promise<Student> {
    return assertFound(
      (
        await this.db.query<Student>(
          `UPDATE students SET "archivedAt"=${archive ? 'now()' : 'NULL'}, "updatedAt"=now()
      WHERE "ownerId"=$1 AND id=$2 RETURNING *`,
          [owner, id],
        )
      )[0],
    );
  }
  async lesson(owner: string, id: string, tx: SQL = this.db): Promise<Lesson> {
    return assertFound(
      (await tx.query<Lesson>(`${lessonSelect} WHERE l."ownerId"=$1 AND l.id=$2`, [owner, id]))[0],
    );
  }
  async lessonDetail(owner: string, id: string): Promise<LessonDetail> {
    const lesson = await this.lesson(owner, id);
    const [report] = await this.db.query<LessonReport>(
      'SELECT * FROM reports WHERE "ownerId"=$1 AND "lessonId"=$2',
      [owner, id],
    );
    const payments = await this.db.query<Payment>(
      'SELECT * FROM payments WHERE "ownerId"=$1 AND "lessonId"=$2 ORDER BY "createdAt" DESC',
      [owner, id],
    );
    return { lesson, report: report || null, payments };
  }
  async listLessons(
    owner: string,
    options: { from?: string; to?: string; studentId?: string; offset?: number },
  ): Promise<{ lessons: Lesson[]; hasMore: boolean }> {
    const params: unknown[] = [owner];
    const conditions = ['l."ownerId"=$1'];
    if (options.studentId) {
      await this.student(owner, options.studentId);
      params.push(options.studentId);
      conditions.push(`l."studentId"=$${params.length}`);
    }
    if (options.from) {
      params.push(options.from);
      conditions.push(`l."startsAt">=$${params.length}`);
    }
    if (options.to) {
      params.push(options.to);
      conditions.push(`l."startsAt"<$${params.length}`);
    }
    params.push(options.offset || 0);
    const lessons = await this.db.query<Lesson>(
      `${lessonSelect} WHERE ${conditions.join(' AND ')} ORDER BY l."startsAt" ${options.studentId ? 'DESC' : 'ASC'}, l.id LIMIT 101 OFFSET $${params.length}`,
      params,
    );
    return { lessons: lessons.slice(0, 100), hasMore: lessons.length > 100 };
  }
  private async conflict(tx: SQL, owner: string, startsAt: string, duration: number, id?: string) {
    return tx.query<{ id: string; startsAt: string }>(
      `SELECT id, "startsAt" FROM lessons WHERE "ownerId"=$1 AND status!='CANCELLED'
      AND "startsAt" < $2::timestamptz + $3 * interval '1 minute'
      AND "startsAt" + duration * interval '1 minute' > $2::timestamptz AND ($4::text IS NULL OR id!=$4) LIMIT 3`,
      [owner, startsAt, duration, id || null],
    );
  }
  async createLesson(owner: string, data: z.infer<typeof lessonInput>): Promise<Lesson> {
    const id = randomUUID();
    await this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [owner]);
      const student = await this.student(owner, data.studentId, tx);
      if (student.archivedAt)
        throw new AppError(409, 'Сначала верните ученика из архива', 'ARCHIVED');
      const duration = data.duration ?? student.duration;
      const conflicts = await this.conflict(tx, owner, data.startsAt, duration);
      if (conflicts.length && !data.allowConflict)
        throw new AppError(
          409,
          'В это время уже есть занятие. Измените время или подтвердите наложение.',
          'CONFLICT',
          conflicts,
        );
      await tx.query(
        `INSERT INTO lessons (id,"ownerId","studentId","startsAt",duration,price,topic) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, owner, student.id, data.startsAt, duration, data.price ?? student.price, data.topic],
      );
      await enqueueGoogleCalendarLesson(tx, owner, id);
    });
    return this.lesson(owner, id);
  }
  async updateLesson(
    owner: string,
    id: string,
    data: z.infer<typeof lessonPatch>,
  ): Promise<Lesson> {
    await this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [owner]);
      await tx.query('SELECT id FROM lessons WHERE "ownerId"=$1 AND id=$2 FOR UPDATE', [owner, id]);
      const old = await this.lesson(owner, id, tx);
      if (old.version !== data.version)
        throw new AppError(
          409,
          'Занятие изменено в другой вкладке. Обновите страницу перед сохранением.',
          'STALE',
        );
      const status = data.status ?? old.status;
      const price = data.price ?? old.price;
      const startsAt = data.startsAt ?? old.startsAt;
      const duration = data.duration ?? old.duration;
      if (old.paidAmount && (status !== 'COMPLETED' || price !== old.price))
        throw new AppError(
          409,
          'Сначала отмените отметку оплаты. История поступления сохранится.',
          'PAYMENT_EXISTS',
        );
      const changedSchedule =
        startsAt !== old.startsAt ||
        duration !== old.duration ||
        (old.status === 'CANCELLED' && status !== 'CANCELLED');
      if (
        status !== 'CANCELLED' &&
        changedSchedule &&
        !data.allowConflict &&
        (await this.conflict(tx, owner, startsAt, duration, id)).length
      ) {
        throw new AppError(
          409,
          'В это время уже есть занятие. Подтвердите наложение или измените время.',
          'CONFLICT',
        );
      }
      if (status === 'COMPLETED' && Date.parse(startsAt) > Date.now())
        throw new AppError(
          422,
          'Будущее занятие пока нельзя отметить проведённым',
          'FUTURE_LESSON',
        );
      await tx.query(
        `UPDATE lessons SET "startsAt"=$3, duration=$4, price=$5, topic=$6, status=$7, note=$8, homework=$9, version=version+1, "updatedAt"=now()
        WHERE "ownerId"=$1 AND id=$2`,
        [
          owner,
          id,
          startsAt,
          duration,
          price,
          data.topic ?? old.topic,
          status,
          data.note ?? old.note,
          data.homework ?? old.homework,
        ],
      );
      const noteChanged =
        (data.note !== undefined && data.note !== old.note) ||
        (data.homework !== undefined && data.homework !== old.homework) ||
        (data.topic !== undefined && data.topic !== old.topic);
      if (startsAt !== old.startsAt || duration !== old.duration || status !== old.status)
        await enqueueGoogleCalendarLesson(tx, owner, id);
      if (noteChanged || status !== 'COMPLETED')
        await tx.query(
          `UPDATE reports SET status='DRAFT', "approvedAt"=NULL, version=version+1, "updatedAt"=now() WHERE "ownerId"=$1 AND "lessonId"=$2`,
          [owner, id],
        );
    });
    return this.lesson(owner, id);
  }
  async saveReport(
    owner: string,
    lessonId: string,
    data: z.infer<typeof reportInput>,
    generated?: {
      style: ReportStyle;
      expectedLessonVersion: number;
      expectedReportVersion: number;
    },
  ): Promise<LessonReport> {
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM lessons WHERE "ownerId"=$1 AND id=$2 FOR UPDATE', [
        owner,
        lessonId,
      ]);
      const lesson = await this.lesson(owner, lessonId, tx);
      if (lesson.status !== 'COMPLETED')
        throw new AppError(409, 'Отчёт можно сохранить после проведения занятия', 'NOT_COMPLETED');
      const [old] = await tx.query<LessonReport>(
        'SELECT * FROM reports WHERE "ownerId"=$1 AND "lessonId"=$2',
        [owner, lessonId],
      );
      if ((old?.version ?? 0) !== data.version)
        throw new AppError(
          409,
          'Отчёт изменён. Обновите страницу, чтобы не потерять другую версию.',
          'STALE',
        );
      if (
        generated &&
        (lesson.version !== generated.expectedLessonVersion ||
          (old?.version ?? 0) !== generated.expectedReportVersion)
      )
        throw new AppError(
          409,
          'Во время генерации заметка или отчёт изменились. Повторите генерацию.',
          'STALE',
        );
      if (!Object.values(data.content).some((v) => v.trim()))
        throw new AppError(422, 'Заполните хотя бы одно поле отчёта');
      const approved = data.approve;
      const now = new Date().toISOString();
      const params = [
        owner,
        lessonId,
        JSON.stringify(data.content),
        approved ? 'APPROVED' : 'DRAFT',
        approved ? now : null,
        lesson.note,
        generated ? 'AI' : (old?.source ?? 'MANUAL'),
        generated?.style ?? old?.style ?? 'standard',
        generated ? now : (old?.generatedAt ?? null),
      ];
      let report: LessonReport;
      if (old) {
        report = assertFound(
          (
            await tx.query<LessonReport>(
              `UPDATE reports SET content=$3::jsonb, status=$4, "approvedAt"=$5, "originalNote"=$6, source=$7, style=$8,
          "generatedAt"=$9, version=version+1, "updatedAt"=now() WHERE "ownerId"=$1 AND "lessonId"=$2 RETURNING *`,
              params,
            )
          )[0],
        );
      } else {
        report = assertFound(
          (
            await tx.query<LessonReport>(
              `INSERT INTO reports ("ownerId","lessonId",content,status,"approvedAt","originalNote",source,style,"generatedAt",id)
          VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
              [...params, randomUUID()],
            )
          )[0],
        );
        await this.event(tx, owner, 'report_created');
      }
      if (approved && old?.status !== 'APPROVED') await this.event(tx, owner, 'report_approved');
      return report;
    });
  }
  private async event(tx: SQL, owner: string, kind: string) {
    await tx.query('INSERT INTO pilot_events (id,"ownerId",kind) VALUES ($1,$2,$3)', [
      randomUUID(),
      owner,
      kind,
    ]);
  }
  async copyReport(owner: string, id: string): Promise<ReportContent> {
    const lesson = await this.lesson(owner, id);
    const [report] = await this.db.query<LessonReport>(
      'SELECT * FROM reports WHERE "ownerId"=$1 AND "lessonId"=$2',
      [owner, id],
    );
    if (lesson.status !== 'COMPLETED' || !report || report.status !== 'APPROVED')
      throw new AppError(409, 'Сначала проверьте и подтвердите отчёт', 'NOT_APPROVED');
    await this.event(this.db, owner, 'report_copied');
    return report.content;
  }
  async pay(owner: string, id: string, paidAt: string): Promise<Payment> {
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM lessons WHERE "ownerId"=$1 AND id=$2 FOR UPDATE', [owner, id]);
      const lesson = await this.lesson(owner, id, tx);
      if (lesson.status !== 'COMPLETED')
        throw new AppError(
          409,
          'Оплату можно отметить только у проведённого занятия',
          'NOT_COMPLETED',
        );
      if (!lesson.price)
        throw new AppError(409, 'У бесплатного занятия нет задолженности', 'FREE_LESSON');
      const [existing] = await tx.query<Payment>(
        'SELECT * FROM payments WHERE "ownerId"=$1 AND "lessonId"=$2 AND "voidedAt" IS NULL',
        [owner, id],
      );
      if (existing) return existing;
      if (Date.parse(paidAt) > Date.now() + 60000)
        throw new AppError(422, 'Дата оплаты не может быть в будущем');
      return assertFound(
        (
          await tx.query<Payment>(
            'INSERT INTO payments (id,"ownerId","lessonId",amount,"paidAt") VALUES ($1,$2,$3,$4,$5) RETURNING *',
            [randomUUID(), owner, id, lesson.price, paidAt],
          )
        )[0],
      );
    });
  }
  async reversePayment(owner: string, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [payment] = await tx.query<Payment>(
        'SELECT * FROM payments WHERE "ownerId"=$1 AND id=$2',
        [owner, id],
      );
      assertFound(payment);
      await tx.query('SELECT id FROM lessons WHERE "ownerId"=$1 AND id=$2 FOR UPDATE', [
        owner,
        payment.lessonId,
      ]);
      await tx.query(
        'UPDATE payments SET "voidedAt"=now() WHERE "ownerId"=$1 AND id=$2 AND "voidedAt" IS NULL',
        [owner, id],
      );
    });
  }
  async finance(owner: string, month: string): Promise<Finance> {
    const settings = await this.settings(owner);
    const { from, to } = monthBounds(month, settings.timezone);
    const [totals] = await this.db.query<{
      accrued: number;
      planned: number;
      completedCount: number;
    }>(
      `SELECT
      COALESCE(sum(price) FILTER (WHERE status='COMPLETED'),0)::double precision AS accrued,
      COALESCE(sum(price) FILTER (WHERE status='PLANNED' AND "startsAt">=now()),0)::double precision AS planned,
      count(*) FILTER (WHERE status='COMPLETED')::integer AS "completedCount"
      FROM lessons WHERE "ownerId"=$1 AND "startsAt">=$2 AND "startsAt"<$3`,
      [owner, from, to],
    );
    const [received] = await this.db.query<{ total: number }>(
      'SELECT COALESCE(sum(amount),0)::double precision AS total FROM payments WHERE "ownerId"=$1 AND "voidedAt" IS NULL AND "paidAt">=$2 AND "paidAt"<$3',
      [owner, from, to],
    );
    const [debt] = await this.db.query<{ total: number }>(
      `SELECT COALESCE(sum(l.price-COALESCE(p.amount,0)),0)::double precision AS total FROM lessons l
      LEFT JOIN payments p ON p."lessonId"=l.id AND p."ownerId"=$1 AND p."voidedAt" IS NULL WHERE l."ownerId"=$1 AND l.status='COMPLETED'`,
      [owner],
    );
    const unpaid = await this.db.query<Lesson>(
      `${lessonSelect} WHERE l."ownerId"=$1 AND l.status='COMPLETED' AND l.price>COALESCE(p.amount,0) ORDER BY l."startsAt" ASC LIMIT 200`,
      [owner],
    );
    const payments = await this.db.query<Payment>(
      `SELECT p.*, s.name AS "studentName", l."startsAt" FROM payments p
      JOIN lessons l ON l.id=p."lessonId" AND l."ownerId"=$1 JOIN students s ON s.id=l."studentId" AND s."ownerId"=$1
      WHERE p."ownerId"=$1 AND p."paidAt">=$2 AND p."paidAt"<$3 ORDER BY p."paidAt" DESC, p.id LIMIT 200`,
      [owner, from, to],
    );
    return { month, ...totals, received: received.total, debt: debt.total, unpaid, payments };
  }
  async overview(owner: string): Promise<Overview> {
    const settings = await this.settings(owner);
    const now = DateTime.now().setZone(settings.timezone);
    const today = (
      await this.listLessons(owner, {
        from: now.startOf('day').toUTC().toISO()!,
        to: now.plus({ days: 1 }).startOf('day').toUTC().toISO()!,
      })
    ).lessons;
    const [next] = await this.db.query<Lesson>(
      `${lessonSelect} WHERE l."ownerId"=$1 AND l.status='PLANNED' AND l."startsAt">=now() ORDER BY l."startsAt" ASC LIMIT 1`,
      [owner],
    );
    const attention = await this.db.query<Lesson>(
      `${lessonSelect} WHERE l."ownerId"=$1 AND l.status='COMPLETED' AND (r.status IS NULL OR r.status!='APPROVED') ORDER BY l."startsAt" DESC LIMIT 20`,
      [owner],
    );
    const [count] = await this.db.query<{ total: number }>(
      'SELECT count(*)::integer AS total FROM students WHERE "ownerId"=$1 AND "archivedAt" IS NULL',
      [owner],
    );
    const {
      unpaid: _unpaid,
      payments: _payments,
      ...finance
    } = await this.finance(owner, now.toFormat('yyyy-MM'));
    void _unpaid;
    void _payments;
    return { today, next: next ?? null, attention, finance, activeStudents: count.total };
  }
}
