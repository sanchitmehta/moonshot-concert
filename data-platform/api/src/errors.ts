export class ServiceError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const notFound = (code: string, message: string) => new ServiceError(404, code, message);
export const conflict = (code: string, message: string) => new ServiceError(409, code, message);
export const unprocessable = (code: string, message: string) => new ServiceError(422, code, message);
