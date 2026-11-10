import { Body, Controller, Get, Injectable, Module, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsDateString, IsIn, IsInt, IsNumberString, IsOptional, IsString, Matches, Min } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser, CurrentUser, Perm } from '../common/auth';
import { AuditService, D, notFound } from '../common/common.service';
import { BusinessError } from '../common/http';

class AssetDto {
  @Matches(/^[A-Z0-9-]{2,30}$/) assetTag!: string;
  @IsString() name!: string;
  @IsString() category!: string;
  @IsOptional() @IsString() serialNumber?: string;
  @IsOptional() @IsIn(['OWNED', 'RENTAL']) ownership?: string;
  @IsOptional() @IsNumberString() acquisitionCost?: string;
  @IsOptional() @IsDateString() acquisitionDate?: string;
  @IsOptional() @IsInt() @Min(1) usefulLifeMonths?: number;
  @IsOptional() @IsString() location?: string;
  @IsOptional() @IsString() custodian?: string;
}
class AssignDto {
  @IsString() projectId!: string;
  @IsOptional() @IsString() custodian?: string;
  @IsOptional() @IsString() notes?: string;
}
class ReturnDto {
  @IsOptional() @IsString() condition?: string;
  @IsOptional() @IsString() notes?: string;
}
class MaintenanceDto {
  @IsIn(['PREVENTIVE', 'CORRECTIVE', 'INSPECTION']) type!: string;
  @IsString() description!: string;
  @IsDateString() scheduledAt!: string;
  @IsOptional() @IsNumberString() cost?: string;
}

@Injectable()
export class AssetsService {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  async list(u: AuthUser) {
    const assets = await this.prisma.asset.findMany({ where: { tenantId: u.tenantId }, orderBy: { assetTag: 'asc' } });
    const projects = await this.prisma.project.findMany({ where: { tenantId: u.tenantId }, select: { id: true, code: true, name: true } });
    const pm = new Map(projects.map((p) => [p.id, p]));
    return assets.map((a) => {
      const months = a.acquisitionDate ? Math.max(0, Math.floor((Date.now() - a.acquisitionDate.getTime()) / (30.44 * 86400_000))) : 0;
      const dep = a.acquisitionCost.mul(Math.min(months, a.usefulLifeMonths)).div(a.usefulLifeMonths);
      return { ...a, project: a.projectId ? pm.get(a.projectId) : null, bookValue: a.acquisitionCost.minus(dep).toDecimalPlaces(2) };
    });
  }

  async get(u: AuthUser, id: string) {
    const a = notFound(
      await this.prisma.asset.findFirst({
        where: { id, tenantId: u.tenantId },
        include: { movements: { orderBy: { movedAt: 'desc' } }, maintenances: { orderBy: { scheduledAt: 'desc' } } },
      }),
      'Aset',
    );
    const projects = await this.prisma.project.findMany({ where: { tenantId: u.tenantId }, select: { id: true, code: true, name: true } });
    const pm = new Map(projects.map((p) => [p.id, `${p.code} · ${p.name}`]));
    return {
      ...a,
      projectName: a.projectId ? pm.get(a.projectId) : null,
      movements: a.movements.map((m) => ({ ...m, fromName: m.fromProjectId ? pm.get(m.fromProjectId) : 'Gudang', toName: m.toProjectId ? pm.get(m.toProjectId) : 'Gudang' })),
    };
  }

  async create(u: AuthUser, dto: AssetDto) {
    const a = await this.prisma.asset.create({
      data: {
        tenantId: u.tenantId, assetTag: dto.assetTag, name: dto.name, category: dto.category, serialNumber: dto.serialNumber,
        ownership: dto.ownership ?? 'OWNED', acquisitionCost: D(dto.acquisitionCost ?? 0),
        acquisitionDate: dto.acquisitionDate ? new Date(dto.acquisitionDate) : null, usefulLifeMonths: dto.usefulLifeMonths ?? 60,
        location: dto.location ?? 'Gudang Pusat', custodian: dto.custodian,
      },
    });
    await this.audit.log(u, 'CREATE', 'Asset', a.id, { tag: a.assetTag });
    return a;
  }

