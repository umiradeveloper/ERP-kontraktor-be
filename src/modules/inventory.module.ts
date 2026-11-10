import { Body, Controller, Get, Injectable, Module, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsDateString, IsIn, IsNumberString, IsOptional, IsString, Matches, ValidateNested } from 'class-validator';
import { CostCategory, Prisma } from '@prisma/client';
import { PrismaService, Tx } from '../prisma/prisma.service';
import { AuthUser, CurrentUser, Perm } from '../common/auth';
import { AuditService, D, notFound, round2, SequenceService, ZERO } from '../common/common.service';
import { NotifyService } from '../common/notify.service';
import { BusinessError } from '../common/http';

const CATS = ['MATERIAL', 'LABOR', 'EQUIPMENT', 'SUBCONTRACTOR', 'OVERHEAD', 'OTHER'];

class WarehouseDto {
  @Matches(/^[A-Z0-9-]{2,20}$/) code!: string;
  @IsString() name!: string;
  @IsOptional() @IsString() projectId?: string;
  @IsOptional() @IsString() location?: string;
}
class ItemDto {
  @Matches(/^[A-Z0-9-]{2,30}$/) code!: string;
  @IsString() name!: string;
  @IsOptional() @IsString() unit?: string;
  @IsIn(CATS) category!: CostCategory;
  @IsOptional() @IsNumberString() minStock?: string;
}
class MoveLineDto {
  @IsString() itemId!: string;
  /** ISSUE/TRANSFER: qty keluar. OPNAME: qty hasil hitung fisik */
  @IsNumberString() quantity!: string;
  @IsOptional() @IsString() notes?: string;
}
class MovementDto {
  @IsIn(['ISSUE', 'TRANSFER', 'OPNAME']) type!: 'ISSUE' | 'TRANSFER' | 'OPNAME';
  @IsString() warehouseId!: string;
  @IsOptional() @IsString() toWarehouseId?: string;
  @IsOptional() @IsString() projectId?: string;
  @IsOptional() @IsString() costCode?: string;
  @IsOptional() @IsDateString() movedAt?: string;
  @IsOptional() @IsString() notes?: string;
  @ValidateNested({ each: true }) @Type(() => MoveLineDto) @ArrayMinSize(1) lines!: MoveLineDto[];
}

export interface ReceiveLine {
  name: string;
  unit?: string | null;
  category: CostCategory;
  quantity: Prisma.Decimal;
  unitCost: Prisma.Decimal;
}

/**
 * Gudang & stok (PRD §5.12). Nilai persediaan memakai moving average.
 * Catatan kebijakan MVP: pengakuan biaya proyek tetap dari invoice supplier (lihat cost control);
 * mutasi stok mencatat kuantitas & nilai untuk kontrol fisik dan pemakaian per WBS/cost code.
 */
@Injectable()
export class InventoryService {
  constructor(private prisma: PrismaService, private seq: SequenceService, private audit: AuditService, private notify: NotifyService) {}

  warehouses(u: AuthUser) {
    return this.prisma.warehouse.findMany({ where: { tenantId: u.tenantId }, orderBy: { code: 'asc' } });
  }
  async createWarehouse(u: AuthUser, dto: WarehouseDto) {
    if (dto.projectId) notFound(await this.prisma.project.findFirst({ where: { id: dto.projectId, tenantId: u.tenantId } }), 'Proyek');
    const w = await this.prisma.warehouse.create({ data: { tenantId: u.tenantId, ...dto } });
    await this.audit.log(u, 'CREATE', 'Warehouse', w.id, { code: w.code });
    return w;
  }
  items(u: AuthUser) {
    return this.prisma.inventoryItem.findMany({ where: { tenantId: u.tenantId }, orderBy: { name: 'asc' } });
  }
  async createItem(u: AuthUser, dto: ItemDto) {
    const i = await this.prisma.inventoryItem.create({ data: { tenantId: u.tenantId, ...dto, minStock: D(dto.minStock ?? 0) } });
    await this.audit.log(u, 'CREATE', 'InventoryItem', i.id, { code: i.code });
    return i;
  }

  async stock(u: AuthUser, warehouseId?: string) {
    const rows = await this.prisma.stockBalance.findMany({
      where: { tenantId: u.tenantId, ...(warehouseId ? { warehouseId } : {}) },
      include: { item: true, warehouse: { select: { code: true, name: true } } },
      orderBy: [{ warehouse: { code: 'asc' } }, { item: { name: 'asc' } }],
    });
    return rows.map((r) => ({ ...r, value: round2(r.quantity.mul(r.avgCost)), low: r.item.minStock.gt(0) && r.quantity.lt(r.item.minStock) }));
  }

