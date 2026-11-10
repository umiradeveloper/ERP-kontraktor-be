/**
 * Seed data demo — tenant "demo" (PT Bangun Nusantara Konstruksi).
 * Master data dibuat langsung; transaksi dijalankan melalui service bisnis asli
 * sehingga jurnal, cost, approval, dan audit log konsisten.
 *
 *   npm run db:seed
 */
import '../src/env';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Prisma, PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../src/app.module';
import { deleteTenant } from './cleanup';
import { AuthUser } from '../src/common/auth';
import { TendersService } from '../src/modules/tenders.module';
import { ProjectsService } from '../src/modules/projects.module';
import { ProcurementService } from '../src/modules/procurement.module';
import { ApprovalsService } from '../src/modules/approvals.module';
import { BillingService } from '../src/modules/billing.module';
import { AssetsService } from '../src/modules/assets.module';
import { PostingService } from '../src/modules/accounting.module';
import { InventoryService } from '../src/modules/inventory.module';
import { RfqService } from '../src/modules/rfq.module';
import { VariationOrdersService } from '../src/modules/variation-orders.module';

const prisma = new PrismaClient();
const PASSWORD = 'Password123!';

const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(9, 0, 0, 0);
  return d;
};
const iso = (n: number) => daysAgo(n).toISOString();

const ROLES: Record<string, { desc: string; perms: string[] }> = {
  Administrator: { desc: 'Tenant owner — akses penuh', perms: ['*'] },
  Direktur: {
    desc: 'Portfolio, approval strategis',
    perms: ['project:read', 'tender:read', 'cost:read', 'finance:read', 'accounting:read', 'procurement:read', 'asset:read', 'master:read', 'audit:read', 'warehouse:read'],
  },
  'Project Manager': { desc: 'Kontrak, jadwal, budget, progres, VO', perms: ['project:write', 'tender:read', 'procurement:read', 'cost:read', 'asset:read', 'master:read', 'warehouse:read'] },
  'Site Engineer': { desc: 'Progres, laporan harian, PR, pemakaian material', perms: ['project:write', 'procurement:read', 'master:read', 'warehouse:write'] },
  Estimator: { desc: 'BQ, AHSP, tender', perms: ['tender:write', 'master:write', 'project:read'] },
  Procurement: { desc: 'Supplier, PO, penerimaan', perms: ['procurement:write', 'master:write', 'project:read', 'warehouse:write'] },
  'Cost Controller': { desc: 'Budget, commitment, actual, forecast', perms: ['cost:read', 'project:read', 'procurement:read', 'warehouse:read'] },
  Finance: { desc: 'Kas, bank, AR/AP', perms: ['finance:write', 'accounting:read', 'project:read', 'procurement:read'] },
  Accountant: { desc: 'GL, jurnal, closing', perms: ['accounting:write', 'finance:read', 'project:read'] },
  'Asset Manager': { desc: 'Aset & maintenance', perms: ['asset:write', 'project:read', 'warehouse:write'] },
  Auditor: {
    desc: 'Read-only + audit trail',
    perms: ['project:read', 'tender:read', 'cost:read', 'finance:read', 'accounting:read', 'procurement:read', 'asset:read', 'master:read', 'audit:read', 'warehouse:read'],
  },
};

const USERS = [
  { key: 'admin', email: 'admin@demo.co.id', name: 'Rina Kusuma', title: 'System Administrator', roles: ['Administrator'] },
  { key: 'dir', email: 'direktur@demo.co.id', name: 'Budi Santoso', title: 'Direktur Utama', roles: ['Direktur'] },
  { key: 'pm', email: 'pm@demo.co.id', name: 'Andi Wijaya', title: 'Project Manager', roles: ['Project Manager'] },
  { key: 'site', email: 'site@demo.co.id', name: 'Eko Saputra', title: 'Site Engineer', roles: ['Site Engineer'] },
  { key: 'est', email: 'estimator@demo.co.id', name: 'Sari Dewi', title: 'Estimator / QS', roles: ['Estimator'] },
  { key: 'proc', email: 'procurement@demo.co.id', name: 'Dimas Pratama', title: 'Procurement Officer', roles: ['Procurement'] },
  { key: 'fin', email: 'finance@demo.co.id', name: 'Maya Lestari', title: 'Finance & Accounting', roles: ['Finance', 'Accountant'] },
  { key: 'asset', email: 'aset@demo.co.id', name: 'Joko Susilo', title: 'Asset Manager', roles: ['Asset Manager'] },
  { key: 'cc', email: 'cost@demo.co.id', name: 'Lina Marlina', title: 'Cost Controller', roles: ['Cost Controller'] },
];

