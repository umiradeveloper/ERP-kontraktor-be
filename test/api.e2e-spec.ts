/**
 * E2E test API terhadap database MySQL sungguhan (PRD §18–19).
 * Membuat dua tenant uji sendiri dan menghapusnya di akhir — data demo tidak disentuh.
 *
 *   cd backend && npm run test:e2e
 */
import '../src/env';
import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { deleteTenant } from '../prisma/cleanup';

process.env.DISABLE_ALERT_SCAN = 'true';
const prisma = new PrismaClient();
const PASS = 'Rahasia123!';
const run = Date.now().toString(36);

const ROLES: Record<string, string[]> = {
  Administrator: ['*'],
  'Project Manager': ['project:write', 'procurement:read', 'cost:read'],
  'Site Engineer': ['project:write', 'procurement:read'],
  Procurement: ['procurement:write', 'master:write', 'project:read', 'warehouse:write'],
  Finance: ['finance:write', 'accounting:read', 'project:read', 'procurement:read'],
  Direktur: ['project:read', 'procurement:read', 'finance:read'],
};
const COA: [string, string, any][] = [
  ['1101', 'Kas', 'ASSET'], ['1201', 'Piutang', 'ASSET'], ['1202', 'Piutang Retensi', 'ASSET'], ['1301', 'PPN Masukan', 'ASSET'],
  ['2101', 'Hutang', 'LIABILITY'], ['2201', 'PPN Keluaran', 'LIABILITY'], ['3101', 'Modal', 'EQUITY'], ['4101', 'Pendapatan', 'REVENUE'],
  ['5101', 'Material', 'EXPENSE'], ['5102', 'Upah', 'EXPENSE'], ['5103', 'Alat', 'EXPENSE'], ['5104', 'Subkon', 'EXPENSE'], ['5105', 'Overhead', 'EXPENSE'], ['5199', 'Lain', 'EXPENSE'],
];

async function createTenant(slug: string) {
  const t = await prisma.tenant.create({ data: { name: `Tenant uji ${slug}`, slug, companies: { create: { name: `PT ${slug}`, code: 'CO' } } } });
  const roleIds: Record<string, string> = {};
  for (const [name, perms] of Object.entries(ROLES)) roleIds[name] = (await prisma.role.create({ data: { tenantId: t.id, name, permissions: perms } })).id;
  const hash = await bcrypt.hash(PASS, 4);
  const users: Record<string, string> = { admin: 'Administrator', pm: 'Project Manager', site: 'Site Engineer', proc: 'Procurement', fin: 'Finance', dir: 'Direktur' };
  for (const [key, role] of Object.entries(users)) {
    await prisma.user.create({ data: { tenantId: t.id, email: `${key}@${slug}.test`, name: `${key} ${slug}`, passwordHash: hash, memberships: { create: { tenantId: t.id, roleId: roleIds[role] } } } });
  }
  await prisma.account.createMany({ data: COA.map(([code, name, accountType]) => ({ tenantId: t.id, code, name, accountType })) });
  await prisma.workflowDefinition.createMany({
    data: [
      { tenantId: t.id, entityType: 'PR', name: 'PR', version: 1, steps: [{ step: 1, roleName: 'Project Manager', minAmount: '0' }, { step: 2, roleName: 'Direktur', minAmount: '250000000' }] },
      { tenantId: t.id, entityType: 'PO', name: 'PO', version: 1, steps: [{ step: 1, roleName: 'Project Manager', minAmount: '0' }] },
    ],
  });
  return t;
}

