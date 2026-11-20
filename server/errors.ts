export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = 'VALIDATION',
    public details?: unknown,
  ) {
    super(message);
  }
}
export function assertFound<T>(value: T | undefined): T {
  if (!value) throw new AppError(404, 'Запись не найдена', 'NOT_FOUND');
  return value;
}
