import { Body, Controller, Delete, Get, Injectable, Module, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsDateString, IsIn, IsNumberString, IsOptional, IsString, Matches, ValidateNested } from 'class-validator';
import { CostCategory, Prisma } from '@prisma/client';
import { PrismaService, Tx } from '../prisma/prisma.service';
import { AuthUser, CurrentUser, Perm } from '../common/auth';
import { AuditService, D, notFound, SequenceService, sumD, ZERO } from '../common/common.service';
import { BusinessError } from '../common/http';

/** Kode akun standar yang dipakai posting rules otomatis */
export const ACC = {
  CASH: '1101',
  AR: '1201',
  AR_RETENTION: '1202',
  VAT_IN: '1301',
  AP: '2101',
  VAT_OUT: '2201',
  REVENUE: '4101',
} as const;

export const COST_ACCOUNT: Record<CostCategory, string> = {
  MATERIAL: '5101',
  LABOR: '5102',
  EQUIPMENT: '5103',
  SUBCONTRACTOR: '5104',
  OVERHEAD: '5105',
  TAX: '5199',
  OTHER: '5199',
};

export interface PostingLine {
  accountCode: string;
  debit?: Prisma.Decimal;
  credit?: Prisma.Decimal;
  projectId?: string | null;
  description?: string;
}

const periodOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

class JournalLineDto {
  @IsString() accountId!: string;
  @IsOptional() @IsString() projectId?: string;
  @IsNumberString() debit!: string;
  @IsNumberString() credit!: string;
  @IsOptional() @IsString() description?: string;
}
class JournalDto {
  @IsDateString() entryDate!: string;
  @IsOptional() @IsString() description?: string;
  @ValidateNested({ each: true }) @Type(() => JournalLineDto) @ArrayMinSize(2) lines!: JournalLineDto[];
}
class AccountDto {
  @Matches(/^[0-9]{4,8}$/) code!: string;
  @IsString() name!: string;
  @IsIn(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE']) accountType!: any;
}

/** Validasi jurnal manual: tiap baris satu sisi, tidak nol/negatif, total debit = kredit */
export function validateJournalLines(lines: { debit: string; credit: string }[]) {
  for (const l of lines) {
    const d = D(l.debit), c = D(l.credit);
    if (d.lt(0) || c.lt(0)) throw new BusinessError('Nilai debit/kredit tidak boleh negatif');
    if (d.gt(0) && c.gt(0)) throw new BusinessError('Satu baris hanya boleh debit atau kredit');
    if (d.eq(0) && c.eq(0)) throw new BusinessError('Baris jurnal tidak boleh bernilai nol');
  }
  const dr = sumD(lines.map((l) => l.debit));
  const cr = sumD(lines.map((l) => l.credit));
  if (!dr.eq(cr)) throw new BusinessError(`Jurnal tidak balance: debit ${dr.toFixed(2)} ≠ kredit ${cr.toFixed(2)}`, 'UNBALANCED');
  return dr;
}

/**
 * Posting rules subledger → GL (PRD §5.10).
 * - debit = credit wajib
 * - periode harus OPEN
 * - idempotent via postingRef unik
 */
@Injectable()
export class PostingService {
  constructor(private seq: SequenceService) {}

  async assertPeriodOpen(tx: Tx, tenantId: string, date: Date) {
    const period = periodOf(date);
    const p = await tx.accountingPeriod.findUnique({ where: { tenantId_period: { tenantId, period } } });
    if (p?.status === 'CLOSED') throw new BusinessError(`Periode ${period} sudah ditutup`, 'PERIOD_CLOSED');
    return period;
  }