  async movements(u: AuthUser, q: { warehouseId?: string; itemId?: string }) {
    const rows = await this.prisma.stockMovement.findMany({
      where: { tenantId: u.tenantId, ...(q.warehouseId ? { warehouseId: q.warehouseId } : {}), ...(q.itemId ? { itemId: q.itemId } : {}) },
      include: { item: { select: { code: true, name: true, unit: true } }, warehouse: { select: { code: true } } },
      orderBy: { movedAt: 'desc' },
      take: 300,
    });
    const users = await this.prisma.user.findMany({ where: { tenantId: u.tenantId }, select: { id: true, name: true } });
    const um = new Map(users.map((x) => [x.id, x.name]));
    return rows.map((r) => ({ ...r, createdByName: um.get(r.createdBy) }));
  }

  private async findOrCreateItem(tx: Tx, tenantId: string, l: ReceiveLine) {
    const name = l.name.trim().slice(0, 180);
    const existing = await tx.inventoryItem.findUnique({ where: { tenantId_name: { tenantId, name } } });
    if (existing) return existing;
    const n = await tx.inventoryItem.count({ where: { tenantId } });
    return tx.inventoryItem.create({ data: { tenantId, code: `ITM-${String(n + 1).padStart(4, '0')}`, name, unit: l.unit, category: l.category } });
  }

  private async move(tx: Tx, u: AuthUser, p: { number: string; warehouseId: string; itemId: string; type: string; qty: Prisma.Decimal; unitCost?: Prisma.Decimal; refType?: string; refId?: string; projectId?: string | null; costCode?: string; notes?: string; movedAt?: Date }) {
    const bal = await tx.stockBalance.findUnique({ where: { warehouseId_itemId: { warehouseId: p.warehouseId, itemId: p.itemId } } });
    const q0 = bal?.quantity ?? ZERO;
    const avg0 = bal?.avgCost ?? ZERO;
    const q1 = q0.plus(p.qty);
    if (q1.lt(0)) {
      const item = await tx.inventoryItem.findUnique({ where: { id: p.itemId } });
      throw new BusinessError(`Stok ${item?.name} tidak cukup (tersedia ${q0.toString()})`, 'INSUFFICIENT_STOCK');
    }
    // Moving average hanya berubah saat barang masuk dengan harga
    let avg1 = avg0;
    if (p.qty.gt(0) && p.unitCost && q1.gt(0)) avg1 = round2(q0.mul(avg0).plus(p.qty.mul(p.unitCost)).div(q1));
    await tx.stockBalance.upsert({
      where: { warehouseId_itemId: { warehouseId: p.warehouseId, itemId: p.itemId } },
      create: { tenantId: u.tenantId, warehouseId: p.warehouseId, itemId: p.itemId, quantity: q1, avgCost: avg1 },
      update: { quantity: q1, avgCost: avg1 },
    });
    await tx.stockMovement.create({
      data: {
        tenantId: u.tenantId, number: p.number, warehouseId: p.warehouseId, itemId: p.itemId, type: p.type, quantity: p.qty,
        unitCost: p.qty.gt(0) && p.unitCost ? p.unitCost : avg0, refType: p.refType, refId: p.refId, projectId: p.projectId ?? null,
        costCode: p.costCode, notes: p.notes, movedAt: p.movedAt ?? new Date(), createdBy: u.userId,
      },
    });
    return { q1, itemId: p.itemId, warehouseId: p.warehouseId };
  }

  /** Dipanggil dari Goods Receipt jika barang masuk ke gudang */
  async receive(tx: Tx, u: AuthUser, p: { warehouseId: string; projectId?: string; refType: string; refId: string; date: Date; lines: ReceiveLine[] }) {
    notFound(await tx.warehouse.findFirst({ where: { id: p.warehouseId, tenantId: u.tenantId, isActive: true } }), 'Gudang');
    const number = await this.seq.next(tx, u.tenantId, 'STK', p.date);
    for (const l of p.lines) {
      if (l.quantity.lte(0)) continue;
      const item = await this.findOrCreateItem(tx, u.tenantId, l);
      await this.move(tx, u, { number, warehouseId: p.warehouseId, itemId: item.id, type: 'RECEIPT', qty: l.quantity, unitCost: l.unitCost, refType: p.refType, refId: p.refId, projectId: p.projectId, movedAt: p.date });
    }
    return number;
  }

