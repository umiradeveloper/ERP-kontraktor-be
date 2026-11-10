import {
  ArgumentsHost,
  CallHandler,
  Catch,
  ExceptionFilter,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NestInterceptor,
  NestMiddleware,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { map, Observable } from 'rxjs';

/** Request-ID untuk korelasi log & error (PRD §14). */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: any, res: any, next: () => void) {
    const id = (req.headers['x-request-id'] as string) || randomUUID();
    req.requestId = id;
    res.setHeader('x-request-id', id);
    next();
  }
}

/** Envelope sukses: { data, meta? } */
@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  intercept(_: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      map((result) => {
        if (result && typeof result === 'object' && '__envelope' in result) {
          const { __envelope, ...rest } = result as any;
          return rest;
        }
        return { data: result ?? null };
      }),
    );
  }
}

export const paged = <T>(data: T[], total: number) => ({ __envelope: true, data, meta: { total } });

/** Error bisnis → 422 */
export class BusinessError extends UnprocessableEntityException {
  constructor(message: string, code = 'BUSINESS_RULE') {
    super({ code, message });
  }
}

/** Envelope error: { error: { code, message, details?, requestId } } */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private logger = new Logger('HTTP');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest();
    const res = ctx.getResponse();
    const requestId = req.requestId;

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = 'Terjadi kesalahan pada server';
    let details: unknown;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body: any = exception.getResponse();
      code = body?.code ?? HttpStatus[status] ?? 'ERROR';
      if (Array.isArray(body?.message)) {
        code = 'VALIDATION_ERROR';
        message = 'Data tidak valid';
        details = body.message;
      } else {
        message = body?.message ?? exception.message;
      }
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        status = HttpStatus.CONFLICT;
        code = 'DUPLICATE';
        message = 'Data dengan kode/nomor yang sama sudah ada';
      } else if (exception.code === 'P2025') {
        status = HttpStatus.NOT_FOUND;
        code = 'NOT_FOUND';
        message = 'Data tidak ditemukan';
      }
    }

    if (status >= 500) this.logger.error(`[${requestId}] ${(exception as Error)?.stack ?? exception}`);

    res.status(status).json({ error: { code, message, details, requestId } });
  }
}