const COA: [string, string, string][] = [
  ['1101', 'Kas & Bank', 'ASSET'],
  ['1201', 'Piutang Usaha', 'ASSET'],
  ['1202', 'Piutang Retensi', 'ASSET'],
  ['1301', 'PPN Masukan', 'ASSET'],
  ['1501', 'Peralatan & Alat Berat', 'ASSET'],
  ['2101', 'Hutang Usaha', 'LIABILITY'],
  ['2201', 'PPN Keluaran', 'LIABILITY'],
  ['2301', 'Uang Muka Proyek', 'LIABILITY'],
  ['3101', 'Modal Disetor', 'EQUITY'],
  ['3201', 'Laba Ditahan', 'EQUITY'],
  ['4101', 'Pendapatan Kontrak', 'REVENUE'],
  ['5101', 'Biaya Material', 'EXPENSE'],
  ['5102', 'Biaya Upah', 'EXPENSE'],
  ['5103', 'Biaya Alat', 'EXPENSE'],
  ['5104', 'Biaya Subkontraktor', 'EXPENSE'],
  ['5105', 'Biaya Overhead Proyek', 'EXPENSE'],
  ['5199', 'Biaya Lain-lain', 'EXPENSE'],
  ['6101', 'Beban Umum & Administrasi', 'EXPENSE'],
];

type Item = [string, string, string, string, any, string, string];
// section, code, description, unit, category, qty, unitCost

const TENDER_KANTOR: Item[] = [
  ['A. Pekerjaan Persiapan', 'A.1', 'Mobilisasi & demobilisasi', 'ls', 'OVERHEAD', '1', '85000000'],
  ['A. Pekerjaan Persiapan', 'A.2', 'Direksi keet & gudang', 'm2', 'MATERIAL', '60', '950000'],
  ['B. Pekerjaan Struktur', 'B.1', 'Galian tanah pondasi', 'm3', 'LABOR', '420', '95000'],
  ['B. Pekerjaan Struktur', 'B.2', 'Tiang pancang spun pile Ø40', 'm', 'SUBCONTRACTOR', '960', '650000'],
  ['B. Pekerjaan Struktur', 'B.3', 'Beton ready mix K-350', 'm3', 'MATERIAL', '780', '1150000'],
  ['B. Pekerjaan Struktur', 'B.4', 'Besi beton ulir D16', 'kg', 'MATERIAL', '92000', '13500'],
  ['B. Pekerjaan Struktur', 'B.5', 'Upah tukang struktur', 'm3', 'LABOR', '780', '320000'],
  ['B. Pekerjaan Struktur', 'B.6', 'Sewa tower crane', 'bln', 'EQUIPMENT', '8', '72000000'],
  ['C. Arsitektur', 'C.1', 'Dinding bata ringan', 'm2', 'MATERIAL', '3800', '165000'],
  ['C. Arsitektur', 'C.2', 'Plester & acian', 'm2', 'LABOR', '7600', '58000'],
  ['C. Arsitektur', 'C.3', 'Lantai granit 60x60', 'm2', 'MATERIAL', '2900', '310000'],
  ['C. Arsitektur', 'C.4', 'Kusen & jendela aluminium', 'm2', 'SUBCONTRACTOR', '640', '1250000'],
  ['D. MEP', 'D.1', 'Instalasi listrik & panel', 'ls', 'SUBCONTRACTOR', '1', '1350000000'],
  ['D. MEP', 'D.2', 'Instalasi plumbing', 'ls', 'SUBCONTRACTOR', '1', '620000000'],
];

const TENDER_GUDANG: Item[] = [
  ['A. Persiapan', 'A.1', 'Pembersihan & pematangan lahan', 'm2', 'EQUIPMENT', '12000', '28000'],
  ['A. Persiapan', 'A.2', 'Mobilisasi alat berat', 'ls', 'OVERHEAD', '1', '65000000'],
  ['B. Struktur Baja', 'B.1', 'Baja WF rangka utama', 'kg', 'MATERIAL', '185000', '19500'],
  ['B. Struktur Baja', 'B.2', 'Fabrikasi & erection baja', 'kg', 'SUBCONTRACTOR', '185000', '6500'],
  ['B. Struktur Baja', 'B.3', 'Atap spandek 0.5mm', 'm2', 'MATERIAL', '9800', '145000'],
  ['C. Lantai', 'C.1', 'Lantai beton floor hardener', 'm2', 'MATERIAL', '9600', '420000'],
  ['C. Lantai', 'C.2', 'Upah pengecoran lantai', 'm2', 'LABOR', '9600', '65000'],
  ['D. Infrastruktur', 'D.1', 'Jalan paving & drainase', 'm2', 'SUBCONTRACTOR', '3200', '385000'],
];

const TENDER_SEKOLAH: Item[] = [
  ['A. Bongkaran', 'A.1', 'Bongkar plafon & atap lama', 'm2', 'LABOR', '1450', '45000'],
  ['B. Atap', 'B.1', 'Rangka atap baja ringan', 'm2', 'MATERIAL', '1450', '210000'],
  ['B. Atap', 'B.2', 'Genteng metal pasir', 'm2', 'MATERIAL', '1450', '125000'],
  ['C. Finishing', 'C.1', 'Cat dinding interior & eksterior', 'm2', 'MATERIAL', '5200', '38000'],
  ['C. Finishing', 'C.2', 'Upah finishing', 'm2', 'LABOR', '5200', '22000'],
];

