export interface AppErrorOptions {
  retryable?: boolean;
  detail?: unknown;
  nodePath?: string;
}

export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly detail?: unknown;
  readonly nodePath?: string;

  constructor(
    code: string,
    status: number,
    message: string,
    options: AppErrorOptions = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.retryable = options.retryable ?? false;
    this.detail = options.detail;
    this.nodePath = options.nodePath;
  }
}

export function cancelledError(): AppError {
  return new AppError('CANCELLED', 499, '已取消生成。');
}

export function errorEnvelope(error: AppError) {
  return {
    error: {
      code: error.code,
      message: error.message,
      detail: error.detail ?? null,
      retryable: error.retryable,
      ...(error.nodePath !== undefined ? { nodePath: error.nodePath } : {}),
    },
  };
}
