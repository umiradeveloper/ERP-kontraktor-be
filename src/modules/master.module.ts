import { Body, Controller, Delete, Get, Injectable, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsBoolean, IsEmail, IsInt, IsOptional, IsString, Matches, Min, MinLength } from 'class-validator';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser, CurrentUser, Perm } from '../common/auth';
import { AuditService, notFound } from '../common/common.service';
import { BusinessError } from '../common/http';

class PartyDto {
  @Matches(/^[A-Z0-9-]{2,20}$/, { message: 'Kode hanya huruf besar, angka dan tanda minus (2-20)' }) code!: string;
  @IsString() name!: string;
  @IsOptional() @IsString() npwp?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() address?: string;
}
class SupplierDto {
  @Matches(/^[A-Z0-9-]{2,20}$/, { message: 'Kode hanya huruf besar, angka dan tanda minus (2-20)' }) code!: string;
  @IsString() name!: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() taxNumber?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsInt() @Min(0) paymentTerm?: number;
}
class UserDto {
  @IsEmail() email!: string;
  @IsString() name!: string;
  @IsOptional() @IsString() title?: string;
  @IsString() @MinLength(8) password!: string;
  @IsArray() @ArrayMinSize(1) roleIds!: string[];
}
class UserPatchDto {
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsArray() roleIds?: string[];
}

@Injectable()
export class MasterService {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  customers(u: AuthUser, search?: string) {
    return this.prisma.customer.findMany({
      where: { tenantId: u.tenantId, deletedAt: null, ...(search ? { name: { contains: search } } : {}) },
      orderBy: { name: 'asc' },
    });
  }
  async createCustomer(u: AuthUser, dto: PartyDto) {
    const c = await this.prisma.customer.create({ data: { tenantId: u.tenantId, ...dto } });
    await this.audit.log(u, 'CREATE', 'Customer', c.id, { code: c.code });
    return c;
  }
  async updateCustomer(u: AuthUser, id: string, dto: Partial<PartyDto>) {
    notFound(await this.prisma.customer.findFirst({ where: { id, tenantId: u.tenantId } }), 'Customer');
    const c = await this.prisma.customer.update({ where: { id }, data: dto });
    await this.audit.log(u, 'UPDATE', 'Customer', id, dto as any);
    return c;
  }
  async deleteCustomer(u: AuthUser, id: string) {
    notFound(await this.prisma.customer.findFirst({ where: { id, tenantId: u.tenantId } }), 'Customer');
    await this.prisma.customer.update({ where: { id }, data: { deletedAt: new Date() } }); // soft delete
    await this.audit.log(u, 'DELETE', 'Customer', id);
    return { ok: true };
  }

  suppliers(u: AuthUser, search?: string) {
    return this.prisma.supplier.findMany({
      where: { tenantId: u.tenantId, deletedAt: null, ...(search ? { name: { contains: search } } : {}) },
      orderBy: { name: 'asc' },
    });
  }
  async createSupplier(u: AuthUser, dto: SupplierDto) {
    const s = await this.prisma.supplier.create({ data: { tenantId: u.tenantId, ...dto } });
    await this.audit.log(u, 'CREATE', 'Supplier', s.id, { code: s.code });
    return s;
  }
  async updateSupplier(u: AuthUser, id: string, dto: Partial<SupplierDto>) {
    notFound(await this.prisma.supplier.findFirst({ where: { id, tenantId: u.tenantId } }), 'Supplier');
    const s = await this.prisma.supplier.update({ where: { id }, data: dto });
    await this.audit.log(u, 'UPDATE', 'Supplier', id, dto as any);
    return s;
  }
  async deleteSupplier(u: AuthUser, id: string) {
    notFound(await this.prisma.supplier.findFirst({ where: { id, tenantId: u.tenantId } }), 'Supplier');
    await this.prisma.supplier.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.audit.log(u, 'DELETE', 'Supplier', id);
    return { ok: true };
  }

