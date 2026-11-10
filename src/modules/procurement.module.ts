import { Body, Controller, Get, Injectable, Module, OnModuleInit, Param, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsDateString, IsIn, IsNumberString, IsOptional, IsString, ValidateNested } from 'class-validator';
import { CostCategory, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser, CurrentUser, Perm } from '../common/auth';
import { AuditService, D, notFound, round2, SequenceService, sumD, ZERO } from '../common/common.service';
import { BusinessError } from '../common/http';
import { ApprovalsModule, ApprovalsService } from './approvals.module';
import { AccountingModule, ACC, COST_ACCOUNT, PostingLine, PostingService } from './accounting.module';
import { CostService, ProjectsModule } from './projects.module';
import { InventoryModule, InventoryService } from './inventory.module';
import { AlertService, NotificationsModule } from './notifications.module';

const CATS = ['MATERIAL', 'LABOR', 'EQUIPMENT', 'SUBCONTRACTOR', 'OVERHEAD', 'OTHER'];
/** Toleransi 3-way match (PRD §5.9) */
const MATCH_TOLERANCE_PCT = 0.5;
const idr = (d: Prisma.Decimal) => 'Rp ' + new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 }).format(d.toNumber());

class PrItemDto {
  @IsString() description!: string;
  @IsNumberString() quantity!: string;
  @IsOptional() @IsString() unit?: string;
  @IsNumberString() estimatedPrice!: string;
  @IsIn(CATS) category!: CostCategory;
  @IsOptional() @IsString() costCode?: string;
}
class PrDto {
  @IsString() projectId!: string;
  @IsOptional() @IsDateString() neededAt?: string;
  @IsOptional() @IsString() notes?: string;
  @ValidateNested({ each: true }) @Type(() => PrItemDto) @ArrayMinSize(1) items!: PrItemDto[];
}
class PoItemDto {
  @IsString() description!: string;
  @IsNumberString() quantity!: string;
  @IsOptional() @IsString() unit?: string;
  @IsNumberString() unitPrice!: string;
  @IsIn(CATS) category!: CostCategory;
  @IsOptional() @IsString() costCode?: string;
}
class PoDto {
  @IsString() projectId!: string;
  @IsString() supplierId!: string;
  @IsOptional() @IsString() requestId?: string;
  @IsOptional() @IsNumberString() taxPct?: string;
  @IsOptional() @IsDateString() deliveryDate?: string;
  @IsOptional() @IsString() deliveryAddress?: string;
  @IsOptional() @IsString() terms?: string;
  @ValidateNested({ each: true }) @Type(() => PoItemDto) @ArrayMinSize(1) items!: PoItemDto[];
}
class GrnLineDto {
  @IsString() poItemId!: string;
  @IsNumberString() quantity!: string;
  @IsOptional() @IsNumberString() rejectedQty?: string;
  @IsOptional() @IsString() notes?: string;
}
class GrnDto {
  @IsString() poId!: string;
  /** Jika diisi, barang masuk ke stok gudang ini */
  @IsOptional() @IsString() warehouseId?: string;
  @IsDateString() receiptDate!: string;
  @IsOptional() @IsString() notes?: string;
  @ValidateNested({ each: true }) @Type(() => GrnLineDto) @ArrayMinSize(1) lines!: GrnLineDto[];
}
class SupplierInvoiceDto {
  @IsString() poId!: string;
  @IsString() supplierRef!: string;
  @IsDateString() invoiceDate!: string;
  @IsOptional() @IsDateString() dueDate?: string;
  @IsNumberString() subtotal!: string;
  @IsOptional() @IsNumberString() taxAmount?: string;
}
class PaymentDto {
  @IsDateString() paymentDate!: string;
  @IsNumberString() amount!: string;
  @IsOptional() @IsString() method?: string;
}

