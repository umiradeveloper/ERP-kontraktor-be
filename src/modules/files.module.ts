import {
  Body, Controller, Delete, ForbiddenException, Get, Injectable, Module, Param, Post, Query, Res, UploadedFiles, UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { randomUUID } from 'crypto';
import { createReadStream, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { extname, join, resolve } from 'path';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser, CurrentUser, hasPerm } from '../common/auth';
import { AuditService, notFound } from '../common/common.service';
import { BusinessError } from '../common/http';

/** Dokumen yang boleh diberi lampiran, beserta permission baca/tulisnya */
const ENTITIES: Record<string, { model: string; read: string[]; write: string[] }> = {
  Project: { model: 'project', read: ['project:read'], write: ['project:write'] },
  DailyReport: { model: 'dailyReport', read: ['project:read'], write: ['project:write'] },
  Tender: { model: 'tender', read: ['tender:read'], write: ['tender:write'] },
  PurchaseRequest: { model: 'purchaseRequest', read: ['procurement:read', 'project:read'], write: ['procurement:write', 'project:write'] },
  PurchaseOrder: { model: 'purchaseOrder', read: ['procurement:read'], write: ['procurement:write'] },
  GoodsReceipt: { model: 'goodsReceipt', read: ['procurement:read'], write: ['procurement:write', 'warehouse:write'] },
  Rfq: { model: 'rfq', read: ['procurement:read'], write: ['procurement:write'] },
  SupplierInvoice: { model: 'supplierInvoice', read: ['finance:read'], write: ['finance:write'] },
  CustomerInvoice: { model: 'customerInvoice', read: ['finance:read'], write: ['finance:write'] },
  VariationOrder: { model: 'variationOrder', read: ['project:read'], write: ['project:write'] },
  Asset: { model: 'asset', read: ['asset:read'], write: ['asset:write'] },
};

const ALLOWED_MIME = [
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword',
  'application/zip', 'text/csv', 'application/acad', 'image/vnd.dwg', 'application/octet-stream',
];
const MAX_SIZE = 15 * 1024 * 1024;

class UploadDto {
  @IsIn(Object.keys(ENTITIES)) entityType!: string;
  @IsString() entityId!: string;
  @IsOptional() @IsString() category?: string;
}

/**
 * Penyimpanan file. Driver lokal (folder UPLOAD_DIR) untuk MVP; key dibuat tenant-scoped
 * ("<tenantId>/<uuid>.<ext>") sehingga mudah dipindah ke S3-compatible storage.
 */
@Injectable()
export class StorageService {
  private root = resolve(process.env.UPLOAD_DIR ?? './uploads');

  put(tenantId: string, ext: string, data: Buffer) {
    const dir = join(this.root, tenantId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const key = `${tenantId}/${randomUUID()}${ext}`;
    writeFileSync(join(this.root, key), data);
    return key;
  }
  path(key: string) {
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root)) throw new ForbiddenException(); // cegah path traversal
    return p;
  }
  remove(key: string) {
    try { unlinkSync(this.path(key)); } catch { /* sudah tidak ada */ }
  }
}

@Injectable()
export class FilesService {
  constructor(private prisma: PrismaService, private storage: StorageService, private audit: AuditService) {}

  private async assertEntity(u: AuthUser, entityType: string, entityId: string, mode: 'read' | 'write') {
    const e = ENTITIES[entityType];
    if (!e) throw new BusinessError('Jenis dokumen tidak didukung');
    const perms = mode === 'read' ? [...e.read, ...e.write] : e.write;
    if (!perms.some((p) => hasPerm(u, p))) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Anda tidak memiliki akses ke lampiran ini' });
    const row = await (this.prisma as any)[e.model].findFirst({ where: { id: entityId, tenantId: u.tenantId }, select: { id: true } });
    notFound(row, 'Dokumen');
  }

  async list(u: AuthUser, entityType: string, entityId: string) {
    await this.assertEntity(u, entityType, entityId, 'read');
    const rows = await this.prisma.fileObject.findMany({ where: { tenantId: u.tenantId, entityType, entityId }, orderBy: { createdAt: 'desc' } });
    const users = await this.prisma.user.findMany({ where: { tenantId: u.tenantId, id: { in: rows.map((r) => r.uploadedBy) } }, select: { id: true, name: true } });
    const names = new Map(users.map((x) => [x.id, x.name]));
    return rows.map(({ storageKey, ...r }) => ({ ...r, uploadedByName: names.get(r.uploadedBy) }));
  }

  async upload(u: AuthUser, dto: UploadDto, files: Express.Multer.File[]) {
    if (!files?.length) throw new BusinessError('Pilih minimal satu file');
    await this.assertEntity(u, dto.entityType, dto.entityId, 'write');
    const out = [];
    for (const f of files) {
      if (!ALLOWED_MIME.includes(f.mimetype)) throw new BusinessError(`Tipe file ${f.originalname} tidak diizinkan`);
      const key = this.storage.put(u.tenantId, extname(f.originalname).toLowerCase().slice(0, 10), f.buffer);
      const row = await this.prisma.fileObject.create({
        data: {
          tenantId: u.tenantId, entityType: dto.entityType, entityId: dto.entityId, category: dto.category,
          fileName: f.originalname.slice(0, 180), mimeType: f.mimetype, size: f.size, storageKey: key, uploadedBy: u.userId,
        },
      });
      out.push({ id: row.id, fileName: row.fileName });
      await this.audit.log(u, 'UPLOAD', dto.entityType, dto.entityId, { fileId: row.id, fileName: row.fileName });
    }
    return out;
  }

  async download(u: AuthUser, id: string) {
    const f = notFound(await this.prisma.fileObject.findFirst({ where: { id, tenantId: u.tenantId } }), 'File');
    await this.assertEntity(u, f.entityType, f.entityId, 'read');
    return { file: f, path: this.storage.path(f.storageKey) };
  }

  async remove(u: AuthUser, id: string) {
    const f = notFound(await this.prisma.fileObject.findFirst({ where: { id, tenantId: u.tenantId } }), 'File');
    await this.assertEntity(u, f.entityType, f.entityId, 'write');
    await this.prisma.fileObject.delete({ where: { id } });
    this.storage.remove(f.storageKey);
    await this.audit.log(u, 'DELETE_FILE', f.entityType, f.entityId, { fileName: f.fileName });
    return { ok: true };
  }
}

@ApiTags('Files')
@Controller('files')
export class FilesController {
  constructor(private svc: FilesService) {}

  @Get()
  list(@CurrentUser() u: AuthUser, @Query('entityType') t: string, @Query('entityId') id: string) {
    return this.svc.list(u, t, id);
  }

  @Post()
  @UseInterceptors(FilesInterceptor('files', 10, { limits: { fileSize: MAX_SIZE } }))
  upload(@CurrentUser() u: AuthUser, @Body() dto: UploadDto, @UploadedFiles() files: Express.Multer.File[]) {
    return this.svc.upload(u, dto, files);
  }

  @Get(':id/download')
  async download(@CurrentUser() u: AuthUser, @Param('id') id: string, @Query('inline') inline: string, @Res() res: Response) {
    const { file, path } = await this.svc.download(u, id);
    if (!existsSync(path)) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'File fisik tidak ditemukan' } });
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
    res.setHeader('Cache-Control', 'private, max-age=300');
    createReadStream(path).pipe(res);
  }

  @Delete(':id')
  remove(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.remove(u, id);
  }
}

@Module({ controllers: [FilesController], providers: [FilesService, StorageService] })
export class FilesModule {}