  async post(
    tx: Tx,
    user: AuthUser,
    p: { postingRef: string; date: Date; description: string; sourceType: string; sourceId: string; lines: PostingLine[] },
  ) {
    const existing = await tx.journalEntry.findUnique({
      where: { tenantId_postingRef: { tenantId: user.tenantId, postingRef: p.postingRef } },
    });
    if (existing) return existing; // idempotent

    const lines = p.lines.filter((l) => D(l.debit).gt(0) || D(l.credit).gt(0));
    const dr = sumD(lines.map((l) => D(l.debit)));
    const cr = sumD(lines.map((l) => D(l.credit)));
    if (!dr.eq(cr)) throw new BusinessError(`Jurnal tidak balance (D ${dr} ≠ K ${cr})`, 'UNBALANCED');

    const codes = [...new Set(lines.map((l) => l.accountCode))];
    const accounts = await tx.account.findMany({ where: { tenantId: user.tenantId, code: { in: codes } } });
    const byCode = new Map(accounts.map((a) => [a.code, a.id]));
    for (const c of codes) if (!byCode.has(c)) throw new BusinessError(`Akun ${c} belum ada di COA`, 'ACCOUNT_MISSING');

    const period = await this.assertPeriodOpen(tx, user.tenantId, p.date);
    return tx.journalEntry.create({
      data: {
        tenantId: user.tenantId,
        number: await this.seq.next(tx, user.tenantId, 'JV', p.date),
        entryDate: p.date,
        period,
        status: 'POSTED',
        description: p.description,
        sourceType: p.sourceType,
        sourceId: p.sourceId,
        postingRef: p.postingRef,
        totalDebit: dr,
        createdBy: user.userId,
        postedAt: new Date(),
        lines: {
          create: lines.map((l) => ({
            tenantId: user.tenantId,
            accountId: byCode.get(l.accountCode)!,
            projectId: l.projectId ?? null,
            debit: D(l.debit),
            credit: D(l.credit),
            description: l.description,
          })),
        },
      },
    });
  }
}

@Injectable()
export class AccountingService {
  constructor(
    private prisma: PrismaService,
    private seq: SequenceService,
    private audit: AuditService,
    private posting: PostingService,
  ) {}

  accounts(u: AuthUser) {
    return this.prisma.account.findMany({ where: { tenantId: u.tenantId }, orderBy: { code: 'asc' } });
  }

  async createAccount(u: AuthUser, dto: AccountDto) {
    const a = await this.prisma.account.create({ data: { tenantId: u.tenantId, ...dto } });
    await this.audit.log(u, 'CREATE', 'Account', a.id, dto as any);
    return a;
  }

  async journals(u: AuthUser, q: { status?: string; period?: string }) {
    return this.prisma.journalEntry.findMany({
      where: {
        tenantId: u.tenantId,
        ...(q.status ? { status: q.status as any } : {}),
        ...(q.period ? { period: q.period } : {}),
      },
      orderBy: [{ entryDate: 'desc' }, { number: 'desc' }],
      take: 300,
    });
  }

  async journal(u: AuthUser, id: string) {
    return notFound(
      await this.prisma.journalEntry.findFirst({
        where: { id, tenantId: u.tenantId },
        include: { lines: { include: { account: true } } },
      }),
      'Jurnal',
    );
  }

  private validateLines(lines: JournalLineDto[]) {
    return validateJournalLines(lines);
  }

  async createJournal(u: AuthUser, dto: JournalDto) {
    const total = this.validateLines(dto.lines);
    const date = new Date(dto.entryDate);
    return this.prisma.$transaction(async (tx) => {
      const accIds = [...new Set(dto.lines.map((l) => l.accountId))];
      const n = await tx.account.count({ where: { tenantId: u.tenantId, id: { in: accIds }, isActive: true } });
      if (n !== accIds.length) throw new BusinessError('Akun tidak valid');
      const projIds = [...new Set(dto.lines.map((l) => l.projectId).filter(Boolean))] as string[];
      if (projIds.length) {
        const pn = await tx.project.count({ where: { tenantId: u.tenantId, id: { in: projIds } } });
        if (pn !== projIds.length) throw new BusinessError('Proyek tidak valid');
      }
      const j = await tx.journalEntry.create({
        data: {
          tenantId: u.tenantId,
          number: await this.seq.next(tx, u.tenantId, 'JV', date),
          entryDate: date,
          period: periodOf(date),
          description: dto.description,
          sourceType: 'MANUAL',
          totalDebit: total,
          createdBy: u.userId,
          lines: {
            create: dto.lines.map((l) => ({
              tenantId: u.tenantId, accountId: l.accountId, projectId: l.projectId || null,
              debit: D(l.debit), credit: D(l.credit), description: l.description,
            })),
          },
        },
      });
      await this.audit.log(u, 'CREATE', 'JournalEntry', j.id, { number: j.number }, tx);
      return j;
    });
  }

