import { Body, Controller, Get, Injectable, Module, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsDateString, IsIn, IsInt, IsNumberString, IsOptional, IsString, Min } from 'class-validator';
import { CostCategory, Prisma, ProjectStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser, CurrentUser, Perm } from '../common/auth';
import { AuditService, D, notFound, SequenceService, ZERO } from '../common/common.service';
import { BusinessError } from '../common/http';

const CATEGORIES: CostCategory[] = ['MATERIAL', 'LABOR', 'EQUIPMENT', 'SUBCONTRACTOR', 'OVERHEAD', 'OTHER'];
const COMMITTED_PO = ['APPROVED', 'ISSUED', 'PARTIAL_RECEIPT', 'RECEIVED'] as const;

class ProjectDto {
  @IsString() name!: string;
  @IsOptional() @IsString() customerId?: string;
  @IsOptional() @IsString() location?: string;
  @IsOptional() @IsString() managerName?: string;
  @IsNumberString() contractValue!: string;
  @IsOptional() @IsNumberString() retentionPct?: string;
  @IsOptional() @IsDateString() startDate?: string;
  @IsOptional() @IsDateString() endDate?: string;
}
class ProjectPatchDto {
  @IsOptional() @IsIn(['SETUP', 'ACTIVE', 'ON_HOLD', 'COMPLETION', 'CLOSED', 'CANCELLED']) status?: ProjectStatus;
  @IsOptional() @IsString() managerName?: string;
  @IsOptional() @IsString() location?: string;
  @IsOptional() @IsDateString() startDate?: string;
  @IsOptional() @IsDateString() endDate?: string;
}
class ProgressDto {
  @IsDateString() reportDate!: string;
  @IsNumberString() plannedPct!: string;
  @IsNumberString() actualPct!: string;
  @IsOptional() @IsString() notes?: string;
}
class DailyReportDto {
  @IsDateString() reportDate!: string;
  @IsOptional() @IsString() weather?: string;
  @IsInt() @Min(0) manpower!: number;
  @IsString() activities!: string;
  @IsOptional() @IsString() issues?: string;
}

const TRANSITIONS: Record<ProjectStatus, ProjectStatus[]> = {
  SETUP: ['ACTIVE', 'CANCELLED'],
  ACTIVE: ['ON_HOLD', 'COMPLETION'],
  ON_HOLD: ['ACTIVE', 'CANCELLED'],
  COMPLETION: ['CLOSED', 'ACTIVE'],
  CLOSED: [],
  CANCELLED: [],
};

type Bucket = { budget: Prisma.Decimal; commitment: Prisma.Decimal; actual: Prisma.Decimal };

/**
 * Cost control (PRD §5.6). Budget, commitment, actual dan forecast adalah konsep terpisah:
 * - Budget     : baseline approved (revisi tertinggi)
 * - Commitment : nilai PO approved yang BELUM ditagih supplier → (qty − invoicedQty) × harga
 * - Actual     : biaya diakui (supplier invoice posted, expense, dll)
 * - EAC        : actual + commitment + sisa budget (ETC), minimal = actual + commitment
 * Saat invoice diposting, invoicedQty naik → commitment turun & actual naik (tanpa double count).
 */
@Injectable()
export class CostService {
  constructor(private prisma: PrismaService) {}