  // ── Users & roles ──
  async users(u: AuthUser) {
    const rows = await this.prisma.user.findMany({
      where: { tenantId: u.tenantId },
      include: { memberships: { include: { role: true } } },
      orderBy: { name: 'asc' },
    });
    return rows.map(({ passwordHash, memberships, ...r }) => ({
      ...r,
      roles: memberships.map((m) => ({ id: m.role.id, name: m.role.name })),
    }));
  }
  roles(u: AuthUser) {
    return this.prisma.role.findMany({ where: { tenantId: u.tenantId }, orderBy: { name: 'asc' } });
  }
  private async assertRoles(u: AuthUser, roleIds: string[]) {
    const n = await this.prisma.role.count({ where: { tenantId: u.tenantId, id: { in: roleIds } } });
    if (n !== roleIds.length) throw new BusinessError('Role tidak valid');
  }
  async createUser(u: AuthUser, dto: UserDto) {
    await this.assertRoles(u, dto.roleIds);
    const user = await this.prisma.user.create({
      data: {
        tenantId: u.tenantId,
        email: dto.email.toLowerCase(),
        name: dto.name,
        title: dto.title,
        passwordHash: await bcrypt.hash(dto.password, 10),
        memberships: { create: dto.roleIds.map((roleId) => ({ tenantId: u.tenantId, roleId })) },
      },
    });
    await this.audit.log(u, 'CREATE', 'User', user.id, { email: user.email, roleIds: dto.roleIds });
    return { id: user.id };
  }
  async updateUser(u: AuthUser, id: string, dto: UserPatchDto) {
    notFound(await this.prisma.user.findFirst({ where: { id, tenantId: u.tenantId } }), 'User');
    if (id === u.userId && dto.isActive === false) throw new BusinessError('Tidak dapat menonaktifkan akun sendiri');
    await this.prisma.$transaction(async (tx) => {
      if (dto.isActive !== undefined) {
        await tx.user.update({ where: { id }, data: { isActive: dto.isActive } });
        if (!dto.isActive) await tx.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      }
      if (dto.roleIds) {
        await this.assertRoles(u, dto.roleIds);
        await tx.membership.deleteMany({ where: { tenantId: u.tenantId, userId: id, projectId: null } });
        await tx.membership.createMany({ data: dto.roleIds.map((roleId) => ({ tenantId: u.tenantId, userId: id, roleId })) });
      }
      await this.audit.log(u, 'UPDATE', 'User', id, dto as any, tx);
    });
    return { ok: true };
  }

  async auditLogs(u: AuthUser, q: { entityType?: string; search?: string }) {
    return this.prisma.auditLog.findMany({
      where: {
        tenantId: u.tenantId,
        ...(q.entityType ? { entityType: q.entityType } : {}),
        ...(q.search ? { OR: [{ action: { contains: q.search } }, { actorName: { contains: q.search } }] } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
  }
}

@ApiTags('Master Data & Admin')
@Controller()
export class MasterController {
  constructor(private svc: MasterService) {}

  @Get('customers') @Perm('master:read', 'tender:read', 'project:read')
  customers(@CurrentUser() u: AuthUser, @Query('search') s?: string) { return this.svc.customers(u, s); }
  @Post('customers') @Perm('master:write')
  createCustomer(@CurrentUser() u: AuthUser, @Body() dto: PartyDto) { return this.svc.createCustomer(u, dto); }
  @Patch('customers/:id') @Perm('master:write')
  updateCustomer(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: PartyDto) { return this.svc.updateCustomer(u, id, dto); }
  @Delete('customers/:id') @Perm('master:write')
  deleteCustomer(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.deleteCustomer(u, id); }

  @Get('suppliers') @Perm('master:read', 'procurement:read')
  suppliers(@CurrentUser() u: AuthUser, @Query('search') s?: string) { return this.svc.suppliers(u, s); }
  @Post('suppliers') @Perm('master:write', 'procurement:write')
  createSupplier(@CurrentUser() u: AuthUser, @Body() dto: SupplierDto) { return this.svc.createSupplier(u, dto); }
  @Patch('suppliers/:id') @Perm('master:write', 'procurement:write')
  updateSupplier(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: SupplierDto) { return this.svc.updateSupplier(u, id, dto); }
  @Delete('suppliers/:id') @Perm('master:write')
  deleteSupplier(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.deleteSupplier(u, id); }

  @Get('users') @Perm('admin:read')
  users(@CurrentUser() u: AuthUser) { return this.svc.users(u); }
  @Post('users') @Perm('admin:write')
  createUser(@CurrentUser() u: AuthUser, @Body() dto: UserDto) { return this.svc.createUser(u, dto); }
  @Patch('users/:id') @Perm('admin:write')
  updateUser(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: UserPatchDto) { return this.svc.updateUser(u, id, dto); }
  @Get('roles') @Perm('admin:read')
  roles(@CurrentUser() u: AuthUser) { return this.svc.roles(u); }

  @Get('audit-logs') @Perm('audit:read', 'admin:read')
  audit(@CurrentUser() u: AuthUser, @Query('entityType') entityType?: string, @Query('search') search?: string) {
    return this.svc.auditLogs(u, { entityType, search });
  }
}

@Module({ controllers: [MasterController], providers: [MasterService] })
export class MasterModule {}