  async postJournal(u: AuthUser, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const j = notFound(await tx.journalEntry.findFirst({ where: { id, tenantId: u.tenantId }, include: { lines: true } }), 'Jurnal');
      if (j.status === 'POSTED') return j;
      if (!['DRAFT', 'REVIEW', 'APPROVED'].includes(j.status)) throw new BusinessError('Jurnal tidak dapat diposting');
      if (j.createdBy === u.userId && !u.perms.includes('*')) {
        // separation of duties: pembuat tidak memposting jurnalnya sendiri
        throw new BusinessError('Jurnal harus diposting oleh user lain (separation of duties)', 'SOD');
      }
      await this.posting.assertPeriodOpen(tx, u.tenantId, j.entryDate);
      const res = await tx.journalEntry.update({ where: { id }, data: { status: 'POSTED', postedAt: new Date() } });
      await this.audit.log(u, 'POST', 'JournalEntry', id, { number: j.number }, tx);
      return res;
    });
  }

  async deleteJournal(u: AuthUser, id: string) {
    const j = notFound(await this.prisma.journalEntry.findFirst({ where: { id, tenantId: u.tenantId } }), 'Jurnal');
    if (j.status !== 'DRAFT') throw new BusinessError('Jurnal yang sudah diposting tidak dapat dihapus — gunakan reversal');
    await this.prisma.journalEntry.delete({ where: { id } });
    await this.audit.log(u, 'DELETE', 'JournalEntry', id, { number: j.number });
    return { ok: true };
  }

  /** Koreksi jurnal posted melalui reversal (PRD §5.10) */
  async reverseJournal(u: AuthUser, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const j = notFound(
        await tx.journalEntry.findFirst({ where: { id, tenantId: u.tenantId }, include: { lines: { include: { account: true } } } }),
        'Jurnal',
      );
      if (j.status !== 'POSTED') throw new BusinessError('Hanya jurnal POSTED yang dapat di-reverse');
      const rev = await this.posting.post(tx, u, {
        postingRef: `REV:${j.id}`,
        date: new Date(),
        description: `Reversal ${j.number}${j.description ? ' — ' + j.description : ''}`,
        sourceType: 'REVERSAL',
        sourceId: j.id,
        lines: j.lines.map((l) => ({ accountCode: l.account.code, debit: l.credit, credit: l.debit, projectId: l.projectId })),
      });
      await tx.journalEntry.update({ where: { id: rev.id }, data: { reversalOfId: j.id } });
      await tx.journalEntry.update({ where: { id }, data: { status: 'REVERSED' } });
      await this.audit.log(u, 'REVERSE', 'JournalEntry', id, { reversal: rev.number }, tx);
      return rev;
    });
  }

  async trialBalance(u: AuthUser, period?: string) {
    const lines = await this.prisma.journalLine.groupBy({
      by: ['accountId'],
      where: {
        tenantId: u.tenantId,
        journal: { status: { in: ['POSTED', 'REVERSED'] }, ...(period ? { period: { lte: period } } : {}) },
      },
      _sum: { debit: true, credit: true },
    });
    const accounts = await this.accounts(u);
    const sums = new Map(lines.map((l) => [l.accountId, l._sum]));
    let td = ZERO, tc = ZERO;
    const rows = accounts
      .map((a) => {
        const s = sums.get(a.id);
        const debit = D(s?.debit), credit = D(s?.credit);
        const net = debit.minus(credit);
        const balDebit = net.gt(0) ? net : ZERO;
        const balCredit = net.lt(0) ? net.neg() : ZERO;
        td = td.plus(balDebit); tc = tc.plus(balCredit);
        return { ...a, debit, credit, balanceDebit: balDebit, balanceCredit: balCredit };
      })
      .filter((r) => !r.debit.eq(0) || !r.credit.eq(0));
    return { rows, totalDebit: td, totalCredit: tc, balanced: td.eq(tc) };
  }

  async incomeStatement(u: AuthUser) {
    const tb = await this.trialBalance(u);
    const revenue = tb.rows.filter((r) => r.accountType === 'REVENUE').map((r) => ({ code: r.code, name: r.name, amount: r.credit.minus(r.debit) }));
    const expense = tb.rows.filter((r) => r.accountType === 'EXPENSE').map((r) => ({ code: r.code, name: r.name, amount: r.debit.minus(r.credit) }));
    const totalRevenue = sumD(revenue.map((r) => r.amount));
    const totalExpense = sumD(expense.map((r) => r.amount));
    return { revenue, expense, totalRevenue, totalExpense, netIncome: totalRevenue.minus(totalExpense) };
  }

  async periods(u: AuthUser) {
    return this.prisma.accountingPeriod.findMany({ where: { tenantId: u.tenantId }, orderBy: { period: 'desc' } });
  }

  async closePeriod(u: AuthUser, period: string) {
    const drafts = await this.prisma.journalEntry.count({ where: { tenantId: u.tenantId, period, status: { in: ['DRAFT', 'REVIEW', 'APPROVED'] } } });
    if (drafts > 0) throw new BusinessError(`Masih ada ${drafts} jurnal belum diposting di periode ${period}`);
    const p = await this.prisma.accountingPeriod.upsert({
      where: { tenantId_period: { tenantId: u.tenantId, period } },
      create: { tenantId: u.tenantId, period, status: 'CLOSED', closedAt: new Date() },
      update: { status: 'CLOSED', closedAt: new Date() },
    });
    await this.audit.log(u, 'CLOSE_PERIOD', 'AccountingPeriod', p.id, { period });
    return p;
  }
}