  async createMovement(u: AuthUser, dto: MovementDto) {
    const res = await this.prisma.$transaction(async (tx) => {
      const wh = notFound(await tx.warehouse.findFirst({ where: { id: dto.warehouseId, tenantId: u.tenantId } }), 'Gudang');
      if (dto.type === 'TRANSFER') {
        if (!dto.toWarehouseId || dto.toWarehouseId === wh.id) throw new BusinessError('Pilih gudang tujuan yang berbeda');
        notFound(await tx.warehouse.findFirst({ where: { id: dto.toWarehouseId, tenantId: u.tenantId } }), 'Gudang tujuan');
      }
      if (dto.type === 'ISSUE' && dto.projectId) notFound(await tx.project.findFirst({ where: { id: dto.projectId, tenantId: u.tenantId } }), 'Proyek');
      const date = dto.movedAt ? new Date(dto.movedAt) : new Date();
      const number = await this.seq.next(tx, u.tenantId, 'STK', date);
      const touched: { q1: Prisma.Decimal; itemId: string; warehouseId: string }[] = [];
      for (const l of dto.lines) {
        notFound(await tx.inventoryItem.findFirst({ where: { id: l.itemId, tenantId: u.tenantId } }), 'Item');
        const qty = D(l.quantity);
        if (dto.type === 'OPNAME') {
          if (qty.lt(0)) throw new BusinessError('Hasil hitung tidak boleh negatif');
          const bal = await tx.stockBalance.findUnique({ where: { warehouseId_itemId: { warehouseId: wh.id, itemId: l.itemId } } });
          const diff = qty.minus(bal?.quantity ?? ZERO);
          if (!diff.eq(0)) touched.push(await this.move(tx, u, { number, warehouseId: wh.id, itemId: l.itemId, type: 'ADJUSTMENT', qty: diff, unitCost: bal?.avgCost, notes: l.notes ?? `Stock opname (fisik ${qty})`, movedAt: date }));
          continue;
        }
        if (qty.lte(0)) throw new BusinessError('Kuantitas harus lebih dari 0');
        if (dto.type === 'ISSUE') {
          touched.push(await this.move(tx, u, { number, warehouseId: wh.id, itemId: l.itemId, type: 'ISSUE', qty: qty.neg(), projectId: dto.projectId ?? wh.projectId, costCode: dto.costCode, notes: l.notes ?? dto.notes, movedAt: date }));
        } else {
          const bal = await tx.stockBalance.findUnique({ where: { warehouseId_itemId: { warehouseId: wh.id, itemId: l.itemId } } });
          touched.push(await this.move(tx, u, { number, warehouseId: wh.id, itemId: l.itemId, type: 'TRANSFER_OUT', qty: qty.neg(), notes: dto.notes, movedAt: date }));
          await this.move(tx, u, { number, warehouseId: dto.toWarehouseId!, itemId: l.itemId, type: 'TRANSFER_IN', qty, unitCost: bal?.avgCost ?? ZERO, notes: dto.notes, movedAt: date });
        }
      }
      await this.audit.log(u, `STOCK_${dto.type}`, 'Warehouse', wh.id, { number, lines: dto.lines.length }, tx);
      return { number, touched };
    });
    // Peringatan stok minimum
    for (const t of res.touched) {
      const item = await this.prisma.inventoryItem.findUnique({ where: { id: t.itemId } });
      if (item && item.minStock.gt(0) && t.q1.lt(item.minStock)) {
        await this.notify.toRoles(u.tenantId, ['Procurement'], {
          type: 'LOW_STOCK', title: `Stok ${item.name} di bawah minimum`, body: `Sisa ${t.q1.toString()} ${item.unit ?? ''} (minimum ${item.minStock.toString()}).`,
          link: '/inventory', dedupeKey: `LOWSTOCK:${t.warehouseId}:${t.itemId}:${new Date().toISOString().slice(0, 10)}`,
        });
      }
    }
    return { number: res.number };
  }
}

@ApiTags('Inventory')
@Controller()
export class InventoryController {
  constructor(private svc: InventoryService) {}

  @Get('warehouses') @Perm('warehouse:read', 'procurement:read', 'asset:read')
  warehouses(@CurrentUser() u: AuthUser) { return this.svc.warehouses(u); }
  @Post('warehouses') @Perm('warehouse:write')
  createWarehouse(@CurrentUser() u: AuthUser, @Body() dto: WarehouseDto) { return this.svc.createWarehouse(u, dto); }
  @Get('inventory/items') @Perm('warehouse:read', 'procurement:read')
  items(@CurrentUser() u: AuthUser) { return this.svc.items(u); }
  @Post('inventory/items') @Perm('warehouse:write')
  createItem(@CurrentUser() u: AuthUser, @Body() dto: ItemDto) { return this.svc.createItem(u, dto); }
  @Get('inventory/stock') @Perm('warehouse:read', 'procurement:read', 'project:read')
  stock(@CurrentUser() u: AuthUser, @Query('warehouseId') w?: string) { return this.svc.stock(u, w); }
  @Get('inventory/movements') @Perm('warehouse:read', 'procurement:read')
  movements(@CurrentUser() u: AuthUser, @Query('warehouseId') w?: string, @Query('itemId') i?: string) { return this.svc.movements(u, { warehouseId: w, itemId: i }); }
  @Post('stock-movements') @Perm('warehouse:write')
  move(@CurrentUser() u: AuthUser, @Body() dto: MovementDto) { return this.svc.createMovement(u, dto); }
}

@Module({ controllers: [InventoryController], providers: [InventoryService], exports: [InventoryService] })
export class InventoryModule {}