describe('Contractor ERP API (e2e)', () => {
  let app: INestApplication;
  let http: any;
  const A = `e2e-a-${run}`;
  const B = `e2e-b-${run}`;
  const tok: Record<string, string> = {};
  const tenantIds: string[] = [];
  let projectA = '';
  let fileA = '';

  const as = (who: string) => ({ Authorization: `Bearer ${tok[who]}` });
  const login = async (slug: string, key: string) => {
    const r = await request(http).post('/api/v1/auth/login').send({ tenant: slug, email: `${key}@${slug}.test`, password: PASS }).expect(201);
    return r.body.data.accessToken as string;
  };

  beforeAll(async () => {
    tenantIds.push((await createTenant(A)).id, (await createTenant(B)).id);
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    http = app.getHttpServer();
    for (const k of ['admin', 'pm', 'site', 'proc', 'fin', 'dir']) tok[k] = await login(A, k);
    tok.bAdmin = await login(B, 'admin');
  });

  afterAll(async () => {
    await app?.close();
    for (const id of tenantIds) await deleteTenant(prisma, id).catch(() => undefined);
    await prisma.$disconnect();
  });

  describe('Autentikasi', () => {
    it('menolak password salah dengan pesan generik', async () => {
      const r = await request(http).post('/api/v1/auth/login').send({ tenant: A, email: `admin@${A}.test`, password: 'salah-sekali' }).expect(401);
      expect(r.body.error.code).toBe('INVALID_CREDENTIALS');
      expect(r.body.error.requestId).toBeTruthy();
    });
    it('menolak request tanpa token', async () => {
      await request(http).get('/api/v1/projects').expect(401);
    });
    it('refresh token berotasi dan token lama tidak bisa dipakai ulang', async () => {
      const l = await request(http).post('/api/v1/auth/login').send({ tenant: A, email: `fin@${A}.test`, password: PASS }).expect(201);
      const rt = l.body.data.refreshToken;
      await request(http).post('/api/v1/auth/refresh').send({ refreshToken: rt }).expect(201);
      await request(http).post('/api/v1/auth/refresh').send({ refreshToken: rt }).expect(401);
    });
  });

  describe('Isolasi tenant', () => {
    beforeAll(async () => {
      const p = await request(http).post('/api/v1/projects').set(as('admin')).send({ name: 'Proyek rahasia A', contractValue: '1000000000' }).expect(201);
      projectA = p.body.data.id;
      await request(http).patch(`/api/v1/projects/${projectA}`).set(as('admin')).send({ status: 'ACTIVE' }).expect(200);
      const f = await request(http).post('/api/v1/files').set(as('admin')).field('entityType', 'Project').field('entityId', projectA).attach('files', Buffer.from('%PDF-1.4 rahasia'), { filename: 'kontrak.pdf', contentType: 'application/pdf' }).expect(201);
      fileA = f.body.data[0].id;
    });

    it('tenant B tidak melihat proyek tenant A di daftar', async () => {
      const r = await request(http).get('/api/v1/projects').set(as('bAdmin')).expect(200);
      expect(r.body.data.find((p: any) => p.id === projectA)).toBeUndefined();
    });
    it('tenant B mendapat 404 saat membuka/mengubah proyek tenant A (IDOR)', async () => {
      await request(http).get(`/api/v1/projects/${projectA}`).set(as('bAdmin')).expect(404);
      await request(http).patch(`/api/v1/projects/${projectA}`).set(as('bAdmin')).send({ status: 'ON_HOLD' }).expect(404);
    });
    it('tenant B tidak bisa mengunduh file atau melihat lampiran tenant A', async () => {
      await request(http).get(`/api/v1/files/${fileA}/download`).set(as('bAdmin')).expect(404);
      await request(http).get(`/api/v1/files?entityType=Project&entityId=${projectA}`).set(as('bAdmin')).expect(404);
    });
    it('tenant B tidak bisa mengekspor BQ proyek tenant A', async () => {
      await request(http).get(`/api/v1/exports/bq.xlsx?projectId=${projectA}`).set(as('bAdmin')).expect(404);
    });
    it('tenantId dari body request ditolak (mass assignment)', async () => {
      const r = await request(http).post('/api/v1/customers').set(as('bAdmin')).send({ code: 'X1', name: 'Coba', tenantId: tenantIds[0] }).expect(400);
      expect(r.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('RBAC', () => {
    it('Site Engineer tidak bisa membaca jurnal atau mengekspor neraca saldo', async () => {
      await request(http).get('/api/v1/journals').set(as('site')).expect(403);
      await request(http).get('/api/v1/exports/trial-balance.xlsx').set(as('site')).expect(403);
    });
    it('Finance tidak bisa membuat user', async () => {
      await request(http).post('/api/v1/users').set(as('fin')).send({ email: 'x@y.z', name: 'X', password: '12345678', roleIds: ['x'] }).expect(403);
    });
  });

  describe('Procure-to-pay & approval', () => {
    let supplierId = '';
    let prId = '';
    let poId = '';
    let invId = '';

    beforeAll(async () => {
      const s = await request(http).post('/api/v1/suppliers').set(as('proc')).send({ code: 'SUP1', name: 'Supplier Uji', paymentTerm: 30 }).expect(201);
      supplierId = s.body.data.id;
    });

    it('pengaju tidak dapat menyetujui PR miliknya sendiri', async () => {
      const pr = await request(http).post('/api/v1/purchase-requests').set(as('pm')).send({ projectId: projectA, items: [{ description: 'Semen', quantity: '10', estimatedPrice: '70000', category: 'MATERIAL' }] }).expect(201);
      await request(http).post(`/api/v1/purchase-requests/${pr.body.data.id}/submit`).set(as('pm')).expect(201);
      const inbox = await request(http).get('/api/v1/approvals/inbox').set(as('pm')).expect(200);
      const req = inbox.body.data.find((x: any) => x.entityId === pr.body.data.id);
      expect(req.canAct).toBe(false);
      const r = await request(http).post(`/api/v1/approvals/${req.id}/decision`).set(as('pm')).send({ decision: 'APPROVE' }).expect(403);
      expect(r.body.error.code).toBe('SELF_APPROVAL');
    });

    it('role yang salah tidak dapat memutuskan langkah approval', async () => {
      const pr = await request(http).post('/api/v1/purchase-requests').set(as('site')).send({ projectId: projectA, items: [{ description: 'Pasir', quantity: '5', estimatedPrice: '300000', category: 'MATERIAL' }] }).expect(201);
      prId = pr.body.data.id;
      await request(http).post(`/api/v1/purchase-requests/${prId}/submit`).set(as('site')).expect(201);
      const inbox = await request(http).get('/api/v1/approvals/inbox').set(as('fin')).expect(200);
      const req = inbox.body.data.find((x: any) => x.entityId === prId);
      const r = await request(http).post(`/api/v1/approvals/${req.id}/decision`).set(as('fin')).send({ decision: 'APPROVE' }).expect(403);
      expect(r.body.error.code).toBe('NOT_APPROVER');
    });

    it('menolak tanpa komentar tidak diperbolehkan; PM menyetujui → PR APPROVED + notifikasi ke pengaju', async () => {
      const inbox = await request(http).get('/api/v1/approvals/inbox').set(as('pm')).expect(200);
      const req = inbox.body.data.find((x: any) => x.entityId === prId);
      await request(http).post(`/api/v1/approvals/${req.id}/decision`).set(as('pm')).send({ decision: 'REJECT' }).expect(422);
      const r = await request(http).post(`/api/v1/approvals/${req.id}/decision`).set(as('pm')).send({ decision: 'APPROVE', comment: 'OK' }).expect(201);
      expect(r.body.data.status).toBe('APPROVED');
      const pr = await request(http).get(`/api/v1/purchase-requests/${prId}`).set(as('site')).expect(200);
      expect(pr.body.data.status).toBe('APPROVED');
      const n = await request(http).get('/api/v1/notifications').set(as('site')).expect(200);
      expect(n.body.data.items.some((x: any) => x.type === 'APPROVAL_RESULT')).toBe(true);
    });

    it('PR → PO → approval → terbit → GRN parsial', async () => {
      const po = await request(http).post('/api/v1/purchase-orders').set(as('proc')).send({
        projectId: projectA, supplierId, requestId: prId, taxPct: '11', items: [{ description: 'Pasir', quantity: '5', unitPrice: '280000', category: 'MATERIAL' }],
      }).expect(201);
      poId = po.body.data.id;
      expect(po.body.data.total).toBe('1554000'); // 1.400.000 + PPN 11%
      await request(http).post(`/api/v1/purchase-orders/${poId}/submit`).set(as('proc')).expect(201);
      const inbox = await request(http).get('/api/v1/approvals/inbox').set(as('pm')).expect(200);
      const req = inbox.body.data.find((x: any) => x.entityId === poId);
      await request(http).post(`/api/v1/approvals/${req.id}/decision`).set(as('pm')).send({ decision: 'APPROVE' }).expect(201);
      await request(http).post(`/api/v1/purchase-orders/${poId}/issue`).set(as('proc')).expect(201);

      const full = await request(http).get(`/api/v1/purchase-orders/${poId}`).set(as('proc')).expect(200);
      const itemId = full.body.data.items[0].id;
      await request(http).post('/api/v1/goods-receipts').set(as('proc')).send({ poId, receiptDate: new Date().toISOString(), lines: [{ poItemId: itemId, quantity: '6' }] }).expect(422);
      await request(http).post('/api/v1/goods-receipts').set(as('proc')).send({ poId, receiptDate: new Date().toISOString(), lines: [{ poItemId: itemId, quantity: '3' }] }).expect(201);
      const after = await request(http).get(`/api/v1/purchase-orders/${poId}`).set(as('proc')).expect(200);
      expect(after.body.data.status).toBe('PARTIAL_RECEIPT');
    });

    it('3-way match: tagihan berlebih ditandai MISMATCH dan tidak bisa diposting', async () => {
      const inv = await request(http).post('/api/v1/supplier-invoices').set(as('fin')).send({ poId, supplierRef: 'INV-BAD', invoiceDate: new Date().toISOString(), subtotal: '900000' }).expect(201);
      expect(inv.body.data.status).toBe('MISMATCH');
      await request(http).post(`/api/v1/supplier-invoices/${inv.body.data.id}/post`).set(as('fin')).expect(422);
    });

    it('invoice duplikat dari supplier ditolak', async () => {
      const r = await request(http).post('/api/v1/supplier-invoices').set(as('fin')).send({ poId, supplierRef: 'INV-BAD', invoiceDate: new Date().toISOString(), subtotal: '840000' }).expect(422);
      expect(r.body.error.code).toBe('DUPLICATE_INVOICE');
    });

    it('posting invoice memindahkan commitment ke actual tanpa double count, idempotent', async () => {
      const before = (await request(http).get(`/api/v1/projects/${projectA}`).set(as('admin')).expect(200)).body.data.cost.total;
      const inv = await request(http).post('/api/v1/supplier-invoices').set(as('fin')).send({ poId, supplierRef: 'INV-OK', invoiceDate: new Date().toISOString(), subtotal: '840000' }).expect(201);
      invId = inv.body.data.id;
      expect(inv.body.data.status).toBe('MATCHED');
      await request(http).post(`/api/v1/supplier-invoices/${invId}/post`).set(as('fin')).expect(201);
      await request(http).post(`/api/v1/supplier-invoices/${invId}/post`).set(as('fin')).expect(201); // kedua kali: tidak ada efek
      const after = (await request(http).get(`/api/v1/projects/${projectA}`).set(as('admin')).expect(200)).body.data.cost.total;
      expect(Number(after.actual) - Number(before.actual)).toBe(840000);
      expect(Number(before.commitment) - Number(after.commitment)).toBe(840000);
      expect(Number(after.actual) + Number(after.commitment)).toBe(Number(before.actual) + Number(before.commitment));
      const journals = await prisma.journalEntry.count({ where: { tenantId: tenantIds[0], postingRef: `SINV:${invId}` } });
      expect(journals).toBe(1);
    });

    it('pembayaran melebihi sisa ditolak; pembayaran penuh → PAID; neraca saldo balance', async () => {
      await request(http).post(`/api/v1/supplier-invoices/${invId}/pay`).set(as('fin')).send({ paymentDate: new Date().toISOString(), amount: '99999999' }).expect(422);
      const r = await request(http).post(`/api/v1/supplier-invoices/${invId}/pay`).set(as('fin')).send({ paymentDate: new Date().toISOString(), amount: '932400' }).expect(201);
      expect(r.body.data.status).toBe('PAID');
      const tb = await request(http).get('/api/v1/reports/trial-balance').set(as('admin')).expect(200);
      expect(tb.body.data.balanced).toBe(true);
    });
  });

  describe('Jurnal & periode', () => {
    let kas = '';
    let modal = '';
    beforeAll(async () => {
      const acc = (await request(http).get('/api/v1/accounts').set(as('admin')).expect(200)).body.data;
      kas = acc.find((a: any) => a.code === '1101').id;
      modal = acc.find((a: any) => a.code === '3101').id;
    });

    it('jurnal tidak balance ditolak 422', async () => {
      const r = await request(http).post('/api/v1/journals').set(as('admin')).send({ entryDate: '2026-01-10', lines: [{ accountId: kas, debit: '100', credit: '0' }, { accountId: modal, debit: '0', credit: '90' }] }).expect(422);
      expect(r.body.error.code).toBe('UNBALANCED');
    });

    it('jurnal posted tidak bisa dihapus; koreksi lewat reversal', async () => {
      const j = await request(http).post('/api/v1/journals').set(as('admin')).send({ entryDate: new Date().toISOString(), lines: [{ accountId: kas, debit: '500000', credit: '0' }, { accountId: modal, debit: '0', credit: '500000' }] }).expect(201);
      await request(http).post(`/api/v1/journals/${j.body.data.id}/post`).set(as('admin')).expect(201);
      await request(http).delete(`/api/v1/journals/${j.body.data.id}`).set(as('admin')).expect(422);
      const rev = await request(http).post(`/api/v1/journals/${j.body.data.id}/reverse`).set(as('admin')).expect(201);
      expect(rev.body.data.status).toBe('POSTED');
      const orig = await request(http).get(`/api/v1/journals/${j.body.data.id}`).set(as('admin')).expect(200);
      expect(orig.body.data.status).toBe('REVERSED');
    });

    it('periode yang ditutup menolak posting', async () => {
      const j = await request(http).post('/api/v1/journals').set(as('admin')).send({ entryDate: '2025-03-15', lines: [{ accountId: kas, debit: '1000', credit: '0' }, { accountId: modal, debit: '0', credit: '1000' }] }).expect(201);
      await request(http).post(`/api/v1/accounting-periods/2025-03/close`).set(as('admin')).expect(422); // masih ada draft
      await request(http).delete(`/api/v1/journals/${j.body.data.id}`).set(as('admin')).expect(200);
      await request(http).post(`/api/v1/accounting-periods/2025-03/close`).set(as('admin')).expect(201);
      const j2 = await request(http).post('/api/v1/journals').set(as('admin')).send({ entryDate: '2025-03-20', lines: [{ accountId: kas, debit: '1000', credit: '0' }, { accountId: modal, debit: '0', credit: '1000' }] }).expect(201);
      const r = await request(http).post(`/api/v1/journals/${j2.body.data.id}/post`).set(as('admin')).expect(422);
      expect(r.body.error.code).toBe('PERIOD_CLOSED');
    });
  });

  describe('Gudang & stok', () => {
    it('stok tidak boleh minus; moving average dihitung saat barang masuk', async () => {
      const wh = await request(http).post('/api/v1/warehouses').set(as('admin')).send({ code: 'WH1', name: 'Gudang uji' }).expect(201);
      const it = await request(http).post('/api/v1/inventory/items').set(as('admin')).send({ code: 'ITM1', name: 'Besi uji', unit: 'kg', category: 'MATERIAL', minStock: '5' }).expect(201);
      await request(http).post('/api/v1/stock-movements').set(as('admin')).send({ type: 'ISSUE', warehouseId: wh.body.data.id, lines: [{ itemId: it.body.data.id, quantity: '1' }] }).expect(422);
      // opname menjadikan stok 10 lalu pakai 7 → sisa 3 (di bawah minimum)
      await request(http).post('/api/v1/stock-movements').set(as('admin')).send({ type: 'OPNAME', warehouseId: wh.body.data.id, lines: [{ itemId: it.body.data.id, quantity: '10' }] }).expect(201);
      await request(http).post('/api/v1/stock-movements').set(as('admin')).send({ type: 'ISSUE', warehouseId: wh.body.data.id, lines: [{ itemId: it.body.data.id, quantity: '7' }] }).expect(201);
      const st = await request(http).get(`/api/v1/inventory/stock?warehouseId=${wh.body.data.id}`).set(as('admin')).expect(200);
      expect(st.body.data[0].quantity).toBe('3');
      expect(st.body.data[0].low).toBe(true);
    });
  });

  describe('Export', () => {
    it('Excel dan PDF bisa diunduh sesuai hak akses', async () => {
      const x = await request(http).get('/api/v1/exports/projects.xlsx').set(as('admin')).buffer(true).expect(200);
      expect(x.headers['content-type']).toContain('spreadsheetml');
      const po = await prisma.purchaseOrder.findFirst({ where: { tenantId: tenantIds[0] } });
      const pdf = await request(http).get(`/api/v1/documents/purchase-orders/${po!.id}.pdf`).set(as('proc')).buffer(true).expect(200);
      expect(pdf.headers['content-type']).toBe('application/pdf');
      await request(http).get(`/api/v1/documents/purchase-orders/${po!.id}.pdf`).set(as('bAdmin')).expect(404);
    });
  });
});
