export class AppError extends Error {
  details?: unknown;

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, code = 'invalid_request') =>
  new AppError(400, code, message);
export const notFound = (message: string) => new AppError(404, 'not_found', message);
export const conflict = (message: string, code = 'conflict') =>
  new AppError(409, code, message);