@Injectable()
export class ProcurementService implements OnModuleInit {
  constructor(
    private prisma: PrismaService,
    private seq: SequenceService,
    private audit: AuditService,
    private approvals: ApprovalsService,
    private posting: PostingService,
    private cost: CostService,
    private inventory: InventoryService,
    private alerts: AlertService,
  ) {}

  onModuleInit() {
    this.approvals.registerHandler('PR', async (tx, tenantId, id, status) => {
      await tx.purchaseRequest.update({ where: { id }, data: { status } });
    }, (_tx, id) => `/procurement/pr/${id}`);
    this.approvals.registerHandler('PO', async (tx, tenantId, id, status) => {
      const map = { APPROVED: 'APPROVED', REJECTED: 'CANCELLED', REVISION: 'DRAFT' } as const;
      const po = await tx.purchaseOrder.update({ where: { id }, data: { status: map[status] } });
      // PO disetujui menambah commitment → cek budget setelah commit
      if (status === 'APPROVED') return () => this.alerts.checkBudget(tenantId, po.projectId);
    }, (_tx, id) => `/procurement/po/${id}`);
  }

  // ───────── Purchase Request ─────────

  async listPr(u: AuthUser, q: { projectId?: string; status?: string }) {
    const rows = await this.prisma.purchaseRequest.findMany({
      where: { tenantId: u.tenantId, ...(q.projectId ? { projectId: q.projectId } : {}), ...(q.status ? { status: q.status as any } : {}) },
      include: { project: { select: { code: true, name: true } }, _count: { select: { items: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const users = await this.userNames(u.tenantId);
    return rows.map((r) => ({ ...r, requestedByName: users.get(r.requestedBy) }));
  }

  async getPr(u: AuthUser, id: string) {
    const pr = notFound(
      await this.prisma.purchaseRequest.findFirst({
        where: { id, tenantId: u.tenantId },
        include: { project: true, items: true, purchaseOrders: { select: { id: true, number: true, status: true, total: true } } },
      }),
      'PR',
    );
    // Validasi budget: bandingkan estimasi PR dengan sisa budget per kategori
    const buckets = await this.cost.buckets(u.tenantId, [pr.projectId]);
    const summary = this.cost.summarize(buckets.get(pr.projectId));
    const need: Record<string, Prisma.Decimal> = {};
    for (const i of pr.items) need[i.category] = (need[i.category] ?? ZERO).plus(i.quantity.mul(i.estimatedPrice));
    const budgetCheck = Object.entries(need).map(([category, amount]) => {
      const r = summary.rows.find((x) => x.category === category)!;
      const available = r.budget.minus(r.actual).minus(r.commitment);
      return { category, requested: amount, budget: r.budget, available, overBudget: amount.gt(available) };
    });
    const users = await this.userNames(u.tenantId);
    return { ...pr, requestedByName: users.get(pr.requestedBy), budgetCheck };
  }

  private async assertProject(tx: Prisma.TransactionClient, u: AuthUser, projectId: string) {
    const p = notFound(await tx.project.findFirst({ where: { id: projectId, tenantId: u.tenantId } }), 'Proyek');
    if (['CLOSED', 'CANCELLED'].includes(p.status)) throw new BusinessError('Proyek sudah ditutup');
    return p;
  }

  async createPr(u: AuthUser, dto: PrDto) {
    return this.prisma.$transaction(async (tx) => {
      await this.assertProject(tx, u, dto.projectId);
      const total = sumD(dto.items.map((i) => D(i.quantity).mul(D(i.estimatedPrice))));
      const pr = await tx.purchaseRequest.create({
        data: {
          tenantId: u.tenantId, projectId: dto.projectId, number: await this.seq.next(tx, u.tenantId, 'PR'),
          requestedBy: u.userId, neededAt: dto.neededAt ? new Date(dto.neededAt) : null, notes: dto.notes,
          totalEstimate: round2(total),
          items: { create: dto.items.map((i) => ({ tenantId: u.tenantId, description: i.description, quantity: D(i.quantity), unit: i.unit, estimatedPrice: D(i.estimatedPrice), category: i.category, costCode: i.costCode })) },
        },
      });
      await this.audit.log(u, 'CREATE', 'PurchaseRequest', pr.id, { number: pr.number }, tx);
      return pr;
    });
  }

  async updatePr(u: AuthUser, id: string, dto: PrDto) {
    return this.prisma.$transaction(async (tx) => {
      const pr = notFound(await tx.purchaseRequest.findFirst({ where: { id, tenantId: u.tenantId } }), 'PR');
      if (!['DRAFT', 'REVISION'].includes(pr.status)) throw new BusinessError('PR hanya bisa diubah saat Draft/Revisi');
      await this.assertProject(tx, u, dto.projectId);
      await tx.purchaseRequestItem.deleteMany({ where: { requestId: id, tenantId: u.tenantId } });
      const total = sumD(dto.items.map((i) => D(i.quantity).mul(D(i.estimatedPrice))));
      const res = await tx.purchaseRequest.update({
        where: { id },
        data: {
          projectId: dto.projectId, neededAt: dto.neededAt ? new Date(dto.neededAt) : null, notes: dto.notes, totalEstimate: round2(total),
          items: { create: dto.items.map((i) => ({ tenantId: u.tenantId, description: i.description, quantity: D(i.quantity), unit: i.unit, estimatedPrice: D(i.estimatedPrice), category: i.category, costCode: i.costCode })) },
        },
      });
      await this.audit.log(u, 'UPDATE', 'PurchaseRequest', id, { items: dto.items.length }, tx);
      return res;
    });
  }

  async submitPr(u: AuthUser, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const pr = notFound(await tx.purchaseRequest.findFirst({ where: { id, tenantId: u.tenantId }, include: { project: true } }), 'PR');
      if (!['DRAFT', 'REVISION'].includes(pr.status)) throw new BusinessError('PR sudah diajukan');
      await tx.purchaseRequest.update({ where: { id }, data: { status: 'IN_APPROVAL' } });
      const st = await this.approvals.submit(tx, u, {
        entityType: 'PR', entityId: id, entityNumber: pr.number,
        title: `PR ${pr.number} — ${pr.project.name}`, amount: pr.totalEstimate.toString(),
      });
      await this.audit.log(u, 'SUBMIT', 'PurchaseRequest', id, { result: st }, tx);
      return { status: st };
    });
  }

  // ───────── Purchase Order ─────────

  async listPo(u: AuthUser, q: { projectId?: string; status?: string }) {
    return this.prisma.purchaseOrder.findMany({
      where: { tenantId: u.tenantId, ...(q.projectId ? { projectId: q.projectId } : {}), ...(q.status ? { status: q.status as any } : {}) },
      include: { project: { select: { code: true, name: true } }, supplier: { select: { name: true } }, request: { select: { number: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getPo(u: AuthUser, id: string) {
    return notFound(
      await this.prisma.purchaseOrder.findFirst({
        where: { id, tenantId: u.tenantId },
        include: {
          project: true, supplier: true, request: { select: { id: true, number: true } }, items: true,
          goodsReceipts: { include: { lines: true }, orderBy: { receiptDate: 'desc' } },
          invoices: { orderBy: { invoiceDate: 'desc' } },
        },
      }),
      'PO',
    );
  }

  async createPo(u: AuthUser, dto: PoDto) {
    return this.prisma.$transaction(async (tx) => {
      await this.assertProject(tx, u, dto.projectId);
      notFound(await tx.supplier.findFirst({ where: { id: dto.supplierId, tenantId: u.tenantId, deletedAt: null } }), 'Supplier');
      if (dto.requestId) {
        const pr = notFound(await tx.purchaseRequest.findFirst({ where: { id: dto.requestId, tenantId: u.tenantId } }), 'PR');
        if (pr.status !== 'APPROVED') throw new BusinessError('PO hanya dapat dibuat dari PR yang sudah disetujui');
        if (pr.projectId !== dto.projectId) throw new BusinessError('Proyek PO harus sama dengan proyek PR');
      }
      const taxPct = D(dto.taxPct ?? '11');
      const items = dto.items.map((i) => ({ ...i, amount: round2(D(i.quantity).mul(D(i.unitPrice))) }));
      const subtotal = sumD(items.map((i) => i.amount));
      const taxAmount = round2(subtotal.mul(taxPct).div(100));
      const po = await tx.purchaseOrder.create({
        data: {
          tenantId: u.tenantId, projectId: dto.projectId, supplierId: dto.supplierId, requestId: dto.requestId || null,
          number: await this.seq.next(tx, u.tenantId, 'PO'), taxPct, subtotal, taxAmount, total: subtotal.plus(taxAmount),
          deliveryDate: dto.deliveryDate ? new Date(dto.deliveryDate) : null, deliveryAddress: dto.deliveryAddress, terms: dto.terms,
          createdBy: u.userId,
          items: { create: items.map((i) => ({ tenantId: u.tenantId, description: i.description, quantity: D(i.quantity), unit: i.unit, unitPrice: D(i.unitPrice), amount: i.amount, category: i.category, costCode: i.costCode })) },
        },
      });
      if (dto.requestId) await tx.purchaseRequest.update({ where: { id: dto.requestId }, data: { status: 'CONVERTED' } });
      await this.audit.log(u, 'CREATE', 'PurchaseOrder', po.id, { number: po.number, total: po.total }, tx);
      return po;
    });
  }

  async submitPo(u: AuthUser, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const po = notFound(await tx.purchaseOrder.findFirst({ where: { id, tenantId: u.tenantId }, include: { supplier: true } }), 'PO');
      if (po.status !== 'DRAFT') throw new BusinessError('PO sudah diajukan');
      await tx.purchaseOrder.update({ where: { id }, data: { status: 'IN_APPROVAL' } });
      const st = await this.approvals.submit(tx, u, {
        entityType: 'PO', entityId: id, entityNumber: po.number, title: `PO ${po.number} — ${po.supplier.name}`, amount: po.total.toString(),
      });
      await this.audit.log(u, 'SUBMIT', 'PurchaseOrder', id, { result: st }, tx);
      return { status: st };
    });
  }

  async issuePo(u: AuthUser, id: string) {
    const po = notFound(await this.prisma.purchaseOrder.findFirst({ where: { id, tenantId: u.tenantId } }), 'PO');
    if (po.status !== 'APPROVED') throw new BusinessError('Hanya PO yang sudah disetujui yang dapat diterbitkan');
    const res = await this.prisma.purchaseOrder.update({ where: { id }, data: { status: 'ISSUED' } });
    await this.audit.log(u, 'ISSUE', 'PurchaseOrder', id);
    return res;
  }

  // ───────── Goods Receipt ─────────

  async createGrn(u: AuthUser, dto: GrnDto) {
    return this.prisma.$transaction(async (tx) => {
      const po = notFound(await tx.purchaseOrder.findFirst({ where: { id: dto.poId, tenantId: u.tenantId }, include: { items: true } }), 'PO');
      if (!['ISSUED', 'PARTIAL_RECEIPT'].includes(po.status)) throw new BusinessError('Penerimaan hanya untuk PO yang sudah diterbitkan');
      const items = new Map(po.items.map((i) => [i.id, i]));
      const lines = dto.lines.filter((l) => D(l.quantity).gt(0));
      if (lines.length === 0) throw new BusinessError('Isi minimal satu kuantitas diterima');
      for (const l of lines) {
        const it = items.get(l.poItemId);
        if (!it) throw new BusinessError('Item PO tidak valid');
        const remaining = it.quantity.minus(it.receivedQty);
        if (D(l.quantity).gt(remaining)) throw new BusinessError(`Qty diterima "${it.description}" melebihi sisa PO (${remaining})`);
      }
      const grn = await tx.goodsReceipt.create({
        data: {
          tenantId: u.tenantId, poId: po.id, number: await this.seq.next(tx, u.tenantId, 'GRN'), receiptDate: new Date(dto.receiptDate),
          receivedBy: u.userId, notes: dto.notes, warehouseId: dto.warehouseId || null,
          lines: { create: lines.map((l) => ({ tenantId: u.tenantId, poItemId: l.poItemId, quantity: D(l.quantity), rejectedQty: D(l.rejectedQty ?? 0), notes: l.notes })) },
        },
      });
      for (const l of lines) await tx.purchaseOrderItem.update({ where: { id: l.poItemId }, data: { receivedQty: { increment: D(l.quantity) } } });
      if (dto.warehouseId) {
        await this.inventory.receive(tx, u, {
          warehouseId: dto.warehouseId, projectId: po.projectId, refType: 'GoodsReceipt', refId: grn.id, date: new Date(dto.receiptDate),
          lines: lines.map((l) => {
            const it = items.get(l.poItemId)!;
            return { name: it.description, unit: it.unit, category: it.category, quantity: D(l.quantity), unitCost: it.unitPrice };
          }),
        });
      }
      const after = await tx.purchaseOrderItem.findMany({ where: { poId: po.id } });
      const complete = after.every((i) => i.receivedQty.gte(i.quantity));
      await tx.purchaseOrder.update({ where: { id: po.id }, data: { status: complete ? 'RECEIVED' : 'PARTIAL_RECEIPT' } });
      await this.audit.log(u, 'CREATE', 'GoodsReceipt', grn.id, { number: grn.number, po: po.number }, tx);
      return grn;
    });
  }

  // ───────── Supplier Invoice (AP) ─────────

  private expectedFromPo(items: { receivedQty: Prisma.Decimal; invoicedQty: Prisma.Decimal; unitPrice: Prisma.Decimal; category: CostCategory }[]) {
    const byCat: Record<string, Prisma.Decimal> = {};
    let total = ZERO;
    for (const i of items) {
      const q = i.receivedQty.minus(i.invoicedQty);
      if (q.lte(0)) continue;
      const amt = round2(q.mul(i.unitPrice));
      byCat[i.category] = (byCat[i.category] ?? ZERO).plus(amt);
      total = total.plus(amt);
    }
    return { total, byCat };
  }

  private match(claimed: Prisma.Decimal, expected: Prisma.Decimal) {
    if (expected.eq(0)) return { ok: false, note: 'Belum ada barang diterima yang belum ditagih' };
    const diff = claimed.minus(expected).abs();
    const pct = diff.div(expected).mul(100);
    const ok = pct.lte(MATCH_TOLERANCE_PCT);
    return {
      ok,
      note: ok
        ? `Cocok: tagihan ${idr(claimed)} vs PO×GRN ${idr(expected)} (selisih ${pct.toFixed(2)}%)`
        : `Tidak cocok: tagihan ${idr(claimed)} vs PO×GRN ${idr(expected)} (selisih ${pct.toFixed(2)}%, toleransi ${MATCH_TOLERANCE_PCT}%)`,
    };
  }

  async listSupplierInvoices(u: AuthUser, q: { status?: string }) {
    const rows = await this.prisma.supplierInvoice.findMany({
      where: { tenantId: u.tenantId, ...(q.status ? { status: q.status as any } : {}) },
      include: { supplier: { select: { name: true } }, project: { select: { code: true, name: true } }, po: { select: { number: true } } },
      orderBy: { invoiceDate: 'desc' },
    });
    return rows;
  }

  async createSupplierInvoice(u: AuthUser, dto: SupplierInvoiceDto) {
    return this.prisma.$transaction(async (tx) => {
      const po = notFound(await tx.purchaseOrder.findFirst({ where: { id: dto.poId, tenantId: u.tenantId }, include: { items: true, supplier: true } }), 'PO');
      if (!['ISSUED', 'PARTIAL_RECEIPT', 'RECEIVED'].includes(po.status)) throw new BusinessError('PO belum diterbitkan');
      const dup = await tx.supplierInvoice.findFirst({ where: { tenantId: u.tenantId, supplierId: po.supplierId, supplierRef: dto.supplierRef } });
      if (dup) throw new BusinessError(`Invoice supplier ${dto.supplierRef} sudah pernah dicatat (${dup.number})`, 'DUPLICATE_INVOICE');

      const subtotal = D(dto.subtotal);
      const taxAmount = dto.taxAmount ? D(dto.taxAmount) : round2(subtotal.mul(po.taxPct).div(100));
      const { total: expected } = this.expectedFromPo(po.items);
      const m = this.match(subtotal, expected);
      const invDate = new Date(dto.invoiceDate);
      const due = dto.dueDate ? new Date(dto.dueDate) : new Date(invDate.getTime() + po.supplier.paymentTerm * 86400_000);

      const inv = await tx.supplierInvoice.create({
        data: {
          tenantId: u.tenantId, supplierId: po.supplierId, projectId: po.projectId, poId: po.id,
          number: await this.seq.next(tx, u.tenantId, 'SINV', invDate), supplierRef: dto.supplierRef,
          invoiceDate: invDate, dueDate: due, subtotal, taxAmount, total: subtotal.plus(taxAmount),
          status: m.ok ? 'MATCHED' : 'MISMATCH', matchNotes: m.note,
        },
      });
      await this.audit.log(u, 'CREATE', 'SupplierInvoice', inv.id, { number: inv.number, match: m.note }, tx);
      return inv;
    });
  }

  /** Posting invoice → actual cost proyek + jurnal AP (idempotent) */
  async postSupplierInvoice(u: AuthUser, id: string) {
    const out = await this.prisma.$transaction(async (tx) => {
      const inv = notFound(await tx.supplierInvoice.findFirst({ where: { id, tenantId: u.tenantId }, include: { supplier: true } }), 'Invoice');
      if (inv.status === 'POSTED') return inv;
      if (inv.status !== 'MATCHED') throw new BusinessError('Invoice harus lolos 3-way match sebelum diposting');
      const po = notFound(await tx.purchaseOrder.findFirst({ where: { id: inv.poId!, tenantId: u.tenantId }, include: { items: true } }), 'PO');
      const { total: expected, byCat } = this.expectedFromPo(po.items);
      const m = this.match(inv.subtotal, expected);
      if (!m.ok) {
        await tx.supplierInvoice.update({ where: { id }, data: { status: 'MISMATCH', matchNotes: m.note } });
        throw new BusinessError(m.note, 'MATCH_FAILED');
      }

      // Alokasikan subtotal tagihan proporsional per kategori biaya
      const cats = Object.entries(byCat);
      let allocated = ZERO;
      const alloc = cats.map(([cat, amt], idx) => {
        const v = idx === cats.length - 1 ? inv.subtotal.minus(allocated) : round2(inv.subtotal.mul(amt).div(expected));
        allocated = allocated.plus(v);
        return { cat: cat as CostCategory, amount: v };
      });

      const lines: PostingLine[] = [
        ...alloc.map((a) => ({ accountCode: COST_ACCOUNT[a.cat], debit: a.amount, projectId: inv.projectId, description: `${inv.supplier.name} ${inv.supplierRef}` })),
        { accountCode: ACC.VAT_IN, debit: inv.taxAmount, description: 'PPN Masukan' },
        { accountCode: ACC.AP, credit: inv.total, projectId: inv.projectId, description: `Hutang ${inv.supplier.name}` },
      ];
      const j = await this.posting.post(tx, u, {
        postingRef: `SINV:${inv.id}`, date: inv.invoiceDate, description: `Invoice supplier ${inv.number} (${inv.supplierRef})`,
        sourceType: 'SupplierInvoice', sourceId: inv.id, lines,
      });

      for (const a of alloc) {
        await tx.projectCost.create({
          data: {
            tenantId: u.tenantId, projectId: inv.projectId, sourceType: `SINV_${a.cat}`, sourceId: inv.id, costDate: inv.invoiceDate,
            category: a.cat, description: `${inv.supplier.name} — ${inv.number}`, amount: a.amount, isPosted: true,
          },
        });
      }
      for (const it of po.items) {
        if (it.receivedQty.gt(it.invoicedQty)) await tx.purchaseOrderItem.update({ where: { id: it.id }, data: { invoicedQty: it.receivedQty } });
      }
      const res = await tx.supplierInvoice.update({ where: { id }, data: { status: 'POSTED', journalId: j.id, matchNotes: m.note } });
      await this.audit.log(u, 'POST', 'SupplierInvoice', id, { journal: j.number }, tx);
      return res;
    });
    await this.alerts.checkBudget(u.tenantId, out.projectId).catch(() => undefined);
    return out;
  }

  async paySupplierInvoice(u: AuthUser, id: string, dto: PaymentDto) {
    return this.prisma.$transaction(async (tx) => {
      const inv = notFound(await tx.supplierInvoice.findFirst({ where: { id, tenantId: u.tenantId }, include: { supplier: true } }), 'Invoice');
      if (!['POSTED', 'PARTIAL_PAID'].includes(inv.status)) throw new BusinessError('Pembayaran hanya untuk invoice yang sudah diposting');
      const amount = D(dto.amount);
      const outstanding = inv.total.minus(inv.paidAmount);
      if (amount.lte(0) || amount.gt(outstanding)) throw new BusinessError(`Nominal harus 0 < x ≤ sisa tagihan (${outstanding.toFixed(2)})`);
      const date = new Date(dto.paymentDate);
      const pay = await tx.supplierPayment.create({
        data: { tenantId: u.tenantId, invoiceId: id, number: await this.seq.next(tx, u.tenantId, 'PAY', date), paymentDate: date, amount, method: dto.method ?? 'TRANSFER' },
      });
      const j = await this.posting.post(tx, u, {
        postingRef: `PAY:${pay.id}`, date, description: `Pembayaran ${inv.number} ke ${inv.supplier.name}`, sourceType: 'SupplierPayment', sourceId: pay.id,
        lines: [
          { accountCode: ACC.AP, debit: amount, projectId: inv.projectId },
          { accountCode: ACC.CASH, credit: amount, projectId: inv.projectId },
        ],
      });
      await tx.supplierPayment.update({ where: { id: pay.id }, data: { journalId: j.id } });
      const paid = inv.paidAmount.plus(amount);
      const res = await tx.supplierInvoice.update({ where: { id }, data: { paidAmount: paid, status: paid.gte(inv.total) ? 'PAID' : 'PARTIAL_PAID' } });
      await this.audit.log(u, 'PAY', 'SupplierInvoice', id, { amount: dto.amount, payment: pay.number }, tx);
      return res;
    });
  }

  async apAging(u: AuthUser) {
    const rows = await this.prisma.supplierInvoice.findMany({
      where: { tenantId: u.tenantId, status: { in: ['POSTED', 'PARTIAL_PAID'] } },
      include: { supplier: { select: { name: true } }, project: { select: { code: true } } },
      orderBy: { dueDate: 'asc' },
    });
    return aging(rows.map((r) => ({ id: r.id, number: r.number, party: r.supplier.name, project: r.project.code, ref: r.supplierRef, dueDate: r.dueDate, total: r.total, balance: r.total.minus(r.paidAmount) })));
  }

  private async userNames(tenantId: string) {
    const users = await this.prisma.user.findMany({ where: { tenantId }, select: { id: true, name: true } });
    return new Map(users.map((x) => [x.id, x.name]));
  }
}

export function aging<T extends { dueDate: Date | null; balance: Prisma.Decimal }>(rows: T[]) {
  const today = new Date();
  const buckets = { current: ZERO, d1_30: ZERO, d31_60: ZERO, d61_90: ZERO, d90p: ZERO };
  const items = rows.map((r) => {
    const days = r.dueDate ? Math.floor((today.getTime() - r.dueDate.getTime()) / 86400_000) : 0;
    const bucket = days <= 0 ? 'current' : days <= 30 ? 'd1_30' : days <= 60 ? 'd31_60' : days <= 90 ? 'd61_90' : 'd90p';
    (buckets as any)[bucket] = (buckets as any)[bucket].plus(r.balance);
    return { ...r, overdueDays: Math.max(days, 0), bucket };
  });
  const total = Object.values(buckets).reduce((a, b) => a.plus(b), ZERO);
  return { items, buckets, total };
}

@ApiTags('Procurement & AP')
@Controller()
export class ProcurementController {
  constructor(private svc: ProcurementService) {}

  @Get('purchase-requests') @Perm('procurement:read', 'project:read')
  listPr(@CurrentUser() u: AuthUser, @Query('projectId') projectId?: string, @Query('status') status?: string) { return this.svc.listPr(u, { projectId, status }); }
  @Get('purchase-requests/:id') @Perm('procurement:read', 'project:read')
  getPr(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.getPr(u, id); }
  @Post('purchase-requests') @Perm('procurement:write', 'project:write')
  createPr(@CurrentUser() u: AuthUser, @Body() dto: PrDto) { return this.svc.createPr(u, dto); }
  @Put('purchase-requests/:id') @Perm('procurement:write', 'project:write')
  updatePr(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: PrDto) { return this.svc.updatePr(u, id, dto); }
  @Post('purchase-requests/:id/submit') @Perm('procurement:write', 'project:write')
  submitPr(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.submitPr(u, id); }

  @Get('purchase-orders') @Perm('procurement:read')
  listPo(@CurrentUser() u: AuthUser, @Query('projectId') projectId?: string, @Query('status') status?: string) { return this.svc.listPo(u, { projectId, status }); }
  @Get('purchase-orders/:id') @Perm('procurement:read')
  getPo(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.getPo(u, id); }
  @Post('purchase-orders') @Perm('procurement:write')
  createPo(@CurrentUser() u: AuthUser, @Body() dto: PoDto) { return this.svc.createPo(u, dto); }
  @Post('purchase-orders/:id/submit') @Perm('procurement:write')
  submitPo(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.submitPo(u, id); }
  @Post('purchase-orders/:id/issue') @Perm('procurement:write')
  issuePo(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.issuePo(u, id); }

  @Post('goods-receipts') @Perm('procurement:write', 'warehouse:write')
  grn(@CurrentUser() u: AuthUser, @Body() dto: GrnDto) { return this.svc.createGrn(u, dto); }

  @Get('supplier-invoices') @Perm('finance:read', 'procurement:read')
  listSi(@CurrentUser() u: AuthUser, @Query('status') status?: string) { return this.svc.listSupplierInvoices(u, { status }); }
  @Post('supplier-invoices') @Perm('finance:write')
  createSi(@CurrentUser() u: AuthUser, @Body() dto: SupplierInvoiceDto) { return this.svc.createSupplierInvoice(u, dto); }
  @Post('supplier-invoices/:id/post') @Perm('finance:write')
  postSi(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.postSupplierInvoice(u, id); }
  @Post('supplier-invoices/:id/pay') @Perm('finance:write')
  paySi(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: PaymentDto) { return this.svc.paySupplierInvoice(u, id, dto); }
  @Get('ap/aging') @Perm('finance:read')
  apAging(@CurrentUser() u: AuthUser) { return this.svc.apAging(u); }
}

@Module({
  imports: [ApprovalsModule, AccountingModule, ProjectsModule, InventoryModule, NotificationsModule],
  controllers: [ProcurementController],
  providers: [ProcurementService],
  exports: [ProcurementService],
})
export class ProcurementModule {}
