import { Body, Controller, Get, Injectable, Module, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsDateString, IsNumberString, IsOptional, IsString } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser, CurrentUser, Perm } from '../common/auth';
import { AuditService, D, notFound, round2, SequenceService, ZERO } from '../common/common.service';
import { BusinessError } from '../common/http';
import { AccountingModule, ACC, PostingService } from './accounting.module';
import { aging } from './procurement.module';

class InvoiceDto {
  @IsString() projectId!: string;
  @IsDateString() invoiceDate!: string;
  @IsOptional() @IsDateString() dueDate?: string;
  /** Progres kumulatif yang ditagihkan (%) */
  @IsNumberString() progressPct!: string;
  @IsOptional() @IsNumberString() taxPct?: string;
  @IsOptional() @IsString() description?: string;
}
class ReceiptDto {
  @IsDateString() receiptDate!: string;
  @IsNumberString() amount!: string;
  @IsOptional() @IsString() method?: string;
}

/**
 * Progress claim & invoice owner (PRD §5.8).
 * Catatan: progress fisik ≠ progress billing; persentase tagihan diinput terpisah.
 * MVP: pendapatan diakui saat invoice diterbitkan (kebijakan dapat dikonfigurasi pada fase berikutnya).
 */
@Injectable()
export class BillingService {
  constructor(private prisma: PrismaService, private seq: SequenceService, private audit: AuditService, private posting: PostingService) {}

  private withOverdue<T extends { status: string; dueDate: Date | null }>(i: T) {
    const overdue = ['ISSUED', 'PARTIAL_PAID'].includes(i.status) && i.dueDate && i.dueDate < new Date();
    return { ...i, displayStatus: overdue ? 'OVERDUE' : i.status };
  }

  async list(u: AuthUser, q: { projectId?: string }) {
    const rows = await this.prisma.customerInvoice.findMany({
      where: { tenantId: u.tenantId, ...(q.projectId ? { projectId: q.projectId } : {}) },
      include: { project: { select: { code: true, name: true, ownerName: true } } },
      orderBy: { invoiceDate: 'desc' },
    });
    return rows.map((r) => this.withOverdue(r));
  }

  async get(u: AuthUser, id: string) {
    const inv = notFound(
      await this.prisma.customerInvoice.findFirst({ where: { id, tenantId: u.tenantId }, include: { project: true, receipts: { orderBy: { receiptDate: 'desc' } } } }),
      'Invoice',
    );
    return this.withOverdue(inv);
  }

  async create(u: AuthUser, dto: InvoiceDto) {
    return this.prisma.$transaction(async (tx) => {
      const p = notFound(await tx.project.findFirst({ where: { id: dto.projectId, tenantId: u.tenantId } }), 'Proyek');
      if (!['ACTIVE', 'COMPLETION'].includes(p.status)) throw new BusinessError('Penagihan hanya untuk proyek aktif');
      const pct = D(dto.progressPct);
      const prev = await tx.customerInvoice.aggregate({
        where: { tenantId: u.tenantId, projectId: p.id, status: { not: 'CANCELLED' } },
        _max: { progressPct: true },
      });
      const prevPct = D(prev._max.progressPct);
      if (pct.lte(prevPct) || pct.gt(100)) throw new BusinessError(`Progres tagihan harus > ${prevPct.toFixed(2)}% dan ≤ 100%`);

      const gross = round2(p.contractValue.mul(pct.minus(prevPct)).div(100));
      const retention = round2(gross.mul(p.retentionPct).div(100));
      const taxPct = D(dto.taxPct ?? '11');
      const tax = round2(gross.mul(taxPct).div(100));
      const subtotal = gross.minus(retention);
      const invDate = new Date(dto.invoiceDate);
      const inv = await tx.customerInvoice.create({
        data: {
          tenantId: u.tenantId, projectId: p.id, number: await this.seq.next(tx, u.tenantId, 'INV', invDate),
          description: dto.description ?? `Termin progres ${pct.toFixed(0)}%`, progressPct: pct, invoiceDate: invDate,
          dueDate: dto.dueDate ? new Date(dto.dueDate) : new Date(invDate.getTime() + 30 * 86400_000),
          grossAmount: gross, retentionAmount: retention, subtotal, taxAmount: tax, total: subtotal.plus(tax),
        },
      });
      await this.audit.log(u, 'CREATE', 'CustomerInvoice', inv.id, { number: inv.number, gross: gross.toString() }, tx);
      return inv;
    });
  }

