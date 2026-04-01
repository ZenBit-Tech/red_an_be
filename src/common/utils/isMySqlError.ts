import { QueryFailedError } from 'typeorm';

export default function isMySqlError(error: unknown): error is QueryFailedError & { code: string } {
  return (
    error instanceof QueryFailedError && typeof (error as { code?: unknown }).code === 'string'
  );
}
