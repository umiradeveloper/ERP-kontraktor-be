import { Body, Controller, Get, Injectable, Module, OnModuleInit, Param, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsNumberString, IsOptional, IsString, ValidateNested } from 'class-validator';
import { CostCategory } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser, CurrentUser, Perm } from '../common/auth';
import { AuditService, D, notFound, SequenceService, sumD } from '../common/common.service';
import { BusinessError } from '../common/http';
import { ApprovalsModule, ApprovalsService } from './approvals.module';

const CATS = ['MATERIAL', 'LABOR', 'EQUIPMENT', 'SUBCONTRACTOR', 'OVERHEAD', 'OTHER'];

class VoItemDto {
  @IsIn(CATS) category!: CostCategory;
  @IsString() description!: string;
  /** Perubahan budget biaya, boleh negatif */
  @IsNumberString() amount!: string;
}
class VoDto {
  @IsString() title!: string;
  @IsOptional() @IsString() description?: string;
  /** Perubahan nilai kontrak, boleh negatif (pekerjaan kurang) */
  @IsNumberString() contractChange!: string;
  @ValidateNested({ each: true }) @Type(() => VoItemDto) items!: VoItemDto[];
}

/**
 * Variation order (PRD §5.4, §5.6): perubahan nilai kontrak dan budget wajib melalui approval.
 * Saat disetujui: nilai kontrak proyek diperbarui dan budget baseline baru (revisi +1) dibuat —
 * baseline lama tetap tersimpan sebagai histori.
 */
@Injectable()
export class VariationOrdersService implements OnModuleInit {
  constructor(private prisma: PrismaService, private seq: SequenceService, private audit: AuditService, private approvals: ApprovalsService) {}

  onModuleInit() {
    this.approvals.registerHandler(
      'VO',
      async (tx, tenantId, id, status) => {
        if (status !== 'APPROVED') {
          await tx.variationOrder.update({ where: { id }, data: { status } });
          return;
        }
        const vo = await tx.variationOrder.findUniqueOrThrow({ where: { id }, include: { items: true } });
        const project = await tx.project.findUniqueOrThrow({ where: { id: vo.projectId } });
        const base = await tx.budget.findFirst({
          where: { tenantId, projectId: vo.projectId, isBaseline: true },
          orderBy: { revision: 'desc' },
          include: { items: true },
        });
        const budget = await tx.budget.create({
          data: {
            tenantId, projectId: vo.projectId, isBaseline: true, approvedAt: new Date(),
            name: `Revisi ${(base?.revision ?? 0) + 1} — ${vo.number}`,
            revision: (base?.revision ?? 0) + 1,
            items: {
              create: [
                ...(base?.items ?? []).map(({ id: _id, budgetId: _b, ...i }) => i),
                ...vo.items.map((i) => ({ tenantId, category: i.category, description: `${vo.number}: ${i.description}`, quantity: D(1), unitRate: i.amount, amount: i.amount })),
              ],
            },
          },
        });
        await tx.project.update({ where: { id: project.id }, data: { contractValue: project.contractValue.plus(vo.contractChange) } });
        await tx.variationOrder.update({ where: { id }, data: { status: 'APPROVED', approvedAt: new Date(), budgetId: budget.id } });
      },
      async (tx, id) => {
        const vo = await tx.variationOrder.findUnique({ where: { id }, select: { projectId: true } });
        return vo ? `/projects/${vo.projectId}?tab=vo` : '/projects';
      },
    );
  }

  async list(u: AuthUser, projectId: string) {
    notFound(await this.prisma.project.findFirst({ where: { id: projectId, tenantId: u.tenantId } }), 'Proyek');
    const rows = await this.prisma.variationOrder.findMany({ where: { tenantId: u.tenantId, projectId }, include: { items: true }, orderBy: { createdAt: 'desc' } });
    const budgets = await this.prisma.budget.findMany({ where: { tenantId: u.tenantId, projectId, isBaseline: true }, orderBy: { revision: 'asc' }, include: { items: { select: { amount: true } } } });
    return {
      items: rows.map((r) => ({ ...r, budgetChange: sumD(r.items.map((i) => i.amount)) })),
      budgetHistory: budgets.map((b) => ({ id: b.id, name: b.name, revision: b.revision, approvedAt: b.approvedAt, total: sumD(b.items.map((i) => i.amount)) })),
    };
  }