  /** Alokasi / transfer antarproyek dengan histori (PRD §5.11) */
  async assign(u: AuthUser, id: string, dto: AssignDto) {
    return this.prisma.$transaction(async (tx) => {
      const a = notFound(await tx.asset.findFirst({ where: { id, tenantId: u.tenantId } }), 'Aset');
      if (!['AVAILABLE', 'ASSIGNED'].includes(a.status)) throw new BusinessError('Aset sedang maintenance atau sudah tidak aktif');
      const p = notFound(await tx.project.findFirst({ where: { id: dto.projectId, tenantId: u.tenantId } }), 'Proyek');
      if (['CLOSED', 'CANCELLED'].includes(p.status)) throw new BusinessError('Proyek sudah ditutup');
      if (a.projectId === p.id) throw new BusinessError('Aset sudah berada di proyek ini');
      const type = a.projectId ? 'TRANSFER' : 'ASSIGN';
      await tx.assetMovement.create({ data: { tenantId: u.tenantId, assetId: id, type, fromProjectId: a.projectId, toProjectId: p.id, notes: dto.notes, createdBy: u.userId } });
      const res = await tx.asset.update({ where: { id }, data: { status: 'ASSIGNED', projectId: p.id, location: p.location ?? p.name, custodian: dto.custodian ?? a.custodian } });
      await this.audit.log(u, type, 'Asset', id, { to: p.code }, tx);
      return res;
    });
  }

  async returnAsset(u: AuthUser, id: string, dto: ReturnDto) {
    return this.prisma.$transaction(async (tx) => {
      const a = notFound(await tx.asset.findFirst({ where: { id, tenantId: u.tenantId } }), 'Aset');
      if (a.status !== 'ASSIGNED') throw new BusinessError('Aset tidak sedang dialokasikan');
      await tx.assetMovement.create({ data: { tenantId: u.tenantId, assetId: id, type: 'RETURN', fromProjectId: a.projectId, notes: dto.notes, createdBy: u.userId } });
      const res = await tx.asset.update({ where: { id }, data: { status: 'AVAILABLE', projectId: null, location: 'Gudang Pusat', condition: dto.condition ?? a.condition } });
      await this.audit.log(u, 'RETURN', 'Asset', id, {}, tx);
      return res;
    });
  }

  async maintenance(u: AuthUser, id: string, dto: MaintenanceDto) {
    return this.prisma.$transaction(async (tx) => {
      const a = notFound(await tx.asset.findFirst({ where: { id, tenantId: u.tenantId } }), 'Aset');
      if (['RETIRED', 'DISPOSED'].includes(a.status)) throw new BusinessError('Aset sudah tidak aktif');
      const m = await tx.assetMaintenance.create({
        data: { tenantId: u.tenantId, assetId: id, type: dto.type, description: dto.description, scheduledAt: new Date(dto.scheduledAt), cost: D(dto.cost ?? 0) },
      });
      if (new Date(dto.scheduledAt) <= new Date()) await tx.asset.update({ where: { id }, data: { status: 'IN_MAINTENANCE' } });
      await this.audit.log(u, 'MAINTENANCE', 'Asset', id, { maintenanceId: m.id }, tx);
      return m;
    });
  }

  async completeMaintenance(u: AuthUser, id: string, mid: string) {
    return this.prisma.$transaction(async (tx) => {
      const a = notFound(await tx.asset.findFirst({ where: { id, tenantId: u.tenantId } }), 'Aset');
      const m = notFound(await tx.assetMaintenance.findFirst({ where: { id: mid, assetId: id, tenantId: u.tenantId } }), 'Maintenance');
      if (m.completedAt) throw new BusinessError('Maintenance sudah selesai');
      await tx.assetMaintenance.update({ where: { id: mid }, data: { completedAt: new Date() } });
      if (a.status === 'IN_MAINTENANCE') await tx.asset.update({ where: { id }, data: { status: a.projectId ? 'ASSIGNED' : 'AVAILABLE' } });
      await this.audit.log(u, 'MAINTENANCE_DONE', 'Asset', id, { maintenanceId: mid }, tx);
      return { ok: true };
    });
  }
}

@ApiTags('Assets')
@Controller('assets')
export class AssetsController {
  constructor(private svc: AssetsService) {}

  @Get() @Perm('asset:read')
  list(@CurrentUser() u: AuthUser) { return this.svc.list(u); }
  @Get(':id') @Perm('asset:read')
  get(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.get(u, id); }
  @Post() @Perm('asset:write')
  create(@CurrentUser() u: AuthUser, @Body() dto: AssetDto) { return this.svc.create(u, dto); }
  @Post(':id/assign') @Perm('asset:write')
  assign(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: AssignDto) { return this.svc.assign(u, id, dto); }
  @Post(':id/return') @Perm('asset:write')
  ret(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ReturnDto) { return this.svc.returnAsset(u, id, dto); }
  @Post(':id/maintenance') @Perm('asset:write')
  maint(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: MaintenanceDto) { return this.svc.maintenance(u, id, dto); }
  @Post(':id/maintenance/:mid/complete') @Perm('asset:write')
  done(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('mid') mid: string) { return this.svc.completeMaintenance(u, id, mid); }
}

@Module({ controllers: [AssetsController], providers: [AssetsService] })
export class AssetsModule {}