async function main() {
  console.log('▶ Reset data tenant demo…');
  const old = await prisma.tenant.findUnique({ where: { slug: 'demo' } });
  if (old) {
    await deleteTenant(prisma, old.id);
  }

  console.log('▶ Tenant, perusahaan, role & user…');
  const tenant = await prisma.tenant.create({
    data: {
      name: 'PT Bangun Nusantara Konstruksi',
      slug: 'demo',
      planCode: 'BUSINESS',
      companies: { create: { name: 'PT Bangun Nusantara Konstruksi', code: 'BNK', npwp: '01.234.567.8-901.000', address: 'Jl. Jend. Sudirman Kav. 21, Jakarta Selatan' } },
    },
  });
  const T = tenant.id;

  const roleIds: Record<string, string> = {};
  for (const [name, r] of Object.entries(ROLES)) {
    roleIds[name] = (await prisma.role.create({ data: { tenantId: T, name, description: r.desc, permissions: r.perms } })).id;
  }
  const hash = await bcrypt.hash(PASSWORD, 10);
  const U: Record<string, AuthUser> = {};
  for (const u of USERS) {
    const row = await prisma.user.create({
      data: {
        tenantId: T, email: u.email, name: u.name, title: u.title, passwordHash: hash,
        memberships: { create: u.roles.map((r) => ({ tenantId: T, roleId: roleIds[r] })) },
      },
    });
    U[u.key] = {
      userId: row.id, tenantId: T, name: u.name, email: u.email, roles: u.roles,
      perms: [...new Set(u.roles.flatMap((r) => ROLES[r].perms))],
    };
  }

  await prisma.account.createMany({ data: COA.map(([code, name, accountType]) => ({ tenantId: T, code, name, accountType: accountType as any })) });

  await prisma.workflowDefinition.createMany({
    data: [
      { tenantId: T, entityType: 'PR', name: 'Approval Purchase Request', version: 1, steps: [
        { step: 1, roleName: 'Project Manager', minAmount: '0' },
        { step: 2, roleName: 'Direktur', minAmount: '250000000' },
      ] },
      { tenantId: T, entityType: 'PO', name: 'Approval Purchase Order', version: 1, steps: [
        { step: 1, roleName: 'Project Manager', minAmount: '0' },
        { step: 2, roleName: 'Direktur', minAmount: '500000000' },
      ] },
      { tenantId: T, entityType: 'VO', name: 'Approval Variation Order', version: 1, steps: [
        { step: 1, roleName: 'Direktur', minAmount: '0' },
      ] },
    ],
  });

  const customers = await Promise.all(
    [
      ['SINAR', 'PT Sinar Abadi Properti', 'procurement@sinarabadi.co.id'],
      ['LOGI', 'PT Logistik Prima Indonesia', 'project@logprima.co.id'],
      ['DISDIK', 'Dinas Pendidikan Kota Bekasi', 'sarpras@disdik.bekasikota.go.id'],
      ['PUPR', 'Dinas PUPR Kab. Bogor', 'pengadaan@pupr.bogorkab.go.id'],
      ['GRIYA', 'PT Griya Asri Sejahtera', 'info@griyaasri.co.id'],
    ].map(([code, name, email]) => prisma.customer.create({ data: { tenantId: T, code, name, email } })),
  );
  const C = Object.fromEntries(customers.map((c) => [c.code, c.id]));

  const suppliers = await Promise.all(
    [
      ['SUP-BTN', 'PT Beton Jaya Readymix', 'Material', 30],
      ['SUP-BSI', 'CV Baja Sentosa', 'Material', 30],
      ['SUP-PCG', 'PT Pancang Kokoh Nusantara', 'Subkon', 45],
      ['SUP-ALT', 'PT Sewa Alat Berat Mandiri', 'Alat', 30],
      ['SUP-MDR', 'Mandor Slamet & Tim', 'Upah', 14],
      ['SUP-KRM', 'PT Keramik Indah Lestari', 'Material', 30],
      ['SUP-MEP', 'PT Elektrika Teknik Utama', 'Subkon', 45],
    ].map(([code, name, category, paymentTerm]) =>
      prisma.supplier.create({ data: { tenantId: T, code: code as string, name: name as string, category: category as string, paymentTerm: paymentTerm as number } }),
    ),
  );
  const S = Object.fromEntries(suppliers.map((s) => [s.code, s.id]));
  await prisma.$disconnect();

  console.log('▶ Menjalankan transaksi demo melalui service…');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const tenders = app.get(TendersService);
  const projects = app.get(ProjectsService);
  const proc = app.get(ProcurementService);
  const approvals = app.get(ApprovalsService);
  const billing = app.get(BillingService);
  const assets = app.get(AssetsService);
  const posting = app.get(PostingService);
  const inventory = app.get(InventoryService);
  const rfqs = app.get(RfqService);
  const vos = app.get(VariationOrdersService);
  const { PrismaService } = await import('../src/prisma/prisma.service');
  const pdb = app.get(PrismaService);

  // Modal awal
  await pdb.$transaction((tx) =>
    posting.post(tx, U.fin, {
      postingRef: 'OPENING:CAPITAL', date: daysAgo(200), description: 'Setoran modal awal', sourceType: 'OPENING', sourceId: T,
      lines: [
        { accountCode: '1101', debit: new Prisma.Decimal('8500000000') },
        { accountCode: '3101', credit: new Prisma.Decimal('8500000000') },
      ],
    }),
  );

  const mkItems = (rows: Item[]) => ({
    items: rows.map(([section, code, description, unit, category, quantity, unitCost]) => ({ section, code, description, unit, category, quantity, unitCost })),
  });
  const approveAll = async (entityType: string, entityId: string) => {
    for (let i = 0; i < 3; i++) {
      const req = await pdb.approvalRequest.findFirst({ where: { tenantId: T, entityType, entityId, status: 'IN_APPROVAL' } });
      if (!req) return;
      const step = (req.stepsSnapshot as any[]).find((s) => s.step === req.currentStep);
      const approver = step.roleName === 'Direktur' ? U.dir : U.pm;
      await approvals.decide(approver, req.id, { decision: 'APPROVE', comment: step.roleName === 'Direktur' ? 'Disetujui, sesuai anggaran' : 'OK, sesuai kebutuhan lapangan' });
    }
  };

  // ── Tender 1: menang → Proyek gedung kantor
  const t1 = await tenders.create(U.est, { title: 'Pembangunan Gedung Kantor 4 Lantai PT Sinar Abadi', customerId: C.SINAR, location: 'Bekasi, Jawa Barat', deadline: iso(190), profitPct: '9' });
  await tenders.saveItems(U.est, t1.id, mkItems(TENDER_KANTOR) as any);
  await tenders.transition(U.est, t1.id, 'REVIEW');
  await tenders.transition(U.est, t1.id, 'SUBMITTED');
  const w1 = await tenders.decision(U.est, t1.id, { decision: 'WON', startDate: iso(165), endDate: iso(-200), managerName: 'Andi Wijaya' });
  const P1 = (w1 as any).projectId as string;
  await projects.update(U.pm, P1, { status: 'ACTIVE' });

  // ── Tender 2: menang → Proyek gudang
  const t2 = await tenders.create(U.est, { title: 'Gudang Logistik Modern Cikarang', customerId: C.LOGI, location: 'Cikarang, Bekasi', deadline: iso(120), profitPct: '8' });
  await tenders.saveItems(U.est, t2.id, mkItems(TENDER_GUDANG) as any);
  await tenders.transition(U.est, t2.id, 'SUBMITTED');
  const w2 = await tenders.decision(U.est, t2.id, { decision: 'WON', startDate: iso(100), endDate: iso(-140), managerName: 'Andi Wijaya' });
  const P2 = (w2 as any).projectId as string;
  await projects.update(U.pm, P2, { status: 'ACTIVE' });

  // ── Tender 3: submitted (menunggu hasil), Tender 4: draft, Tender 5: kalah
  const t3 = await tenders.create(U.est, { title: 'Renovasi Atap & Finishing SDN 12 Bekasi', customerId: C.DISDIK, location: 'Bekasi Timur', deadline: iso(-12) });
  await tenders.saveItems(U.est, t3.id, mkItems(TENDER_SEKOLAH) as any);
  await tenders.transition(U.est, t3.id, 'SUBMITTED');
  const t4 = await tenders.create(U.est, { title: 'Jembatan Beton Desa Cibeureum', customerId: C.PUPR, location: 'Kab. Bogor', deadline: iso(-25) });
  await tenders.saveItems(U.est, t4.id, mkItems(TENDER_SEKOLAH.slice(0, 2)) as any);
  const t5 = await tenders.create(U.est, { title: 'Ruko 3 Lantai Grand Boulevard', customerId: C.GRIYA, location: 'Tangerang', deadline: iso(60) });
  await tenders.saveItems(U.est, t5.id, mkItems(TENDER_SEKOLAH) as any);
  await tenders.transition(U.est, t5.id, 'SUBMITTED');
  await tenders.decision(U.est, t5.id, { decision: 'LOST' });

  // ── Proyek manual (setup)
  await projects.create(U.pm, { name: 'Perumahan Griya Asri Tahap 1 (45 unit)', customerId: C.GRIYA, location: 'Cileungsi, Bogor', managerName: 'Andi Wijaya', contractValue: '12750000000', startDate: iso(-20), endDate: iso(-380) });

  // ── Gudang: pusat + gudang site per proyek
  const whMain = await inventory.createWarehouse(U.admin, { code: 'GDG-PUSAT', name: 'Gudang Pusat Cibitung', location: 'Cibitung, Bekasi' });
  const wh1 = await inventory.createWarehouse(U.admin, { code: 'SITE-KANTOR', name: 'Gudang site Gedung Kantor', projectId: P1, location: 'Bekasi' });
  const wh2 = await inventory.createWarehouse(U.admin, { code: 'SITE-GUDANG', name: 'Gudang site Cikarang', projectId: P2, location: 'Cikarang' });
  const WH: Record<string, string> = { [P1]: wh1.id, [P2]: wh2.id };
  void whMain;

  // ── Progres & laporan harian
  const prog1: [number, string, string][] = [[150, '8', '7'], [120, '18', '16.5'], [90, '30', '28'], [60, '42', '41'], [30, '55', '52'], [5, '64', '60']];
  for (const [d, plan, act] of prog1) await projects.addProgress(U.site, P1, { reportDate: iso(d), plannedPct: plan, actualPct: act, notes: 'Update mingguan' });
  const prog2: [number, string, string][] = [[80, '10', '12'], [50, '24', '26'], [20, '38', '37'], [3, '46', '44']];
  for (const [d, plan, act] of prog2) await projects.addProgress(U.site, P2, { reportDate: iso(d), plannedPct: plan, actualPct: act });
  await projects.addDailyReport(U.site, P1, { reportDate: iso(1), weather: 'Cerah', manpower: 64, activities: 'Pengecoran kolom lantai 3 zona B, pemasangan bekisting balok lantai 4.', issues: 'Pengiriman besi D16 terlambat 1 hari.' });
  await projects.addDailyReport(U.site, P1, { reportDate: iso(2), weather: 'Hujan sore', manpower: 58, activities: 'Pembesian pelat lantai 3, pasang bata ringan lantai 1.' });
  await projects.addDailyReport(U.site, P2, { reportDate: iso(1), weather: 'Cerah', manpower: 41, activities: 'Erection kolom baja grid C–F, pemasangan gording.' });

  // ── Procurement P1: PR → PO → GRN → Invoice → Bayar
  type L = [string, string, string, string, any];
  const flow = async (o: {
    project: string; supplier: string; prDays: number; lines: L[]; receive?: 'full' | 'partial' | 'none';
    invoice?: 'paid' | 'partial' | 'posted' | 'mismatch' | 'none'; issue?: boolean; submitPo?: boolean; approvePo?: boolean;
  }) => {
    const pr = await proc.createPr(U.site, {
      projectId: o.project, neededAt: iso(o.prDays - 7), notes: 'Kebutuhan material sesuai jadwal',
      items: o.lines.map(([description, quantity, unit, estimatedPrice, category]) => ({ description, quantity, unit, estimatedPrice, category })),
    });
    await proc.submitPr(U.site, pr.id);
    await approveAll('PR', pr.id);
    const po = await proc.createPo(U.proc, {
      projectId: o.project, supplierId: S[o.supplier], requestId: pr.id, deliveryDate: iso(o.prDays - 10), deliveryAddress: 'Lokasi proyek',
      items: o.lines.map(([description, quantity, unit, price, category]) => ({ description, quantity, unit, unitPrice: String(Math.round(Number(price) * 0.97)), category })),
    });
    if (o.submitPo === false) return { pr, po };
    await proc.submitPo(U.proc, po.id);
    if (o.approvePo === false) return { pr, po };
    await approveAll('PO', po.id);
    if (o.issue === false) return { pr, po };
    await proc.issuePo(U.proc, po.id);
    const full = await pdb.purchaseOrder.findUniqueOrThrow({ where: { id: po.id }, include: { items: true } });
    if (!o.receive || o.receive === 'none') return { pr, po };
    const toStock = o.lines.every((l) => l[4] === 'MATERIAL');
    await proc.createGrn(U.proc, {
      poId: po.id, receiptDate: iso(o.prDays - 12), notes: 'Diterima baik', warehouseId: toStock ? WH[o.project] : undefined,
      lines: full.items.map((i) => ({ poItemId: i.id, quantity: (o.receive === 'partial' ? i.quantity.mul(0.6).toDecimalPlaces(0) : i.quantity).toString() })),
    });
    if (!o.invoice || o.invoice === 'none') return { pr, po };
    const after = await pdb.purchaseOrder.findUniqueOrThrow({ where: { id: po.id }, include: { items: true } });
    const expected = after.items.reduce((a, i) => a + i.receivedQty.minus(i.invoicedQty).mul(i.unitPrice).toNumber(), 0);
    const inv = await proc.createSupplierInvoice(U.fin, {
      poId: po.id, supplierRef: `INV/${o.supplier.slice(4)}/${o.project.slice(0, 4).toUpperCase()}/${o.prDays}`, invoiceDate: iso(o.prDays - 15),
      subtotal: (o.invoice === 'mismatch' ? Math.round(expected * 1.04) : Math.round(expected)).toString(),
    });
    if (o.invoice === 'mismatch') return { pr, po, inv };
    await proc.postSupplierInvoice(U.fin, inv.id);
    if (o.invoice === 'paid') await proc.paySupplierInvoice(U.fin, inv.id, { paymentDate: iso(Math.max(o.prDays - 40, 1)), amount: inv.total.toString() });
    if (o.invoice === 'partial') await proc.paySupplierInvoice(U.fin, inv.id, { paymentDate: iso(Math.max(o.prDays - 30, 1)), amount: inv.total.mul(0.5).toDecimalPlaces(0).toString() });
    return { pr, po, inv };
  };

  await flow({ project: P1, supplier: 'SUP-PCG', prDays: 160, lines: [['Tiang pancang spun pile Ø40 (supply & pancang)', '960', 'm', '650000', 'SUBCONTRACTOR']], receive: 'full', invoice: 'paid' });
  await flow({ project: P1, supplier: 'SUP-BTN', prDays: 140, lines: [['Beton ready mix K-350', '320', 'm3', '1150000', 'MATERIAL'], ['Pompa beton', '12', 'kali', '3500000', 'EQUIPMENT']], receive: 'full', invoice: 'paid' });
  await flow({ project: P1, supplier: 'SUP-BSI', prDays: 120, lines: [['Besi beton ulir D16', '42000', 'kg', '13500', 'MATERIAL'], ['Besi beton D10', '12000', 'kg', '13800', 'MATERIAL']], receive: 'full', invoice: 'paid' });
  await flow({ project: P1, supplier: 'SUP-MDR', prDays: 110, lines: [['Upah tukang struktur termin 1', '300', 'm3', '320000', 'LABOR'], ['Upah galian', '420', 'm3', '95000', 'LABOR']], receive: 'full', invoice: 'paid' });
  await flow({ project: P1, supplier: 'SUP-ALT', prDays: 95, lines: [['Sewa tower crane', '4', 'bln', '72000000', 'EQUIPMENT']], receive: 'full', invoice: 'partial' });
  await flow({ project: P1, supplier: 'SUP-BTN', prDays: 60, lines: [['Beton ready mix K-350', '280', 'm3', '1150000', 'MATERIAL']], receive: 'full', invoice: 'posted' });
  await flow({ project: P1, supplier: 'SUP-BSI', prDays: 40, lines: [['Besi beton ulir D16', '30000', 'kg', '13500', 'MATERIAL']], receive: 'partial', invoice: 'mismatch' });
  await flow({ project: P1, supplier: 'SUP-KRM', prDays: 20, lines: [['Lantai granit 60x60', '1400', 'm2', '310000', 'MATERIAL']], receive: 'none' });

  await flow({ project: P2, supplier: 'SUP-ALT', prDays: 95, lines: [['Pematangan lahan (excavator + dump truck)', '12000', 'm2', '28000', 'EQUIPMENT']], receive: 'full', invoice: 'paid' });
  await flow({ project: P2, supplier: 'SUP-BSI', prDays: 70, lines: [['Baja WF rangka utama', '120000', 'kg', '19500', 'MATERIAL']], receive: 'full', invoice: 'partial' });
  await flow({ project: P2, supplier: 'SUP-PCG', prDays: 45, lines: [['Fabrikasi & erection baja', '120000', 'kg', '6500', 'SUBCONTRACTOR']], receive: 'partial', invoice: 'posted' });
  await flow({ project: P2, supplier: 'SUP-BSI', prDays: 15, lines: [['Atap spandek 0.5mm', '9800', 'm2', '145000', 'MATERIAL']], issue: false });
  await flow({ project: P2, supplier: 'SUP-BTN', prDays: 6, lines: [['Beton lantai + floor hardener', '9600', 'm2', '420000', 'MATERIAL']], approvePo: false });

  // PR yang masih menunggu approval (untuk inbox)
  const prPending = await proc.createPr(U.site, {
    projectId: P1, neededAt: iso(-14), notes: 'Material arsitektur lantai 1–2',
    items: [
      { description: 'Bata ringan 10cm', quantity: '1800', unit: 'm2', estimatedPrice: '165000', category: 'MATERIAL' },
      { description: 'Semen instan perekat', quantity: '420', unit: 'sak', estimatedPrice: '98000', category: 'MATERIAL' },
    ],
  });
  await proc.submitPr(U.site, prPending.id);
  const prPending2 = await proc.createPr(U.site, {
    projectId: P2, neededAt: iso(-10), notes: 'Pekerjaan infrastruktur',
    items: [{ description: 'Paving block K-300 + pasir', quantity: '3200', unit: 'm2', estimatedPrice: '145000', category: 'MATERIAL' }],
  });
  await proc.submitPr(U.site, prPending2.id);
  await proc.createPr(U.site, {
    projectId: P1, neededAt: iso(-30), notes: 'Draft — menunggu konfirmasi gambar',
    items: [{ description: 'Kusen aluminium 4"', quantity: '640', unit: 'm2', estimatedPrice: '1250000', category: 'SUBCONTRACTOR' }],
  });

  // ── Pemakaian material dari gudang site (stok keluar ke pekerjaan)
  const items = await pdb.inventoryItem.findMany({ where: { tenantId: T } });
  const it = (name: string) => items.find((i) => i.name.startsWith(name))!.id;
  await pdb.inventoryItem.updateMany({ where: { tenantId: T, name: { startsWith: 'Besi beton ulir D16' } }, data: { minStock: 5000 } });
  await inventory.createMovement(U.site, { type: 'ISSUE', warehouseId: wh1.id, projectId: P1, costCode: 'B.4', movedAt: iso(100), notes: 'Pembesian kolom & balok lt. 1–2', lines: [{ itemId: it('Besi beton ulir D16'), quantity: '30000' }, { itemId: it('Besi beton D10'), quantity: '9000' }] });
  await inventory.createMovement(U.site, { type: 'ISSUE', warehouseId: wh1.id, projectId: P1, costCode: 'B.4', movedAt: iso(20), notes: 'Pembesian lt. 3', lines: [{ itemId: it('Besi beton ulir D16'), quantity: '9500' }] });
  await inventory.createMovement(U.site, { type: 'ISSUE', warehouseId: wh2.id, projectId: P2, costCode: 'B.1', movedAt: iso(30), notes: 'Erection kolom grid A–C', lines: [{ itemId: it('Baja WF rangka utama'), quantity: '82000' }] });
  await inventory.createMovement(U.site, { type: 'TRANSFER', warehouseId: wh1.id, toWarehouseId: whMain.id, movedAt: iso(15), notes: 'Sisa besi D10 kembali ke gudang pusat', lines: [{ itemId: it('Besi beton D10'), quantity: '1500' }] });

  // ── RFQ terbuka dengan 3 penawaran (untuk demo perbandingan)
  const prRfq = await proc.createPr(U.site, {
    projectId: P1, neededAt: iso(-21), notes: 'Pekerjaan arsitektur lantai 1–4',
    items: [
      { description: 'Lantai granit 60x60 polished', quantity: '1500', unit: 'm2', estimatedPrice: '310000', category: 'MATERIAL' },
      { description: 'Plint granit 10x60', quantity: '820', unit: 'm1', estimatedPrice: '65000', category: 'MATERIAL' },
      { description: 'Semen instan perekat granit', quantity: '600', unit: 'sak', estimatedPrice: '98000', category: 'MATERIAL' },
    ],
  });
  await proc.submitPr(U.site, prRfq.id);
  await approveAll('PR', prRfq.id);
  const rfq = await rfqs.createFromPr(U.proc, { requestId: prRfq.id, dueDate: iso(-5), supplierIds: [S['SUP-KRM'], S['SUP-BTN'], S['SUP-BSI']] });
  const rfqItems = await pdb.rfqItem.findMany({ where: { rfqId: rfq.id }, orderBy: { description: 'asc' } });
  const quote = async (sup: string, prices: number[], lead: number, term: number, ref: string) =>
    rfqs.saveQuotation(U.proc, rfq.id, { supplierId: S[sup], quoteRef: ref, quoteDate: iso(3), leadTimeDays: lead, paymentTerm: term, lines: rfqItems.map((i, k) => ({ rfqItemId: i.id, unitPrice: String(prices[k]) })) });
  // urutan item (alfabetis): Lantai granit, Plint, Semen
  await quote('SUP-KRM', [298000, 61000, 96500], 14, 30, 'QT/KIL/1102');
  await quote('SUP-BTN', [305000, 58000, 94000], 7, 45, 'QT-BJR-778');
  await quote('SUP-BSI', [289000, 66000, 99000], 21, 30, 'SBS/Q/0219');

  // ── Variation order: satu disetujui (P1), satu menunggu Direktur (P2)
  const vo1 = await vos.create(U.pm, P1, {
    title: 'Penambahan kanopi lobby & ramp difabel', description: 'Permintaan owner melalui surat No. 045/SAP/IX/2026',
    contractChange: '485000000',
    items: [
      { category: 'MATERIAL' as any, description: 'Rangka baja & kaca tempered kanopi', amount: '255000000' },
      { category: 'LABOR' as any, description: 'Upah pemasangan kanopi & ramp', amount: '68000000' },
      { category: 'SUBCONTRACTOR' as any, description: 'Railing stainless ramp', amount: '92000000' },
    ],
  });
  await vos.submit(U.pm, vo1.id);
  await approveAll('VO', vo1.id);
  const vo2 = await vos.create(U.pm, P2, {
    title: 'Pekerjaan kurang: drainase sisi timur', description: 'Dikerjakan langsung oleh owner',
    contractChange: '-186000000',
    items: [{ category: 'SUBCONTRACTOR' as any, description: 'Drainase & paving sisi timur', amount: '-158000000' }],
  });
  await vos.submit(U.pm, vo2.id);

  // ── Penagihan owner (progress claim)
  const inv1 = await billing.create(U.fin, { projectId: P1, invoiceDate: iso(125), progressPct: '15', description: 'Termin 1 — progres 15%' });
  await billing.issue(U.fin, inv1.id);
  await billing.receive(U.fin, inv1.id, { receiptDate: iso(100), amount: inv1.total.toString() });
  const inv2 = await billing.create(U.fin, { projectId: P1, invoiceDate: iso(80), progressPct: '30', description: 'Termin 2 — progres 30%' });
  await billing.issue(U.fin, inv2.id);
  await billing.receive(U.fin, inv2.id, { receiptDate: iso(50), amount: inv2.total.toString() });
  const inv3 = await billing.create(U.fin, { projectId: P1, invoiceDate: iso(25), progressPct: '50', description: 'Termin 3 — progres 50%' });
  await billing.issue(U.fin, inv3.id);
  await billing.receive(U.fin, inv3.id, { receiptDate: iso(8), amount: inv3.total.mul(0.4).toDecimalPlaces(0).toString() });
  const inv4 = await billing.create(U.fin, { projectId: P2, invoiceDate: iso(70), progressPct: '20', description: 'Termin 1 — progres 20%' });
  await billing.issue(U.fin, inv4.id);
  await billing.receive(U.fin, inv4.id, { receiptDate: iso(35), amount: inv4.total.toString() });
  const inv5 = await billing.create(U.fin, { projectId: P2, invoiceDate: iso(48), progressPct: '35', description: 'Termin 2 — progres 35%', dueDate: iso(18) });
  await billing.issue(U.fin, inv5.id);
  await billing.create(U.fin, { projectId: P2, invoiceDate: iso(2), progressPct: '44', description: 'Termin 3 — progres 44%' });

  // ── Aset & alat
  const A = async (tag: string, name: string, category: string, cost: string, months: number, serial?: string) =>
    assets.create(U.asset, { assetTag: tag, name, category, acquisitionCost: cost, acquisitionDate: iso(months * 30), usefulLifeMonths: 96, serialNumber: serial });
  const a1 = await A('EXC-001', 'Excavator Komatsu PC200-8', 'Alat Berat', '1450000000', 30, 'KMT200-88421');
  const a2 = await A('EXC-002', 'Mini Excavator Kubota U55', 'Alat Berat', '780000000', 14, 'KBT55-10293');
  const a3 = await A('DT-001', 'Dump Truck Hino 500', 'Kendaraan', '920000000', 40, 'HN500-55120');
  const a4 = await A('GEN-001', 'Genset Cummins 150 kVA', 'Peralatan', '385000000', 22);
  const a5 = await A('CM-001', 'Concrete Mixer 0.5 m3', 'Peralatan', '48000000', 18);
  const a6 = await A('TS-001', 'Total Station Topcon GM-55', 'Survey', '165000000', 10, 'TPC-GM55-7781');
  await A('SC-001', 'Scaffolding set (200 frame)', 'Peralatan', '120000000', 26);
  await A('VB-001', 'Vibrator beton Mikasa', 'Peralatan', '9500000', 8);
  await assets.assign(U.asset, a1.id, { projectId: P2, custodian: 'Eko Saputra', notes: 'Pematangan lahan' });
  await assets.assign(U.asset, a3.id, { projectId: P2, custodian: 'Eko Saputra' });
  await assets.assign(U.asset, a4.id, { projectId: P1, custodian: 'Andi Wijaya' });
  await assets.assign(U.asset, a6.id, { projectId: P1 });
  await assets.assign(U.asset, a6.id, { projectId: P2, notes: 'Transfer untuk stake-out grid baja' });
  await assets.assign(U.asset, a5.id, { projectId: P1 });
  await assets.maintenance(U.asset, a2.id, { type: 'CORRECTIVE', description: 'Perbaikan pompa hidrolik', scheduledAt: iso(3), cost: '18500000' });
  await assets.maintenance(U.asset, a1.id, { type: 'PREVENTIVE', description: 'Service 2000 jam', scheduledAt: iso(-10), cost: '12000000' });

  // Notifikasi historis dianggap sudah dibaca; jalankan scan alert agar ada notifikasi terkini
  await pdb.notification.updateMany({ where: { tenantId: T }, data: { readAt: new Date() } });
  const { AlertService } = await import('../src/modules/notifications.module');
  await app.get(AlertService).scanTenant(T);

  await app.close();
  console.log('\n✅ Seed selesai.');
  console.log('   Perusahaan : demo');
  console.log(`   Password   : ${PASSWORD}`);
  console.log('   User       : ' + USERS.map((u) => u.email).join(', '));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