  async buckets(tenantId: string, projectIds: string[]) {
    const map = new Map<string, Record<string, Bucket>>();
    const get = (pid: string, cat: string) => {
      if (!map.has(pid)) map.set(pid, {});
      const m = map.get(pid)!;
      return (m[cat] ??= { budget: ZERO, commitment: ZERO, actual: ZERO });
    };
    if (projectIds.length === 0) return map;

    const budgets = await this.prisma.budget.findMany({
      where: { tenantId, projectId: { in: projectIds }, isBaseline: true },
      orderBy: { revision: 'desc' },
      include: { items: { select: { category: true, amount: true } } },
    });
    const seen = new Set<string>();
    for (const b of budgets) {
      if (seen.has(b.projectId)) continue;
      seen.add(b.projectId);
      for (const i of b.items) get(b.projectId, i.category).budget = get(b.projectId, i.category).budget.plus(i.amount);
    }

    const poItems = await this.prisma.purchaseOrderItem.findMany({
      where: { tenantId, po: { projectId: { in: projectIds }, status: { in: [...COMMITTED_PO] } } },
      select: { quantity: true, invoicedQty: true, unitPrice: true, category: true, po: { select: { projectId: true } } },
    });
    for (const i of poItems) {
      const open = i.quantity.minus(i.invoicedQty);
      if (open.lte(0)) continue;
      const b = get(i.po.projectId, i.category);
      b.commitment = b.commitment.plus(open.mul(i.unitPrice));
    }

    const actual = await this.prisma.projectCost.groupBy({
      by: ['projectId', 'category'],
      where: { tenantId, projectId: { in: projectIds } },
      _sum: { amount: true },
    });
    for (const a of actual) get(a.projectId, a.category).actual = D(a._sum.amount);

    return map;
  }

  summarize(cats: Record<string, Bucket> = {}) {
    const rows = CATEGORIES.map((category) => {
      const b = cats[category] ?? { budget: ZERO, commitment: ZERO, actual: ZERO };
      const spent = b.actual.plus(b.commitment);
      const etc = Prisma.Decimal.max(b.budget.minus(spent), ZERO);
      const eac = spent.plus(etc);
      const usedPct = b.budget.gt(0) ? spent.div(b.budget).mul(100).toNumber() : spent.gt(0) ? 100 : 0;
      return {
        category, budget: b.budget, commitment: b.commitment, actual: b.actual, etc, eac,
        variance: b.budget.minus(eac), usedPct,
        alert: usedPct >= 100 ? 'OVER' : usedPct >= 80 ? 'WARNING' : 'OK',
      };
    });
    const total = rows.reduce(
      (t, r) => ({
        budget: t.budget.plus(r.budget), commitment: t.commitment.plus(r.commitment), actual: t.actual.plus(r.actual),
        etc: t.etc.plus(r.etc), eac: t.eac.plus(r.eac), variance: t.variance.plus(r.variance),
      }),
      { budget: ZERO, commitment: ZERO, actual: ZERO, etc: ZERO, eac: ZERO, variance: ZERO },
    );
    const usedPct = total.budget.gt(0) ? total.actual.plus(total.commitment).div(total.budget).mul(100).toNumber() : 0;
    return { rows, total: { ...total, usedPct, alert: usedPct >= 100 ? 'OVER' : usedPct >= 80 ? 'WARNING' : 'OK' } };
  }
}

@Injectable()
export class ProjectsService {
  constructor(
    private prisma: PrismaService,
    private seq: SequenceService,
    private audit: AuditService,
    private cost: CostService,
  ) {}

