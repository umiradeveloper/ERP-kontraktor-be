import { Body, Controller, Get, Injectable, Module, Param, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsDateString, IsInt, IsNumberString, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser, CurrentUser, Perm } from '../common/auth';
import { AuditService, D, notFound, round2, SequenceService, sumD } from '../common/common.service';
import { BusinessError } from '../common/http';
import { ProcurementModule, ProcurementService } from './procurement.module';

class RfqFromPrDto {
  @IsString() requestId!: string;
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsDateString() dueDate?: string;
  @IsArray() @ArrayMinSize(1) supplierIds!: string[];
}
class SuppliersDto {
  @IsArray() @ArrayMinSize(1) supplierIds!: string[];
}
class QuoteLineDto {
  @IsString() rfqItemId!: string;
  @IsNumberString() unitPrice!: string;
}
class QuotationDto {
  @IsString() supplierId!: string;
  @IsOptional() @IsString() quoteRef?: string;
  @IsDateString() quoteDate!: string;
  @IsInt() @Min(0) leadTimeDays!: number;
  @IsInt() @Min(0) paymentTerm!: number;
  @IsOptional() @IsDateString() validUntil?: string;
  @IsOptional() @IsString() notes?: string;
  @ValidateNested({ each: true }) @Type(() => QuoteLineDto) @ArrayMinSize(1) lines!: QuoteLineDto[];
}
class AwardDto {
  @IsString() supplierId!: string;
  @IsOptional() @IsString() reason?: string;
  @IsOptional() @IsNumberString() taxPct?: string;
  @IsOptional() @IsDateString() deliveryDate?: string;
}

/**
 * RFQ & evaluasi quotation (PRD §5.5): PR disetujui → RFQ ke beberapa supplier →
 * input penawaran → matriks perbandingan harga/lead time/termin → award → draft PO.
 */
@Injectable()
export class RfqService {
  constructor(
    private prisma: PrismaService,
    private seq: SequenceService,
    private audit: AuditService,
    private procurement: ProcurementService,
  ) {}

