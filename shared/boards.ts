import { z } from 'zod';

export const boardStates = ['CREATING', 'ACTIVE', 'DELETED'] as const;
export const boardRoles = ['editor', 'viewer'] as const;
export type BoardState = (typeof boardStates)[number];
export type BoardRole = (typeof boardRoles)[number];
const title = z.string().trim().min(1, 'Укажите название доски').max(200);
export const boardCreateInput = z.object({ title, requestId: z.string().uuid() }).strict();
export const boardRenameInput = z.object({ title }).strict();
export const boardInviteInput = z
  .object({
    role: z.enum(boardRoles),
    ttlMinutes: z.number().int().min(1).max(10_080),
    maxUses: z.number().int().min(1).max(1000).default(1),
  })
  .strict();
export const boardLinkInput = z
  .object({
    lessonId: z.string().uuid().optional(),
    studentId: z.string().uuid().optional(),
    // This is only a reserved reference; snapshot existence is not established here.
    snapshotId: z.string().trim().min(1).max(200).nullable().optional(),
  })
  .strict()
  .refine((value) => value.lessonId !== undefined || value.studentId !== undefined, {
    message: 'Выберите ученика или занятие',
  })
  .refine((value) => value.snapshotId === undefined || value.lessonId !== undefined, {
    message: 'Версия доски может относиться только к занятию',
  });
export type BoardCreateInput = z.infer<typeof boardCreateInput>;
export type BoardRenameInput = z.infer<typeof boardRenameInput>;
export type BoardInviteInput = z.input<typeof boardInviteInput>;
export type BoardLinkInput = z.infer<typeof boardLinkInput>;

export interface Board {
  id: string;
  ownerId: string;
  title: string;
  state: BoardState;
  requestId: string;
  createdAt: string;
  updatedAt: string;
}
export interface BoardLinks {
  lessons: { lessonId: string; snapshotId: string | null; createdAt: string }[];
  students: { studentId: string; createdAt: string }[];
}
export interface LessonBoard {
  id: string;
  title: string;
  snapshotId: string | null;
}
export interface BoardInvitation {
  id: string;
  boardId: string;
  role: BoardRole;
  expiresAt: string;
  maxUses: number;
  uses: number;
  revokedAt: string | null;
  createdAt: string;
}
export interface BoardGuestSession {
  id: string;
  boardId: string;
  role: BoardRole;
  expiresAt: string;
}
export interface BoardRedemption {
  token: string;
  session: BoardGuestSession;
  board: Pick<Board, 'id' | 'title'>;
}