  async list(u: AuthUser) {
    const projects = await this.prisma.project.findMany({
      where: { tenantId: u.tenantId },
      include: { customer: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const buckets = await this.cost.buckets(u.tenantId, projects.map((p) => p.id));
    const billed = await this.prisma.customerInvoice.groupBy({
      by: ['projectId'],
      where: { tenantId: u.tenantId, status: { notIn: ['DRAFT', 'CANCELLED'] } },
      _sum: { grossAmount: true },
    });
    const billedMap = new Map(billed.map((b) => [b.projectId, D(b._sum.grossAmount)]));
    return projects.map((p) => {
      const { total } = this.cost.summarize(buckets.get(p.id));
      // Tanpa budget baseline, forecast margin belum bisa dihitung
      const hasBudget = total.budget.gt(0);
      const margin = hasBudget ? p.contractValue.minus(total.eac) : null;
      return {
        ...p,
        cost: total,
        billed: billedMap.get(p.id) ?? ZERO,
        forecastMargin: margin,
        forecastMarginPct: margin && p.contractValue.gt(0) ? margin.div(p.contractValue).mul(100).toNumber() : null,
      };
    });
  }

  async get(u: AuthUser, id: string) {
    const p = notFound(
      await this.prisma.project.findFirst({
        where: { id, tenantId: u.tenantId },
        include: { customer: true, company: true },
      }),
      'Proyek',
    );
    const [progress, dailyReports, invoices] = await Promise.all([
      this.prisma.progressEntry.findMany({ where: { tenantId: u.tenantId, projectId: id }, orderBy: { reportDate: 'asc' } }),
      this.prisma.dailyReport.findMany({ where: { tenantId: u.tenantId, projectId: id }, orderBy: { reportDate: 'desc' }, take: 30 }),
      this.prisma.customerInvoice.findMany({ where: { tenantId: u.tenantId, projectId: id }, orderBy: { invoiceDate: 'desc' } }),
    ]);
    const buckets = await this.cost.buckets(u.tenantId, [id]);
    const cost = this.cost.summarize(buckets.get(id));
    const billedGross = invoices.filter((i) => !['DRAFT', 'CANCELLED'].includes(i.status)).reduce((a, i) => a.plus(i.grossAmount), ZERO);
    const received = invoices.reduce((a, i) => a.plus(i.paidAmount), ZERO);
    return {
      ...p,
      progress,
      dailyReports,
      cost,
      finance: {
        contractValue: p.contractValue,
        billedGross,
        received,
        forecastMargin: cost.total.budget.gt(0) ? p.contractValue.minus(cost.total.eac) : null,
      },
    };
  }

  async bq(u: AuthUser, id: string) {
    notFound(await this.prisma.project.findFirst({ where: { id, tenantId: u.tenantId } }), 'Proyek');
    return this.prisma.bqItem.findMany({ where: { tenantId: u.tenantId, projectId: id }, orderBy: { sortOrder: 'asc' } });
  }

  async budget(u: AuthUser, id: string) {
    notFound(await this.prisma.project.findFirst({ where: { id, tenantId: u.tenantId } }), 'Proyek');
    return this.prisma.budget.findFirst({
      where: { tenantId: u.tenantId, projectId: id, isBaseline: true },
      orderBy: { revision: 'desc' },
      include: { items: true },
    });
  }

  async costs(u: AuthUser, id: string) {
    notFound(await this.prisma.project.findFirst({ where: { id, tenantId: u.tenantId } }), 'Proyek');
    return this.prisma.projectCost.findMany({ where: { tenantId: u.tenantId, projectId: id }, orderBy: { costDate: 'desc' } });
  }

  async create(u: AuthUser, dto: ProjectDto) {
    return this.prisma.$transaction(async (tx) => {
      const company = notFound(await tx.company.findFirst({ where: { tenantId: u.tenantId } }), 'Perusahaan');
      let ownerName: string | undefined;
      if (dto.customerId) {
        const c = notFound(await tx.customer.findFirst({ where: { id: dto.customerId, tenantId: u.tenantId } }), 'Customer');
        ownerName = c.name;
      }
      const p = await tx.project.create({
        data: {
          tenantId: u.tenantId, companyId: company.id, customerId: dto.customerId || null, ownerName,
          code: await this.seq.next(tx, u.tenantId, 'PRJ'), name: dto.name, location: dto.location,
          managerName: dto.managerName, contractValue: D(dto.contractValue),
          retentionPct: dto.retentionPct ? D(dto.retentionPct) : undefined,
          startDate: dto.startDate ? new Date(dto.startDate) : null, endDate: dto.endDate ? new Date(dto.endDate) : null,
          budgets: { create: { tenantId: u.tenantId, name: 'Baseline', isBaseline: true } },
        },
      });
      await this.audit.log(u, 'CREATE', 'Project', p.id, { code: p.code }, tx);
      return p;
    });
  }

  async update(u: AuthUser, id: string, dto: ProjectPatchDto) {
    const p = notFound(await this.prisma.project.findFirst({ where: { id, tenantId: u.tenantId } }), 'Proyek');
    if (dto.status && dto.status !== p.status && !TRANSITIONS[p.status].includes(dto.status)) {
      throw new BusinessError(`Status proyek tidak bisa berubah dari ${p.status} ke ${dto.status}`);
    }
    const res = await this.prisma.project.update({
      where: { id },
      data: {
        status: dto.status, managerName: dto.managerName, location: dto.location,
        startDate: dto.startDate ? new Date(dto.startDate) : undefined, endDate: dto.endDate ? new Date(dto.endDate) : undefined,
      },
    });
    await this.audit.log(u, dto.status && dto.status !== p.status ? `STATUS_${dto.status}` : 'UPDATE', 'Project', id, { before: { status: p.status }, after: dto });
    return res;
  }

  async addProgress(u: AuthUser, id: string, dto: ProgressDto) {
    const p = notFound(await this.prisma.project.findFirst({ where: { id, tenantId: u.tenantId } }), 'Proyek');
    if (!['ACTIVE', 'COMPLETION'].includes(p.status)) throw new BusinessError('Progres hanya dapat dicatat untuk proyek aktif');
    const actual = D(dto.actualPct), planned = D(dto.plannedPct);
    if (actual.lt(0) || actual.gt(100) || planned.lt(0) || planned.gt(100)) throw new BusinessError('Persentase harus 0–100');
    return this.prisma.$transaction(async (tx) => {
      const e = await tx.progressEntry.create({
        data: { tenantId: u.tenantId, projectId: id, reportDate: new Date(dto.reportDate), plannedPct: planned, actualPct: actual, notes: dto.notes, createdBy: u.userId },
      });
      await tx.project.update({ where: { id }, data: { progressPct: actual, plannedPct: planned } });
      await this.audit.log(u, 'PROGRESS', 'Project', id, { actual: dto.actualPct, planned: dto.plannedPct }, tx);
      return e;
    });
  }

  async addDailyReport(u: AuthUser, id: string, dto: DailyReportDto) {
    notFound(await this.prisma.project.findFirst({ where: { id, tenantId: u.tenantId } }), 'Proyek');
    const r = await this.prisma.dailyReport.create({
      data: { tenantId: u.tenantId, projectId: id, reportDate: new Date(dto.reportDate), weather: dto.weather, manpower: dto.manpower, activities: dto.activities, issues: dto.issues, createdBy: u.userId },
    });
    await this.audit.log(u, 'DAILY_REPORT', 'Project', id, { reportId: r.id });
    return r;
  }

  async costPortfolio(u: AuthUser) {
    const rows = await this.list(u);
    return rows.filter((p) => !['CANCELLED'].includes(p.status));
  }
}

@ApiTags('Projects & Cost Control')
@Controller()
export class ProjectsController {
  constructor(private svc: ProjectsService) {}

  @Get('projects') @Perm('project:read', 'cost:read', 'procurement:read', 'finance:read')
  list(@CurrentUser() u: AuthUser) { return this.svc.list(u); }
  @Post('projects') @Perm('project:write')
  create(@CurrentUser() u: AuthUser, @Body() dto: ProjectDto) { return this.svc.create(u, dto); }
  @Get('projects/:id') @Perm('project:read', 'cost:read')
  get(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.get(u, id); }
  @Patch('projects/:id') @Perm('project:write')
  update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ProjectPatchDto) { return this.svc.update(u, id, dto); }
  @Get('projects/:id/bq/items') @Perm('project:read', 'tender:read')
  bq(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.bq(u, id); }
  @Get('projects/:id/budget') @Perm('project:read', 'cost:read')
  budget(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.budget(u, id); }
  @Get('projects/:id/costs') @Perm('cost:read', 'project:read')
  costs(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.costs(u, id); }
  @Post('projects/:id/progress') @Perm('project:write')
  progress(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ProgressDto) { return this.svc.addProgress(u, id, dto); }
  @Post('projects/:id/daily-reports') @Perm('project:write')
  daily(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: DailyReportDto) { return this.svc.addDailyReport(u, id, dto); }
  @Get('reports/cost-control') @Perm('cost:read')
  portfolio(@CurrentUser() u: AuthUser) { return this.svc.costPortfolio(u); }
}

@Module({ controllers: [ProjectsController], providers: [ProjectsService, CostService], exports: [CostService, ProjectsService] })
export class ProjectsModule {}