  async create(u: AuthUser, projectId: string, dto: VoDto) {
    return this.prisma.$transaction(async (tx) => {
      const p = notFound(await tx.project.findFirst({ where: { id: projectId, tenantId: u.tenantId } }), 'Proyek');
      if (!['ACTIVE', 'ON_HOLD', 'COMPLETION'].includes(p.status)) throw new BusinessError('VO hanya untuk proyek yang sedang berjalan');
      const vo = await tx.variationOrder.create({
        data: {
          tenantId: u.tenantId, projectId, number: await this.seq.next(tx, u.tenantId, 'VO'), title: dto.title, description: dto.description,
          contractChange: D(dto.contractChange), requestedBy: u.userId,
          items: { create: dto.items.map((i) => ({ tenantId: u.tenantId, category: i.category, description: i.description, amount: D(i.amount) })) },
        },
      });
      await this.audit.log(u, 'CREATE', 'VariationOrder', vo.id, { number: vo.number, contractChange: dto.contractChange }, tx);
      return vo;
    });
  }

  async update(u: AuthUser, id: string, dto: VoDto) {
    return this.prisma.$transaction(async (tx) => {
      const vo = notFound(await tx.variationOrder.findFirst({ where: { id, tenantId: u.tenantId } }), 'VO');
      if (!['DRAFT', 'REVISION'].includes(vo.status)) throw new BusinessError('VO hanya bisa diubah saat Draft/Revisi');
      await tx.variationOrderItem.deleteMany({ where: { voId: id } });
      const res = await tx.variationOrder.update({
        where: { id },
        data: {
          title: dto.title, description: dto.description, contractChange: D(dto.contractChange),
          items: { create: dto.items.map((i) => ({ tenantId: u.tenantId, category: i.category, description: i.description, amount: D(i.amount) })) },
        },
      });
      await this.audit.log(u, 'UPDATE', 'VariationOrder', id, { contractChange: dto.contractChange }, tx);
      return res;
    });
  }

  async submit(u: AuthUser, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const vo = notFound(await tx.variationOrder.findFirst({ where: { id, tenantId: u.tenantId }, include: { items: true, project: true } }), 'VO');
      if (!['DRAFT', 'REVISION'].includes(vo.status)) throw new BusinessError('VO sudah diajukan');
      await tx.variationOrder.update({ where: { id }, data: { status: 'IN_APPROVAL' } });
      // Nominal approval = dampak terbesar antara perubahan kontrak dan perubahan budget
      const budgetChange = sumD(vo.items.map((i) => i.amount)).abs();
      const amount = vo.contractChange.abs().gt(budgetChange) ? vo.contractChange.abs() : budgetChange;
      const st = await this.approvals.submit(tx, u, { entityType: 'VO', entityId: id, entityNumber: vo.number, title: `VO ${vo.number} — ${vo.project.name}`, amount: amount.toString() });
      await this.audit.log(u, 'SUBMIT', 'VariationOrder', id, { result: st }, tx);
      return { status: st };
    });
  }
}

@ApiTags('Variation Orders')
@Controller()
export class VariationOrdersController {
  constructor(private svc: VariationOrdersService) {}

  @Get('projects/:id/variation-orders') @Perm('project:read', 'cost:read')
  list(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.list(u, id); }
  @Post('projects/:id/variation-orders') @Perm('project:write')
  create(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: VoDto) { return this.svc.create(u, id, dto); }
  @Put('variation-orders/:id') @Perm('project:write')
  update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: VoDto) { return this.svc.update(u, id, dto); }
  @Post('variation-orders/:id/submit') @Perm('project:write')
  submit(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.submit(u, id); }
}

@Module({ imports: [ApprovalsModule], controllers: [VariationOrdersController], providers: [VariationOrdersService] })
export class VariationOrdersModule {}
