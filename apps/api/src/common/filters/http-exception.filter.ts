import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { type ApiErrorBody, ERROR_CATALOG, type ErrorCode } from '@wordfix/shared';
import type { Request, Response } from 'express';
import { AppError } from '../errors/app-error.js';

/** Correspondance des erreurs HTTP du framework vers le catalogue. */
function codeForHttpStatus(status: number): ErrorCode {
  if (status === Number(HttpStatus.NOT_FOUND)) return 'NOT_FOUND';
  if (status === Number(HttpStatus.PAYLOAD_TOO_LARGE)) return 'FILE_TOO_LARGE';
  if (status === Number(HttpStatus.TOO_MANY_REQUESTS)) return 'TOO_MANY_REQUESTS';
  if (status === Number(HttpStatus.FORBIDDEN)) return 'FORBIDDEN_ORIGIN';
  if (
    status === Number(HttpStatus.BAD_REQUEST) ||
    status === Number(HttpStatus.UNPROCESSABLE_ENTITY)
  ) {
    return 'VALIDATION_FAILED';
  }
  return 'INTERNAL_ERROR';
}

/**
 * Format d'erreur unique de l'API : { error: { code, message, requestId } }.
 * Les détails techniques ne sont jamais renvoyés au client ; ils vont dans les logs.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request & { id?: string }>();
    const res = ctx.getResponse<Response>();

    let code: ErrorCode;
    let status: number;

    if (exception instanceof AppError) {
      code = exception.code;
      status = exception.status;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = codeForHttpStatus(status);
    } else {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      code = 'INTERNAL_ERROR';
    }

    if (status >= 500) {
      this.logger.error(
        { err: exception, code, path: req.path },
        exception instanceof Error ? exception.message : 'Erreur inconnue',
      );
    }

    const body: ApiErrorBody = {
      error: {
        code,
        message: ERROR_CATALOG[code].message,
        ...(req.id ? { requestId: String(req.id) } : {}),
      },
    };
    res.status(status).json(body);
  }
}