  async issue(u: AuthUser, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const inv = notFound(await tx.customerInvoice.findFirst({ where: { id, tenantId: u.tenantId }, include: { project: true } }), 'Invoice');
      if (inv.status === 'ISSUED') return inv;
      if (!['DRAFT', 'APPROVED'].includes(inv.status)) throw new BusinessError('Invoice tidak dapat diterbitkan');
      // Dr Piutang (net) + Dr Piutang Retensi ; Cr Pendapatan (gross) + Cr PPN Keluaran
      const j = await this.posting.post(tx, u, {
        postingRef: `INV:${inv.id}`, date: inv.invoiceDate, description: `Invoice ${inv.number} — ${inv.project.name}`,
        sourceType: 'CustomerInvoice', sourceId: inv.id,
        lines: [
          { accountCode: ACC.AR, debit: inv.total, projectId: inv.projectId },
          { accountCode: ACC.AR_RETENTION, debit: inv.retentionAmount, projectId: inv.projectId },
          { accountCode: ACC.REVENUE, credit: inv.grossAmount, projectId: inv.projectId },
          { accountCode: ACC.VAT_OUT, credit: inv.taxAmount },
        ],
      });
      const res = await tx.customerInvoice.update({ where: { id }, data: { status: 'ISSUED', journalId: j.id } });
      await this.audit.log(u, 'ISSUE', 'CustomerInvoice', id, { journal: j.number }, tx);
      return res;
    });
  }

  async cancel(u: AuthUser, id: string) {
    const inv = notFound(await this.prisma.customerInvoice.findFirst({ where: { id, tenantId: u.tenantId } }), 'Invoice');
    if (inv.status !== 'DRAFT') throw new BusinessError('Invoice yang sudah terbit harus dikoreksi dengan credit note');
    const res = await this.prisma.customerInvoice.update({ where: { id }, data: { status: 'CANCELLED' } });
    await this.audit.log(u, 'CANCEL', 'CustomerInvoice', id);
    return res;
  }

  async receive(u: AuthUser, id: string, dto: ReceiptDto) {
    return this.prisma.$transaction(async (tx) => {
      const inv = notFound(await tx.customerInvoice.findFirst({ where: { id, tenantId: u.tenantId }, include: { project: true } }), 'Invoice');
      if (!['ISSUED', 'PARTIAL_PAID'].includes(inv.status)) throw new BusinessError('Penerimaan hanya untuk invoice yang sudah terbit');
      const amount = D(dto.amount);
      const outstanding = inv.total.minus(inv.paidAmount);
      if (amount.lte(0) || amount.gt(outstanding)) throw new BusinessError(`Nominal harus 0 < x ≤ sisa piutang (${outstanding.toFixed(2)})`);
      const date = new Date(dto.receiptDate);
      const rc = await tx.customerReceipt.create({
        data: { tenantId: u.tenantId, invoiceId: id, number: await this.seq.next(tx, u.tenantId, 'RCV', date), receiptDate: date, amount, method: dto.method ?? 'TRANSFER' },
      });
      const j = await this.posting.post(tx, u, {
        postingRef: `RCV:${rc.id}`, date, description: `Penerimaan ${inv.number} — ${inv.project.ownerName ?? inv.project.name}`,
        sourceType: 'CustomerReceipt', sourceId: rc.id,
        lines: [
          { accountCode: ACC.CASH, debit: amount, projectId: inv.projectId },
          { accountCode: ACC.AR, credit: amount, projectId: inv.projectId },
        ],
      });
      await tx.customerReceipt.update({ where: { id: rc.id }, data: { journalId: j.id } });
      const paid = inv.paidAmount.plus(amount);
      const res = await tx.customerInvoice.update({ where: { id }, data: { paidAmount: paid, status: paid.gte(inv.total) ? 'PAID' : 'PARTIAL_PAID' } });
      await this.audit.log(u, 'RECEIVE', 'CustomerInvoice', id, { amount: dto.amount, receipt: rc.number }, tx);
      return res;
    });
  }

  async arAging(u: AuthUser) {
    const rows = await this.prisma.customerInvoice.findMany({
      where: { tenantId: u.tenantId, status: { in: ['ISSUED', 'PARTIAL_PAID'] } },
      include: { project: { select: { code: true, ownerName: true, name: true } } },
      orderBy: { dueDate: 'asc' },
    });
    return aging(rows.map((r) => ({ id: r.id, number: r.number, party: r.project.ownerName ?? r.project.name, project: r.project.code, ref: r.description, dueDate: r.dueDate, total: r.total, balance: r.total.minus(r.paidAmount) })));
  }

  /** Arus kas 6 bulan terakhir dari jurnal akun Kas & Bank */
  async cashflow(u: AuthUser, projectId?: string) {
    const cash = await this.prisma.account.findUnique({ where: { tenantId_code: { tenantId: u.tenantId, code: ACC.CASH } } });
    if (!cash) return [];
    const from = new Date();
    from.setMonth(from.getMonth() - 5, 1);
    from.setHours(0, 0, 0, 0);
    const lines = await this.prisma.journalLine.findMany({
      where: {
        tenantId: u.tenantId, accountId: cash.id, ...(projectId ? { projectId } : {}),
        journal: { status: { in: ['POSTED', 'REVERSED'] }, entryDate: { gte: from } },
      },
      select: { debit: true, credit: true, journal: { select: { entryDate: true } } },
    });
    const months: { month: string; inflow: number; outflow: number; net: number }[] = [];
    for (let i = 0; i < 6; i++) {
      const d = new Date(from.getFullYear(), from.getMonth() + i, 1);
      months.push({ month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, inflow: 0, outflow: 0, net: 0 });
    }
    for (const l of lines) {
      const d = l.journal.entryDate;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const m = months.find((x) => x.month === key);
      if (!m) continue;
      m.inflow += l.debit.toNumber();
      m.outflow += l.credit.toNumber();
    }
    months.forEach((m) => (m.net = m.inflow - m.outflow));
    return months;
  }

  async cashBalance(u: AuthUser) {
    const cash = await this.prisma.account.findUnique({ where: { tenantId_code: { tenantId: u.tenantId, code: ACC.CASH } } });
    if (!cash) return ZERO;
    const s = await this.prisma.journalLine.aggregate({
      where: { tenantId: u.tenantId, accountId: cash.id, journal: { status: { in: ['POSTED', 'REVERSED'] } } },
      _sum: { debit: true, credit: true },
    });
    return D(s._sum.debit).minus(D(s._sum.credit));
  }
}

