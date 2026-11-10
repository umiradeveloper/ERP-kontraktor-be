import { Body, Controller, ForbiddenException, Get, Injectable, Module, Param, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsIn, IsNumberString, IsOptional, IsString, ValidateNested } from 'class-validator';
import { PrismaService, Tx } from '../prisma/prisma.service';
import { AuthUser, CurrentUser, Perm } from '../common/auth';
import { AuditService, D, notFound } from '../common/common.service';
import { NotifyService } from '../common/notify.service';
import { BusinessError } from '../common/http';

export type FinalStatus = 'APPROVED' | 'REJECTED' | 'REVISION';
/** Handler boleh mengembalikan fungsi yang dijalankan setelah transaksi commit (mis. alert) */
type Handler = (tx: Tx, tenantId: string, entityId: string, status: FinalStatus) => Promise<void | (() => Promise<void>)>;
type LinkFn = (tx: Tx, entityId: string) => Promise<string> | string;
const VERB: Record<FinalStatus, string> = { APPROVED: 'disetujui', REJECTED: 'ditolak', REVISION: 'dikembalikan untuk revisi' };

interface Step {
  step: number;
  roleName: string;
  minAmount: string;
}

class DecisionDto {
  @IsIn(['APPROVE', 'REJECT', 'REVISION']) decision!: 'APPROVE' | 'REJECT' | 'REVISION';
  @IsOptional() @IsString() comment?: string;
}
class StepDto {
  @IsString() roleName!: string;
  @IsNumberString() minAmount!: string;
}
class WorkflowDto {
  @IsString() name!: string;
  @ValidateNested({ each: true }) @Type(() => StepDto) @ArrayMinSize(1) steps!: StepDto[];
}

/**
 * Approval engine configurable (PRD §5.13):
 * - workflow per entityType dengan langkah berbasis role & batas nominal
 * - snapshot langkah disimpan saat diajukan → perubahan workflow hanya berlaku untuk transaksi baru
 * - self-approval dilarang, semua validasi di server
 */
@Injectable()
export class ApprovalsService {
  private handlers = new Map<string, Handler>();
  private links = new Map<string, LinkFn>();
  constructor(private prisma: PrismaService, private audit: AuditService, private notify: NotifyService) {}

  registerHandler(entityType: string, handler: Handler, link?: LinkFn) {
    this.handlers.set(entityType, handler);
    if (link) this.links.set(entityType, link);
  }

  private async linkOf(tx: Tx, entityType: string, entityId: string) {
    return (await this.links.get(entityType)?.(tx, entityId)) ?? '/approvals';
  }

  private async notifyStep(tx: Tx, tenantId: string, requestedBy: string, step: Step, p: { entityType: string; entityId: string; title: string; amount: string }) {
    await this.notify.toRoles(
      tenantId,
      [step.roleName],
      { type: 'APPROVAL_PENDING', title: `Perlu approval: ${p.title}`, body: `Nilai Rp ${Number(p.amount).toLocaleString('id-ID')}. Menunggu keputusan ${step.roleName}.`, link: '/approvals' },
      { exclude: [requestedBy], tx },
    );
  }

