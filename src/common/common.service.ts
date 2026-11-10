import { Global, Injectable, Module, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService, Tx } from '../prisma/prisma.service';
import { AuthUser } from './auth';
import { NotifyService } from './notify.service';

export const D = (v: Prisma.Decimal.Value | null | undefined) => new Prisma.Decimal(v ?? 0);
export const ZERO = new Prisma.Decimal(0);
export const round2 = (v: Prisma.Decimal) => v.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
export const sumD = (vals: Prisma.Decimal.Value[]) => vals.reduce<Prisma.Decimal>((a, b) => a.plus(D(b)), ZERO);

export function notFound<T>(v: T | null | undefined, what = 'Data'): T {
  if (!v) throw new NotFoundException({ code: 'NOT_FOUND', message: `${what} tidak ditemukan` });
  return v;
}

/** Nomor dokumen readable, sequence per tenant per tahun (PRD §6). Contoh: PR-2026-0001 */
@Injectable()
export class SequenceService {
  async next(tx: Tx, tenantId: string, prefix: string, date = new Date()): Promise<string> {
    const year = date.getFullYear();
    const c = await tx.sequenceCounter.upsert({
      where: { tenantId_prefix_year: { tenantId, prefix, year } },
      create: { tenantId, prefix, year, current: 1 },
      update: { current: { increment: 1 } },
    });
    return `${prefix}-${year}-${String(c.current).padStart(4, '0')}`;
  }
}

/** Audit log append-only (PRD §5.14) */
@Injectable()
export class AuditService {
  constructor(private prisma: PrismaService) {}

  async log(
    user: Pick<AuthUser, 'tenantId' | 'userId' | 'name'>,
    action: string,
    entityType: string,
    entityId: string,
    metadata?: Record<string, unknown>,
    tx?: Tx,
  ) {
    const db = tx ?? this.prisma;
    await db.auditLog.create({
      data: {
        tenantId: user.tenantId,
        actorId: user.userId,
        actorName: user.name,
        action,
        entityType,
        entityId,
        metadata: metadata ? JSON.parse(JSON.stringify(metadata)) : undefined,
      },
    });
  }
}

@Global()
@Module({ providers: [SequenceService, AuditService, NotifyService], exports: [SequenceService, AuditService, NotifyService] })
export class CommonModule {}