@ApiTags('Billing & AR')
@Controller()
export class BillingController {
  constructor(private svc: BillingService) {}

  @Get('customer-invoices') @Perm('finance:read')
  list(@CurrentUser() u: AuthUser, @Query('projectId') projectId?: string) { return this.svc.list(u, { projectId }); }
  @Get('customer-invoices/:id') @Perm('finance:read')
  get(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.get(u, id); }
  @Post('customer-invoices') @Perm('finance:write')
  create(@CurrentUser() u: AuthUser, @Body() dto: InvoiceDto) { return this.svc.create(u, dto); }
  @Post('customer-invoices/:id/issue') @Perm('finance:write')
  issue(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.issue(u, id); }
  @Post('customer-invoices/:id/cancel') @Perm('finance:write')
  cancel(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.cancel(u, id); }
  @Post('customer-invoices/:id/receipts') @Perm('finance:write')
  receive(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ReceiptDto) { return this.svc.receive(u, id, dto); }
  @Get('ar/aging') @Perm('finance:read')
  ar(@CurrentUser() u: AuthUser) { return this.svc.arAging(u); }
  @Get('finance/cashflow') @Perm('finance:read')
  cashflow(@CurrentUser() u: AuthUser, @Query('projectId') projectId?: string) { return this.svc.cashflow(u, projectId); }
}

@Module({ imports: [AccountingModule], controllers: [BillingController], providers: [BillingService], exports: [BillingService] })
export class BillingModule {}