  async submit(
    tx: Tx,
    user: AuthUser,
    p: { entityType: string; entityId: string; entityNumber: string; title: string; amount: string },
  ): Promise<'IN_APPROVAL' | 'APPROVED'> {
    const pending = await tx.approvalRequest.findFirst({
      where: { tenantId: user.tenantId, entityType: p.entityType, entityId: p.entityId, status: 'IN_APPROVAL' },
    });
    if (pending) throw new BusinessError('Dokumen sudah dalam proses approval');

    const wf = await tx.workflowDefinition.findFirst({
      where: { tenantId: user.tenantId, entityType: p.entityType, isActive: true },
      orderBy: { version: 'desc' },
    });
    const amount = D(p.amount);
    const steps = ((wf?.steps as unknown as Step[]) ?? [])
      .filter((s) => amount.gte(D(s.minAmount)))
      .map((s, i) => ({ ...s, step: i + 1 }));

    if (steps.length === 0) {
      // Tidak ada langkah yang berlaku → auto-approve, tetap tercatat
      await tx.approvalRequest.create({
        data: {
          tenantId: user.tenantId, entityType: p.entityType, entityId: p.entityId, entityNumber: p.entityNumber,
          title: p.title, amount, requestedBy: user.userId, status: 'APPROVED', workflowVersion: wf?.version ?? 0,
          stepsSnapshot: [], completedAt: new Date(),
        },
      });
      await this.handlers.get(p.entityType)?.(tx, user.tenantId, p.entityId, 'APPROVED');
      return 'APPROVED';
    }

    await tx.approvalRequest.create({
      data: {
        tenantId: user.tenantId, entityType: p.entityType, entityId: p.entityId, entityNumber: p.entityNumber,
        title: p.title, amount, requestedBy: user.userId, workflowVersion: wf!.version,
        stepsSnapshot: steps as any,
      },
    });
    await this.notifyStep(tx, user.tenantId, user.userId, steps[0], p);
    return 'IN_APPROVAL';
  }

  private canAct(user: AuthUser, step: Step | undefined) {
    if (!step) return false;
    return user.roles.includes(step.roleName) || user.perms.includes('*');
  }

  async inbox(user: AuthUser) {
    const rows = await this.prisma.approvalRequest.findMany({
      where: { tenantId: user.tenantId, status: 'IN_APPROVAL' },
      orderBy: { createdAt: 'asc' },
      include: { decisions: { orderBy: { decidedAt: 'asc' } } },
    });
    const users = await this.userNames(user.tenantId);
    const links = await Promise.all(rows.map((r) => this.linkOf(this.prisma, r.entityType, r.entityId)));
    return rows.map((r, idx) => {
      const steps = r.stepsSnapshot as unknown as Step[];
      const current = steps.find((s) => s.step === r.currentStep);
      return {
        ...r,
        link: links[idx],
        requestedByName: users.get(r.requestedBy),
        currentRole: current?.roleName,
        totalSteps: steps.length,
        canAct: this.canAct(user, current) && r.requestedBy !== user.userId,
        isMine: r.requestedBy === user.userId,
      };
    });
  }

  async history(user: AuthUser, entityType: string, entityId: string) {
    const rows = await this.prisma.approvalRequest.findMany({
      where: { tenantId: user.tenantId, entityType, entityId },
      orderBy: { createdAt: 'desc' },
      include: { decisions: { orderBy: { decidedAt: 'asc' } } },
    });
    const users = await this.userNames(user.tenantId);
    return rows.map((r) => ({
      ...r,
      requestedByName: users.get(r.requestedBy),
      decisions: r.decisions.map((d) => ({ ...d, approverName: users.get(d.approverId) })),
    }));
  }

