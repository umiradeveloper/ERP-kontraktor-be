import { Body, Controller, Delete, Get, Injectable, Logger, Module, OnModuleDestroy, OnModuleInit, Param, Post } from '@nestjs/common';
import { IsOptional, IsString, Length } from 'class-validator';
import { ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser, CurrentUser } from '../common/auth';
import { NotifyService } from '../common/notify.service';
import { CostService, ProjectsModule } from './projects.module';

class PushTokenDto {
  /** Token FCM dari aplikasi mobile */
  @IsString() @Length(20, 255) token!: string;
  @IsOptional() @IsString() platform?: string;
}

const rp = (n: number) => 'Rp ' + Math.round(n).toLocaleString('id-ID');

/**
 * Alert otomatis (PRD §5.6, §5.14): budget 80%/100%, invoice owner jatuh tempo,
 * hutang supplier jatuh tempo. Dedupe key mencegah notifikasi berulang.
 */
@Injectable()
export class AlertService implements OnModuleInit, OnModuleDestroy {
  private logger = new Logger('Alerts');
  private timer?: NodeJS.Timeout;

  constructor(private prisma: PrismaService, private notify: NotifyService, private cost: CostService) {}

  onModuleInit() {
    if (process.env.DISABLE_ALERT_SCAN === 'true') return;
    // Scan berkala tiap jam; job pertama 10 detik setelah start
    setTimeout(() => this.scanAll().catch((e) => this.logger.warn(e.message)), 10_000).unref();
    this.timer = setInterval(() => this.scanAll().catch((e) => this.logger.warn(e.message)), 3600_000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async checkBudget(tenantId: string, projectId: string) {
    const p = await this.prisma.project.findFirst({ where: { id: projectId, tenantId } });
    if (!p) return;
    const b = await this.cost.buckets(tenantId, [projectId]);
    const { total, rows } = this.cost.summarize(b.get(projectId));
    if (total.budget.lte(0)) return;
    const level = total.usedPct >= 100 ? 100 : total.usedPct >= 80 ? 80 : 0;
    if (level) {
      await this.notify.toRoles(tenantId, ['Project Manager', 'Cost Controller', 'Direktur'], {
        type: 'BUDGET_ALERT',
        title: `${p.code}: pemakaian budget ${level === 100 ? 'melewati 100%' : 'mencapai 80%'}`,
        body: `${p.name} — actual + commitment ${rp(total.actual.plus(total.commitment).toNumber())} dari budget ${rp(total.budget.toNumber())} (${total.usedPct.toFixed(0)}%).`,
        link: `/projects/${p.id}`,
        dedupeKey: `BUDGET${level}:${p.id}`,
      });
    }
    for (const r of rows.filter((x) => x.alert === 'OVER' && x.budget.gt(0))) {
      await this.notify.toRoles(tenantId, ['Project Manager', 'Cost Controller'], {
        type: 'BUDGET_ALERT',
        title: `${p.code}: kategori ${r.category.toLowerCase()} melewati budget`,
        body: `Actual + commitment ${rp(r.actual.plus(r.commitment).toNumber())} vs budget ${rp(r.budget.toNumber())}.`,
        link: `/projects/${p.id}`,
        dedupeKey: `BUDGETCAT:${p.id}:${r.category}`,
      });
    }
  }

  async scanTenant(tenantId: string) {
    const now = new Date();
    const soon = new Date(now.getTime() + 3 * 86400_000);
    const ar = await this.prisma.customerInvoice.findMany({
      where: { tenantId, status: { in: ['ISSUED', 'PARTIAL_PAID'] }, dueDate: { lt: now } },
      include: { project: { select: { code: true, ownerName: true } } },
    });
    for (const i of ar) {
      await this.notify.toRoles(tenantId, ['Finance'], {
        type: 'AR_OVERDUE',
        title: `Invoice ${i.number} lewat jatuh tempo`,
        body: `${i.project.ownerName ?? i.project.code} — sisa ${rp(i.total.minus(i.paidAmount).toNumber())}.`,
        link: '/finance/invoices',
        dedupeKey: `AR_OVERDUE:${i.id}`,
      });
    }
    const ap = await this.prisma.supplierInvoice.findMany({
      where: { tenantId, status: { in: ['POSTED', 'PARTIAL_PAID'] }, dueDate: { lt: soon } },
      include: { supplier: { select: { name: true } } },
    });
    for (const i of ap) {
      const overdue = i.dueDate < now;
      await this.notify.toRoles(tenantId, ['Finance'], {
        type: 'AP_DUE',
        title: `${overdue ? 'Hutang lewat jatuh tempo' : 'Hutang jatuh tempo ≤ 3 hari'}: ${i.number}`,
        body: `${i.supplier.name} — sisa ${rp(i.total.minus(i.paidAmount).toNumber())}.`,
        link: '/finance/ap',
        dedupeKey: `AP_${overdue ? 'OVERDUE' : 'SOON'}:${i.id}`,
      });
    }
    const projects = await this.prisma.project.findMany({ where: { tenantId, status: { in: ['ACTIVE', 'COMPLETION'] } }, select: { id: true } });
    for (const p of projects) await this.checkBudget(tenantId, p.id);
  }

  async scanAll() {
    const tenants = await this.prisma.tenant.findMany({ where: { status: 'ACTIVE' }, select: { id: true } });
    for (const t of tenants) await this.scanTenant(t.id);
  }
}

@ApiTags('Notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private prisma: PrismaService) {}

  @Get()
  async list(@CurrentUser() u: AuthUser) {
    const [items, unread] = await Promise.all([
      this.prisma.notification.findMany({ where: { tenantId: u.tenantId, userId: u.userId }, orderBy: { createdAt: 'desc' }, take: 50 }),
      this.prisma.notification.count({ where: { tenantId: u.tenantId, userId: u.userId, readAt: null } }),
    ]);
    return { items, unread };
  }

  @Post('read-all')
  async readAll(@CurrentUser() u: AuthUser) {
    await this.prisma.notification.updateMany({ where: { tenantId: u.tenantId, userId: u.userId, readAt: null }, data: { readAt: new Date() } });
    return { ok: true };
  }

  /** Registrasi token push perangkat mobile */
  @Post('push-token')
  async registerPush(@CurrentUser() u: AuthUser, @Body() dto: PushTokenDto) {
    await this.prisma.devicePushToken.upsert({
      where: { token: dto.token },
      create: { tenantId: u.tenantId, userId: u.userId, token: dto.token, platform: dto.platform },
      update: { tenantId: u.tenantId, userId: u.userId, platform: dto.platform },
    });
    return { ok: true };
  }

  @Delete('push-token/:token')
  async unregisterPush(@CurrentUser() u: AuthUser, @Param('token') token: string) {
    await this.prisma.devicePushToken.deleteMany({ where: { token, userId: u.userId } });
    return { ok: true };
  }

  @Post(':id/read')
  async read(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    await this.prisma.notification.updateMany({ where: { id, tenantId: u.tenantId, userId: u.userId }, data: { readAt: new Date() } });
    return { ok: true };
  }
}

@Module({ imports: [ProjectsModule], controllers: [NotificationsController], providers: [AlertService], exports: [AlertService] })
export class NotificationsModule {}