@ApiTags('Accounting')
@Controller()
export class AccountingController {
  constructor(private svc: AccountingService) {}

  @Get('accounts') @Perm('accounting:read', 'finance:read')
  accounts(@CurrentUser() u: AuthUser) { return this.svc.accounts(u); }

  @Post('accounts') @Perm('accounting:write')
  createAccount(@CurrentUser() u: AuthUser, @Body() dto: AccountDto) { return this.svc.createAccount(u, dto); }

  @Get('journals') @Perm('accounting:read')
  journals(@CurrentUser() u: AuthUser, @Query('status') status?: string, @Query('period') period?: string) {
    return this.svc.journals(u, { status, period });
  }

  @Get('journals/:id') @Perm('accounting:read')
  journal(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.journal(u, id); }

  @Post('journals') @Perm('accounting:write')
  create(@CurrentUser() u: AuthUser, @Body() dto: JournalDto) { return this.svc.createJournal(u, dto); }

  @Post('journals/:id/post') @Perm('accounting:write')
  post(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.postJournal(u, id); }

  @Post('journals/:id/reverse') @Perm('accounting:write')
  reverse(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.reverseJournal(u, id); }

  @Delete('journals/:id') @Perm('accounting:write')
  remove(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.deleteJournal(u, id); }

  @Get('reports/trial-balance') @Perm('accounting:read')
  tb(@CurrentUser() u: AuthUser, @Query('period') period?: string) { return this.svc.trialBalance(u, period); }

  @Get('reports/income-statement') @Perm('accounting:read')
  is(@CurrentUser() u: AuthUser) { return this.svc.incomeStatement(u); }

  @Get('accounting-periods') @Perm('accounting:read')
  periods(@CurrentUser() u: AuthUser) { return this.svc.periods(u); }

  @Post('accounting-periods/:period/close') @Perm('accounting:write')
  close(@CurrentUser() u: AuthUser, @Param('period') period: string) { return this.svc.closePeriod(u, period); }
}

@Module({
  controllers: [AccountingController],
  providers: [AccountingService, PostingService],
  exports: [PostingService, AccountingService],
})
export class AccountingModule {}