  async decide(user: AuthUser, id: string, dto: DecisionDto) {
    const post: { fn?: () => Promise<void> } = {};
    const result = await this.prisma.$transaction(async (tx) => {
      const req = notFound(
        await tx.approvalRequest.findFirst({ where: { id, tenantId: user.tenantId } }),
        'Permintaan approval',
      );
      if (req.status !== 'IN_APPROVAL') throw new BusinessError('Approval sudah selesai');
      if (req.requestedBy === user.userId) {
        throw new ForbiddenException({ code: 'SELF_APPROVAL', message: 'Tidak boleh menyetujui dokumen sendiri' });
      }
      const steps = req.stepsSnapshot as unknown as Step[];
      const step = steps.find((s) => s.step === req.currentStep);
      if (!this.canAct(user, step)) {
        throw new ForbiddenException({ code: 'NOT_APPROVER', message: `Langkah ini harus disetujui oleh role ${step?.roleName}` });
      }
      if (dto.decision !== 'APPROVE' && !dto.comment?.trim()) {
        throw new BusinessError('Komentar wajib diisi saat menolak atau meminta revisi');
      }

      await tx.approvalDecision.create({
        data: { tenantId: user.tenantId, approvalId: id, step: req.currentStep, approverId: user.userId, decision: dto.decision, comment: dto.comment },
      });

      let final: FinalStatus | null = null;
      if (dto.decision === 'REJECT') final = 'REJECTED';
      else if (dto.decision === 'REVISION') final = 'REVISION';
      else if (req.currentStep >= steps.length) final = 'APPROVED';

      if (final) {
        await tx.approvalRequest.update({ where: { id }, data: { status: final, completedAt: new Date() } });
        const cb = await this.handlers.get(req.entityType)?.(tx, user.tenantId, req.entityId, final);
        if (typeof cb === 'function') post.fn = cb;
        await this.notify.toUsers(user.tenantId, [req.requestedBy], {
          type: 'APPROVAL_RESULT',
          title: `${req.title} ${VERB[final]}`,
          body: dto.comment ? `${user.name}: “${dto.comment}”` : `Oleh ${user.name}`,
          link: await this.linkOf(tx, req.entityType, req.entityId),
        }, tx);
      } else {
        await tx.approvalRequest.update({ where: { id }, data: { currentStep: { increment: 1 } } });
        const next = steps.find((s) => s.step === req.currentStep + 1);
        if (next) await this.notifyStep(tx, user.tenantId, req.requestedBy, next, { entityType: req.entityType, entityId: req.entityId, title: req.title, amount: req.amount.toString() });
      }
      await this.audit.log(user, `APPROVAL_${dto.decision}`, req.entityType, req.entityId, { step: req.currentStep, comment: dto.comment }, tx);
      return { status: final ?? 'IN_APPROVAL' };
    });
    if (post.fn) await post.fn().catch(() => undefined);
    return result;
  }

  async workflows(user: AuthUser) {
    return this.prisma.workflowDefinition.findMany({
      where: { tenantId: user.tenantId, isActive: true },
      orderBy: { entityType: 'asc' },
    });
  }

  /** Menyimpan workflow sebagai versi baru; transaksi berjalan tetap memakai snapshot lama. */
  async saveWorkflow(user: AuthUser, entityType: string, dto: WorkflowDto) {
    return this.prisma.$transaction(async (tx) => {
      const last = await tx.workflowDefinition.findFirst({
        where: { tenantId: user.tenantId, entityType },
        orderBy: { version: 'desc' },
      });
      await tx.workflowDefinition.updateMany({ where: { tenantId: user.tenantId, entityType }, data: { isActive: false } });
      const wf = await tx.workflowDefinition.create({
        data: {
          tenantId: user.tenantId, entityType, name: dto.name, version: (last?.version ?? 0) + 1,
          steps: dto.steps.map((s, i) => ({ step: i + 1, roleName: s.roleName, minAmount: s.minAmount })),
        },
      });
      await this.audit.log(user, 'WORKFLOW_VERSION', 'WorkflowDefinition', wf.id, { entityType, version: wf.version }, tx);
      return wf;
    });
  }

  private async userNames(tenantId: string) {
    const users = await this.prisma.user.findMany({ where: { tenantId }, select: { id: true, name: true } });
    return new Map(users.map((u) => [u.id, u.name]));
  }
}

@ApiTags('Approvals')
@Controller()
export class ApprovalsController {
  constructor(private svc: ApprovalsService) {}

  @Get('approvals/inbox')
  inbox(@CurrentUser() u: AuthUser) {
    return this.svc.inbox(u);
  }

  @Get('approvals/history/:entityType/:entityId')
  history(@CurrentUser() u: AuthUser, @Param('entityType') t: string, @Param('entityId') id: string) {
    return this.svc.history(u, t, id);
  }

  @Post('approvals/:id/decision')
  decide(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: DecisionDto) {
    return this.svc.decide(u, id, dto);
  }

  @Get('workflows')
  @Perm('admin:read')
  workflows(@CurrentUser() u: AuthUser) {
    return this.svc.workflows(u);
  }

  @Put('workflows/:entityType')
  @Perm('admin:write')
  save(@CurrentUser() u: AuthUser, @Param('entityType') t: string, @Body() dto: WorkflowDto) {
    return this.svc.saveWorkflow(u, t, dto);
  }
}

@Module({ controllers: [ApprovalsController], providers: [ApprovalsService], exports: [ApprovalsService] })
export class ApprovalsModule {}