  async list(u: AuthUser) {
    const rows = await this.prisma.rfq.findMany({
      where: { tenantId: u.tenantId },
      include: { _count: { select: { suppliers: true, quotations: true, items: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const projects = await this.prisma.project.findMany({ where: { tenantId: u.tenantId }, select: { id: true, code: true, name: true } });
    const pm = new Map(projects.map((p) => [p.id, p]));
    const suppliers = await this.prisma.supplier.findMany({ where: { tenantId: u.tenantId }, select: { id: true, name: true } });
    const sm = new Map(suppliers.map((s) => [s.id, s.name]));
    return rows.map((r) => ({ ...r, project: pm.get(r.projectId), awardedSupplierName: r.awardedSupplierId ? sm.get(r.awardedSupplierId) : null }));
  }

  async get(u: AuthUser, id: string) {
    const r = notFound(
      await this.prisma.rfq.findFirst({
        where: { id, tenantId: u.tenantId },
        include: {
          items: true,
          suppliers: { include: { supplier: true } },
          quotations: { include: { lines: true, supplier: { select: { name: true } } } },
        },
      }),
      'RFQ',
    );
    const project = await this.prisma.project.findFirst({ where: { id: r.projectId, tenantId: u.tenantId }, select: { id: true, code: true, name: true } });
    const pr = r.requestId ? await this.prisma.purchaseRequest.findFirst({ where: { id: r.requestId, tenantId: u.tenantId }, select: { id: true, number: true, totalEstimate: true } }) : null;
    return { ...r, project, request: pr, comparison: this.compare(r) };
  }

  /** Matriks perbandingan: harga per item, total, item termurah, dan rekomendasi */
  private compare(r: Prisma.RfqGetPayload<{ include: { items: true; quotations: { include: { lines: true; supplier: { select: { name: true } } } } } }>) {
    const lowestByItem: Record<string, Prisma.Decimal> = {};
    for (const q of r.quotations) for (const l of q.lines) {
      if (!lowestByItem[l.rfqItemId] || l.unitPrice.lt(lowestByItem[l.rfqItemId])) lowestByItem[l.rfqItemId] = l.unitPrice;
    }
    const quotes = r.quotations.map((q) => {
      const complete = r.items.every((i) => q.lines.some((l) => l.rfqItemId === i.id));
      return {
        supplierId: q.supplierId, supplierName: q.supplier.name, subtotal: q.subtotal, leadTimeDays: q.leadTimeDays,
        paymentTerm: q.paymentTerm, complete, validUntil: q.validUntil,
        prices: Object.fromEntries(q.lines.map((l) => [l.rfqItemId, { unitPrice: l.unitPrice, amount: l.amount, lowest: l.unitPrice.eq(lowestByItem[l.rfqItemId]) }])),
      };
    });
    const complete = quotes.filter((q) => q.complete);
    const lowest = complete.reduce<(typeof quotes)[number] | null>((a, q) => (!a || q.subtotal.lt(a.subtotal) ? q : a), null);
    const fastest = complete.reduce<(typeof quotes)[number] | null>((a, q) => (!a || q.leadTimeDays < a.leadTimeDays ? q : a), null);
    return { quotes, lowestSupplierId: lowest?.supplierId ?? null, fastestSupplierId: fastest?.supplierId ?? null };
  }

  private async assertSuppliers(u: AuthUser, ids: string[]) {
    const n = await this.prisma.supplier.count({ where: { tenantId: u.tenantId, id: { in: ids }, deletedAt: null } });
    if (n !== new Set(ids).size) throw new BusinessError('Supplier tidak valid');
  }

  async createFromPr(u: AuthUser, dto: RfqFromPrDto) {
    await this.assertSuppliers(u, dto.supplierIds);
    return this.prisma.$transaction(async (tx) => {
      const pr = notFound(await tx.purchaseRequest.findFirst({ where: { id: dto.requestId, tenantId: u.tenantId }, include: { items: true, project: true } }), 'PR');
      if (pr.status !== 'APPROVED') throw new BusinessError('RFQ hanya dapat dibuat dari PR yang sudah disetujui');
      const open = await tx.rfq.findFirst({ where: { tenantId: u.tenantId, requestId: pr.id, status: 'OPEN' } });
      if (open) throw new BusinessError(`PR ini sudah memiliki RFQ terbuka (${open.number})`);
      const rfq = await tx.rfq.create({
        data: {
          tenantId: u.tenantId, number: await this.seq.next(tx, u.tenantId, 'RFQ'), projectId: pr.projectId, requestId: pr.id,
          title: dto.title ?? `Penawaran untuk ${pr.number} — ${pr.project.name}`, dueDate: dto.dueDate ? new Date(dto.dueDate) : null, createdBy: u.userId,
          items: { create: pr.items.map((i) => ({ tenantId: u.tenantId, description: i.description, quantity: i.quantity, unit: i.unit, category: i.category, costCode: i.costCode })) },
          suppliers: { create: [...new Set(dto.supplierIds)].map((supplierId) => ({ tenantId: u.tenantId, supplierId })) },
        },
      });
      await this.audit.log(u, 'CREATE', 'Rfq', rfq.id, { number: rfq.number, pr: pr.number }, tx);
      return rfq;
    });
  }

  async setSuppliers(u: AuthUser, id: string, dto: SuppliersDto) {
    const r = notFound(await this.prisma.rfq.findFirst({ where: { id, tenantId: u.tenantId } }), 'RFQ');
    if (r.status !== 'OPEN') throw new BusinessError('RFQ sudah ditutup');
    await this.assertSuppliers(u, dto.supplierIds);
    await this.prisma.$transaction(async (tx) => {
      const quoted = await tx.supplierQuotation.findMany({ where: { rfqId: id }, select: { supplierId: true } });
      const keep = new Set([...dto.supplierIds, ...quoted.map((q) => q.supplierId)]);
      await tx.rfqSupplier.deleteMany({ where: { rfqId: id, supplierId: { notIn: [...keep] } } });
      for (const supplierId of keep) {
        await tx.rfqSupplier.upsert({ where: { rfqId_supplierId: { rfqId: id, supplierId } }, create: { tenantId: u.tenantId, rfqId: id, supplierId }, update: {} });
      }
    });
    return this.get(u, id);
  }

  async saveQuotation(u: AuthUser, id: string, dto: QuotationDto) {
    return this.prisma.$transaction(async (tx) => {
      const r = notFound(await tx.rfq.findFirst({ where: { id, tenantId: u.tenantId }, include: { items: true, suppliers: true } }), 'RFQ');
      if (r.status !== 'OPEN') throw new BusinessError('RFQ sudah ditutup');
      if (!r.suppliers.some((s) => s.supplierId === dto.supplierId)) throw new BusinessError('Supplier tidak diundang di RFQ ini');
      const items = new Map(r.items.map((i) => [i.id, i]));
      const lines = dto.lines.filter((l) => items.has(l.rfqItemId) && D(l.unitPrice).gt(0)).map((l) => {
        const it = items.get(l.rfqItemId)!;
        return { rfqItemId: l.rfqItemId, unitPrice: D(l.unitPrice), amount: round2(D(l.unitPrice).mul(it.quantity)) };
      });
      if (!lines.length) throw new BusinessError('Isi minimal satu harga');
      const subtotal = sumD(lines.map((l) => l.amount));
      await tx.supplierQuotation.deleteMany({ where: { rfqId: id, supplierId: dto.supplierId } });
      const q = await tx.supplierQuotation.create({
        data: {
          tenantId: u.tenantId, rfqId: id, supplierId: dto.supplierId, quoteRef: dto.quoteRef, quoteDate: new Date(dto.quoteDate),
          leadTimeDays: dto.leadTimeDays, paymentTerm: dto.paymentTerm, validUntil: dto.validUntil ? new Date(dto.validUntil) : null,
          notes: dto.notes, subtotal,
          lines: { create: lines.map((l) => ({ tenantId: u.tenantId, ...l })) },
        },
      });
      await this.audit.log(u, 'QUOTATION', 'Rfq', id, { supplierId: dto.supplierId, subtotal: subtotal.toString() }, tx);
      return q;
    });
  }

  /** Award ke supplier terpilih → draft PO memakai harga quotation. Alasan wajib jika bukan harga terendah. */
  async award(u: AuthUser, id: string, dto: AwardDto) {
    const r = await this.get(u, id);
    if (r.status !== 'OPEN') throw new BusinessError('RFQ sudah ditutup');
    const q = r.quotations.find((x) => x.supplierId === dto.supplierId);
    if (!q) throw new BusinessError('Supplier ini belum memasukkan penawaran');
    const cmp = r.comparison.quotes.find((x) => x.supplierId === dto.supplierId)!;
    if (!cmp.complete) throw new BusinessError('Penawaran supplier belum lengkap untuk semua item');
    if (r.comparison.lowestSupplierId !== dto.supplierId && !dto.reason?.trim()) {
      throw new BusinessError('Supplier terpilih bukan harga terendah — isi alasan pemilihan');
    }
    const po = await this.procurement.createPo(u, {
      projectId: r.projectId, supplierId: dto.supplierId, requestId: r.requestId ?? undefined, taxPct: dto.taxPct,
      deliveryDate: dto.deliveryDate ?? new Date(Date.now() + q.leadTimeDays * 86400_000).toISOString(),
      terms: `Sesuai penawaran ${q.quoteRef ?? ''} (${r.number}). Termin ${q.paymentTerm} hari, lead time ${q.leadTimeDays} hari.`.replace('  ', ' '),
      items: r.items.map((i) => {
        const line = q.lines.find((l) => l.rfqItemId === i.id)!;
        return { description: i.description, quantity: i.quantity.toString(), unit: i.unit ?? undefined, unitPrice: line.unitPrice.toString(), category: i.category, costCode: i.costCode ?? undefined };
      }),
    } as any);
    await this.prisma.rfq.update({ where: { id }, data: { status: 'AWARDED', awardedSupplierId: dto.supplierId, awardReason: dto.reason, poId: po.id } });
    await this.audit.log(u, 'AWARD', 'Rfq', id, { supplierId: dto.supplierId, po: po.number, reason: dto.reason });
    return { poId: po.id, poNumber: po.number };
  }

  async cancel(u: AuthUser, id: string) {
    const r = notFound(await this.prisma.rfq.findFirst({ where: { id, tenantId: u.tenantId } }), 'RFQ');
    if (r.status !== 'OPEN') throw new BusinessError('RFQ sudah ditutup');
    await this.prisma.rfq.update({ where: { id }, data: { status: 'CANCELLED' } });
    await this.audit.log(u, 'CANCEL', 'Rfq', id);
    return { ok: true };
  }
}

@ApiTags('RFQ')
@Controller()
export class RfqController {
  constructor(private svc: RfqService) {}

  @Get('rfqs') @Perm('procurement:read')
  list(@CurrentUser() u: AuthUser) { return this.svc.list(u); }
  @Get('rfqs/:id') @Perm('procurement:read')
  get(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.get(u, id); }
  @Post('rfqs') @Perm('procurement:write')
  create(@CurrentUser() u: AuthUser, @Body() dto: RfqFromPrDto) { return this.svc.createFromPr(u, dto); }
  @Post('purchase-requests/:id/convert-to-rfq') @Perm('procurement:write')
  convert(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: SuppliersDto) { return this.svc.createFromPr(u, { requestId: id, supplierIds: dto.supplierIds }); }
  @Put('rfqs/:id/suppliers') @Perm('procurement:write')
  suppliers(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: SuppliersDto) { return this.svc.setSuppliers(u, id, dto); }
  @Post('rfqs/:id/quotations') @Perm('procurement:write')
  quote(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: QuotationDto) { return this.svc.saveQuotation(u, id, dto); }
  @Post('rfqs/:id/award') @Perm('procurement:write')
  award(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: AwardDto) { return this.svc.award(u, id, dto); }
  @Post('rfqs/:id/cancel') @Perm('procurement:write')
  cancel(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.cancel(u, id); }
}

@Module({ imports: [ProcurementModule], controllers: [RfqController], providers: [RfqService] })
export class RfqModule {}

