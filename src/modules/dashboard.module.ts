import { Controller, Get, Injectable, Module } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser, CurrentUser, hasPerm } from '../common/auth';
import { D, ZERO } from '../common/common.service';
import { ProjectsModule, ProjectsService } from './projects.module';
import { AccountingModule } from './accounting.module';
import { BillingModule, BillingService } from './billing.module';

@Injectable()
export class DashboardService {
  constructor(private prisma: PrismaService, private projects: ProjectsService, private billing: BillingService) {}

  async executive(u: AuthUser) {
    const t = u.tenantId;
    const canFinance = hasPerm(u, 'finance:read');
    const [projects, pendingApprovals, tenders, ar, ap, cash, cashflow, assets, recent] = await Promise.all([
      this.projects.list(u),
      this.prisma.approvalRequest.count({ where: { tenantId: t, status: 'IN_APPROVAL' } }),
      this.prisma.tender.groupBy({ by: ['status'], where: { tenantId: t }, _count: true }),
      this.prisma.customerInvoice.aggregate({ where: { tenantId: t, status: { in: ['ISSUED', 'PARTIAL_PAID'] } }, _sum: { total: true, paidAmount: true } }),
      this.prisma.supplierInvoice.aggregate({ where: { tenantId: t, status: { in: ['POSTED', 'PARTIAL_PAID'] } }, _sum: { total: true, paidAmount: true } }),
      canFinance ? this.billing.cashBalance(u) : Promise.resolve(null),
      canFinance ? this.billing.cashflow(u) : Promise.resolve([]),
      this.prisma.asset.groupBy({ by: ['status'], where: { tenantId: t }, _count: true }),
      this.prisma.auditLog.findMany({ where: { tenantId: t, action: { notIn: ['LOGIN', 'EXPORT'] } }, orderBy: { createdAt: 'desc' }, take: 8 }),
    ]);

    const live = projects.filter((p) => !['CANCELLED', 'CLOSED'].includes(p.status));
    const sum = (f: (p: (typeof live)[number]) => any) => live.reduce((a, p) => a.plus(D(f(p))), ZERO);

    return {
      kpi: {
        activeProjects: projects.filter((p) => p.status === 'ACTIVE').length,
        totalProjects: projects.length,
        contractValue: sum((p) => p.contractValue),
        budget: sum((p) => p.cost.budget),
        commitment: sum((p) => p.cost.commitment),
        actual: sum((p) => p.cost.actual),
        eac: sum((p) => p.cost.eac),
        forecastMargin: sum((p) => p.forecastMargin),
        billed: sum((p) => p.billed),
        arOutstanding: D(ar._sum.total).minus(D(ar._sum.paidAmount)),
        apOutstanding: D(ap._sum.total).minus(D(ap._sum.paidAmount)),
        cashBalance: cash,
        pendingApprovals,
      },
      tenders: Object.fromEntries(tenders.map((x) => [x.status, x._count])),
      assets: Object.fromEntries(assets.map((x) => [x.status, x._count])),
      projects: live.map((p) => ({
        id: p.id, code: p.code, name: p.name, status: p.status, contractValue: p.contractValue,
        progressPct: p.progressPct, plannedPct: p.plannedPct, budget: p.cost.budget, actual: p.cost.actual,
        commitment: p.cost.commitment, eac: p.cost.eac, usedPct: p.cost.usedPct, alert: p.cost.alert,
        forecastMarginPct: p.forecastMarginPct,
      })),
      cashflow,
      recent,
    };
  }
}

@ApiTags('Dashboard')
@Controller('dashboard')
export class DashboardController {
  constructor(private svc: DashboardService) {}
  @Get('executive')
  exec(@CurrentUser() u: AuthUser) { return this.svc.executive(u); }
}

@Module({ imports: [ProjectsModule, AccountingModule, BillingModule], controllers: [DashboardController], providers: [DashboardService] })
export class DashboardModule {}
