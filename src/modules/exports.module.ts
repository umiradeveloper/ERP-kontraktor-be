import { Controller, ForbiddenException, Get, Injectable, Module, NotFoundException, Param, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser, CurrentUser, hasPerm } from '../common/auth';
import { AuditService, notFound } from '../common/common.service';
import { AccountingModule, AccountingService } from './accounting.module';
import { BillingModule, BillingService } from './billing.module';
import { InventoryModule, InventoryService } from './inventory.module';
import { ProcurementModule, ProcurementService } from './procurement.module';
import { ProjectsModule, ProjectsService } from './projects.module';

type Col = { header: string; key: string; width?: number; money?: boolean; num?: boolean; date?: boolean };
const n = (v: any) => (v === null || v === undefined ? null : Number(v));
const CAT: Record<string, string> = { MATERIAL: 'Material', LABOR: 'Upah', EQUIPMENT: 'Alat', SUBCONTRACTOR: 'Subkon', OVERHEAD: 'Overhead', TAX: 'Pajak', OTHER: 'Lain-lain' };
const STATUS: Record<string, string> = {
  SETUP: 'Setup', ACTIVE: 'Berjalan', ON_HOLD: 'Ditunda', COMPLETION: 'Serah terima', CLOSED: 'Selesai', CANCELLED: 'Batal',
  OK: 'Aman', WARNING: '≥80% budget', OVER: 'Lewat budget',
};
const idr = (v: any) => 'Rp ' + Math.round(Number(v ?? 0)).toLocaleString('id-ID');
const tgl = (d?: Date | null) => (d ? new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'long', year: 'numeric' }).format(d) : '-');

/** Report yang tersedia + permission yang dibutuhkan (PRD §5.14, acceptance #11) */
const REPORTS: Record<string, { title: string; perm: string[] }> = {
  projects: { title: 'Daftar Proyek', perm: ['project:read'] },
  'cost-control': { title: 'Cost Control Proyek', perm: ['cost:read'] },
  'ar-aging': { title: 'Umur Piutang', perm: ['finance:read'] },
  'ap-aging': { title: 'Umur Hutang', perm: ['finance:read'] },
  'trial-balance': { title: 'Neraca Saldo', perm: ['accounting:read'] },
  journals: { title: 'Jurnal Umum', perm: ['accounting:read'] },
  stock: { title: 'Posisi Stok', perm: ['warehouse:read', 'procurement:read'] },
  assets: { title: 'Register Aset', perm: ['asset:read'] },
};

@Injectable()
export class ExportsService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private projects: ProjectsService,
    private billing: BillingService,
    private procurement: ProcurementService,
    private accounting: AccountingService,
    private inventory: InventoryService,
  ) {}

  private check(u: AuthUser, perms: string[]) {
    if (!perms.some((p) => hasPerm(u, p))) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Anda tidak memiliki akses ke laporan ini' });
  }

  private async workbook(u: AuthUser, title: string, cols: Col[], rows: any[], totals?: Record<string, number>) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: u.tenantId } });
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Kontrak ERP';
    const ws = wb.addWorksheet(title.slice(0, 30), { views: [{ state: 'frozen', ySplit: 4 }] });
    ws.mergeCells(1, 1, 1, cols.length);
    ws.getCell(1, 1).value = title;
    ws.getCell(1, 1).font = { bold: true, size: 14 };
    ws.mergeCells(2, 1, 2, cols.length);
    ws.getCell(2, 1).value = `${tenant?.name ?? ''} — dicetak ${new Date().toLocaleString('id-ID')} oleh ${u.name}`;
    ws.getCell(2, 1).font = { color: { argb: 'FF6A756F' }, size: 9 };
    const header = ws.getRow(4);
    cols.forEach((c, i) => {
      const cell = header.getCell(i + 1);
      cell.value = c.header;
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1B2420' } };
      cell.alignment = { vertical: 'middle', horizontal: c.money || c.num ? 'right' : 'left' };
      ws.getColumn(i + 1).width = c.width ?? (c.money ? 18 : 16);
      if (c.money) ws.getColumn(i + 1).numFmt = '#,##0;[Red]-#,##0';
      if (c.num) ws.getColumn(i + 1).numFmt = '#,##0.##';
      if (c.date) ws.getColumn(i + 1).numFmt = 'dd/mm/yyyy';
    });
    header.height = 20;
    rows.forEach((r) => ws.addRow(cols.map((c) => r[c.key] ?? null)));
    if (totals) {
      const tr = ws.addRow(cols.map((c, i) => (i === 0 ? 'Total' : totals[c.key] ?? null)));
      tr.font = { bold: true };
      tr.eachCell((cell) => (cell.border = { top: { style: 'thin' } }));
    }
    ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: cols.length } };
    return wb;
  }

  async excel(u: AuthUser, name: string, q: { projectId?: string }) {
    const r = REPORTS[name];
    if (!r && name !== 'bq') throw new NotFoundException({ code: 'NOT_FOUND', message: 'Laporan tidak dikenal' });
    let wb: ExcelJS.Workbook;
    let title = r?.title ?? 'Bill of Quantity';

    switch (name) {
      case 'projects': {
        this.check(u, r.perm);
        const rows = (await this.projects.list(u)).map((p) => ({
          code: p.code, name: p.name, owner: p.ownerName, status: STATUS[p.status], start: p.startDate, end: p.endDate,
          contract: n(p.contractValue), progress: n(p.progressPct), planned: n(p.plannedPct), billed: n(p.billed), margin: n(p.forecastMargin),
        }));
        wb = await this.workbook(u, title, [
          { header: 'Kode', key: 'code', width: 16 }, { header: 'Proyek', key: 'name', width: 42 }, { header: 'Owner', key: 'owner', width: 28 },
          { header: 'Status', key: 'status', width: 12 }, { header: 'Mulai', key: 'start', date: true, width: 12 }, { header: 'Selesai', key: 'end', date: true, width: 12 },
          { header: 'Nilai kontrak', key: 'contract', money: true }, { header: 'Progres (%)', key: 'progress', num: true, width: 11 },
          { header: 'Rencana (%)', key: 'planned', num: true, width: 11 }, { header: 'Ditagih', key: 'billed', money: true }, { header: 'Forecast margin', key: 'margin', money: true },
        ], rows, { contract: rows.reduce((a, x) => a + (x.contract ?? 0), 0), billed: rows.reduce((a, x) => a + (x.billed ?? 0), 0) });
        break;
      }
      case 'cost-control': {
        this.check(u, r.perm);
        const rows = (await this.projects.costPortfolio(u)).map((p) => ({
          code: p.code, name: p.name, budget: n(p.cost.budget), commitment: n(p.cost.commitment), actual: n(p.cost.actual),
          etc: n(p.cost.etc), eac: n(p.cost.eac), variance: n(p.cost.variance), used: Number(p.cost.usedPct.toFixed(1)), alert: STATUS[p.cost.alert],
        }));
        const sum = (k: string) => rows.reduce((a, x: any) => a + (x[k] ?? 0), 0);
        wb = await this.workbook(u, title, [
          { header: 'Kode', key: 'code', width: 16 }, { header: 'Proyek', key: 'name', width: 42 }, { header: 'Budget', key: 'budget', money: true },
          { header: 'Commitment', key: 'commitment', money: true }, { header: 'Actual', key: 'actual', money: true }, { header: 'ETC', key: 'etc', money: true },
          { header: 'EAC', key: 'eac', money: true }, { header: 'Varian', key: 'variance', money: true }, { header: 'Terpakai (%)', key: 'used', num: true, width: 12 },
          { header: 'Status', key: 'alert', width: 14 },
        ], rows, { budget: sum('budget'), commitment: sum('commitment'), actual: sum('actual'), etc: sum('etc'), eac: sum('eac'), variance: sum('variance') });
        break;
      }
      case 'ar-aging':
      case 'ap-aging': {
        this.check(u, r.perm);
        const data = name === 'ar-aging' ? await this.billing.arAging(u) : await this.procurement.apAging(u);
        const label: Record<string, string> = { current: 'Belum jatuh tempo', d1_30: '1–30 hari', d31_60: '31–60 hari', d61_90: '61–90 hari', d90p: '> 90 hari' };
        const rows = data.items.map((i: any) => ({ number: i.number, party: i.party, project: i.project, ref: i.ref, due: i.dueDate, total: n(i.total), balance: n(i.balance), days: i.overdueDays, bucket: label[i.bucket] }));
        wb = await this.workbook(u, title, [
          { header: 'Nomor', key: 'number', width: 16 }, { header: name === 'ar-aging' ? 'Owner' : 'Supplier', key: 'party', width: 32 },
          { header: 'Proyek', key: 'project', width: 14 }, { header: 'Referensi', key: 'ref', width: 26 }, { header: 'Jatuh tempo', key: 'due', date: true, width: 12 },
          { header: 'Total', key: 'total', money: true }, { header: 'Sisa', key: 'balance', money: true }, { header: 'Hari lewat', key: 'days', num: true, width: 10 },
          { header: 'Kelompok umur', key: 'bucket', width: 18 },
        ], rows, { balance: rows.reduce((a: number, x: any) => a + (x.balance ?? 0), 0) });
        break;
      }
      case 'trial-balance': {
        this.check(u, r.perm);
        const tb = await this.accounting.trialBalance(u);
        const rows = tb.rows.map((x) => ({ code: x.code, name: x.name, type: x.accountType, debit: n(x.debit), credit: n(x.credit), bd: n(x.balanceDebit) || null, bc: n(x.balanceCredit) || null }));
        wb = await this.workbook(u, title, [
          { header: 'Kode', key: 'code', width: 10 }, { header: 'Akun', key: 'name', width: 32 }, { header: 'Tipe', key: 'type', width: 12 },
          { header: 'Mutasi debit', key: 'debit', money: true }, { header: 'Mutasi kredit', key: 'credit', money: true },
          { header: 'Saldo debit', key: 'bd', money: true }, { header: 'Saldo kredit', key: 'bc', money: true },
        ], rows, { bd: n(tb.totalDebit)!, bc: n(tb.totalCredit)! });
        break;
      }
      case 'journals': {
        this.check(u, r.perm);
        const lines = await this.prisma.journalLine.findMany({
          where: { tenantId: u.tenantId, journal: { status: { in: ['POSTED', 'REVERSED'] } } },
          include: { journal: true, account: true },
          orderBy: [{ journal: { entryDate: 'asc' } }, { journal: { number: 'asc' } }],
          take: 20000,
        });
        const rows = lines.map((l) => ({ date: l.journal.entryDate, number: l.journal.number, desc: l.journal.description, code: l.account.code, account: l.account.name, debit: n(l.debit) || null, credit: n(l.credit) || null, status: l.journal.status }));
        wb = await this.workbook(u, title, [
          { header: 'Tanggal', key: 'date', date: true, width: 12 }, { header: 'Nomor', key: 'number', width: 16 }, { header: 'Keterangan', key: 'desc', width: 44 },
          { header: 'Kode', key: 'code', width: 8 }, { header: 'Akun', key: 'account', width: 26 }, { header: 'Debit', key: 'debit', money: true },
          { header: 'Kredit', key: 'credit', money: true }, { header: 'Status', key: 'status', width: 10 },
        ], rows);
        break;
      }
      case 'stock': {
        this.check(u, r.perm);
        const rows = (await this.inventory.stock(u)).map((s) => ({ wh: s.warehouse.code, code: s.item.code, name: s.item.name, unit: s.item.unit, qty: n(s.quantity), min: n(s.item.minStock), avg: n(s.avgCost), value: n(s.value) }));
        wb = await this.workbook(u, title, [
          { header: 'Gudang', key: 'wh', width: 14 }, { header: 'Kode', key: 'code', width: 12 }, { header: 'Item', key: 'name', width: 36 }, { header: 'Satuan', key: 'unit', width: 8 },
          { header: 'Qty', key: 'qty', num: true, width: 12 }, { header: 'Minimum', key: 'min', num: true, width: 10 }, { header: 'Harga rata-rata', key: 'avg', money: true }, { header: 'Nilai', key: 'value', money: true },
        ], rows, { value: rows.reduce((a, x) => a + (x.value ?? 0), 0) });
        break;
      }
      case 'assets': {
        this.check(u, r.perm);
        const rows = (await this.prisma.asset.findMany({ where: { tenantId: u.tenantId }, orderBy: { assetTag: 'asc' } })).map((a) => ({ tag: a.assetTag, name: a.name, cat: a.category, sn: a.serialNumber, status: a.status, loc: a.location, cost: n(a.acquisitionCost), date: a.acquisitionDate }));
        wb = await this.workbook(u, title, [
          { header: 'Tag', key: 'tag', width: 12 }, { header: 'Nama', key: 'name', width: 34 }, { header: 'Kategori', key: 'cat', width: 14 }, { header: 'No. seri', key: 'sn', width: 18 },
          { header: 'Status', key: 'status', width: 14 }, { header: 'Lokasi', key: 'loc', width: 28 }, { header: 'Harga perolehan', key: 'cost', money: true }, { header: 'Tgl perolehan', key: 'date', date: true, width: 13 },
        ], rows);
        break;
      }
      default: {
        // bq
        this.check(u, ['project:read', 'tender:read']);
        const p = notFound(await this.prisma.project.findFirst({ where: { id: q.projectId ?? '', tenantId: u.tenantId } }), 'Proyek');
        title = `BQ ${p.code}`;
        const items = await this.projects.bq(u, p.id);
        const rows = items.map((i) => ({ section: i.section, code: i.code, desc: i.description, unit: i.unit, cat: CAT[i.category], qty: n(i.quantity), price: n(i.unitPrice), amount: n(i.amount) }));
        wb = await this.workbook(u, `Bill of Quantity — ${p.name}`, [
          { header: 'Bagian', key: 'section', width: 26 }, { header: 'Kode', key: 'code', width: 8 }, { header: 'Uraian', key: 'desc', width: 40 }, { header: 'Sat.', key: 'unit', width: 8 },
          { header: 'Kategori', key: 'cat', width: 12 }, { header: 'Volume', key: 'qty', num: true, width: 12 }, { header: 'Harga satuan', key: 'price', money: true }, { header: 'Jumlah', key: 'amount', money: true },
        ], rows, { amount: rows.reduce((a, x) => a + (x.amount ?? 0), 0) });
      }
    }
    await this.audit.log(u, 'EXPORT', 'Report', name, { format: 'xlsx', projectId: q.projectId });
    return { buffer: Buffer.from(await wb!.xlsx.writeBuffer()), fileName: `${title.replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-')}-${new Date().toISOString().slice(0, 10)}.xlsx` };
  }

  // ───────── PDF dokumen ─────────

  private pdfShell(companyName: string, companyAddr: string | null, docTitle: string, number: string) {
    const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `${docTitle} ${number}` } });
    doc.rect(48, 48, 6, 34).fill('#F2B705');
    doc.fillColor('#1B2420').font('Helvetica-Bold').fontSize(14).text(companyName, 62, 50);
    doc.font('Helvetica').fontSize(8).fillColor('#6A756F').text(companyAddr ?? '', 62, 68, { width: 260 });
    doc.font('Helvetica-Bold').fontSize(18).fillColor('#1B2420').text(docTitle, 300, 48, { width: 247, align: 'right' });
    doc.font('Helvetica').fontSize(10).fillColor('#3A4540').text(number, 300, 72, { width: 247, align: 'right' });
    doc.moveTo(48, 100).lineTo(547, 100).lineWidth(0.5).strokeColor('#CDD2CB').stroke();
    return doc;
  }

  private table(doc: PDFKit.PDFDocument, y: number, cols: { h: string; w: number; right?: boolean }[], rows: string[][]) {
    const x0 = 48;
    const drawHeader = (yy: number) => {
      doc.rect(x0, yy, 499, 18).fill('#1B2420');
      let x = x0;
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#FFFFFF');
      cols.forEach((c) => { doc.text(c.h, x + 4, yy + 5, { width: c.w - 8, align: c.right ? 'right' : 'left' }); x += c.w; });
      return yy + 18;
    };
    y = drawHeader(y);
    doc.font('Helvetica').fontSize(8.5).fillColor('#1B2420');
    for (const r of rows) {
      const h = Math.max(...r.map((t, i) => doc.heightOfString(t, { width: cols[i].w - 8 }))) + 8;
      if (y + h > 760) { doc.addPage(); y = drawHeader(48); doc.font('Helvetica').fontSize(8.5).fillColor('#1B2420'); }
      let x = x0;
      r.forEach((t, i) => { doc.text(t, x + 4, y + 4, { width: cols[i].w - 8, align: cols[i].right ? 'right' : 'left' }); x += cols[i].w; });
      y += h;
      doc.moveTo(x0, y).lineTo(547, y).lineWidth(0.3).strokeColor('#E1E4DF').stroke();
    }
    return y;
  }

  private totals(doc: PDFKit.PDFDocument, y: number, lines: [string, string, boolean?][]) {
    y += 8;
    for (const [k, v, bold] of lines) {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 10.5 : 9).fillColor('#1B2420');
      doc.text(k, 320, y, { width: 120, align: 'right' });
      doc.text(v, 445, y, { width: 102, align: 'right' });
      y += bold ? 18 : 14;
    }
    return y;
  }

  private signatures(doc: PDFKit.PDFDocument, y: number, labels: string[]) {
    if (y > 650) { doc.addPage(); y = 60; }
    y += 30;
    const w = 499 / labels.length;
    labels.forEach((l, i) => {
      const x = 48 + i * w;
      doc.font('Helvetica').fontSize(8.5).fillColor('#6A756F').text(l, x, y, { width: w - 20, align: 'center' });
      doc.moveTo(x + 15, y + 70).lineTo(x + w - 35, y + 70).lineWidth(0.5).strokeColor('#98A19C').stroke();
    });
  }

  private toBuffer(doc: PDFKit.PDFDocument): Promise<Buffer> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.end();
    });
  }

  async poPdf(u: AuthUser, id: string) {
    this.check(u, ['procurement:read']);
    const po = notFound(await this.prisma.purchaseOrder.findFirst({ where: { id, tenantId: u.tenantId }, include: { items: true, supplier: true, project: { include: { company: true } } } }), 'PO');
    const doc = this.pdfShell(po.project.company.name, po.project.company.address, 'PURCHASE ORDER', po.number);
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#6A756F').text('KEPADA', 48, 116).text('DETAIL', 320, 116);
    doc.font('Helvetica').fontSize(9.5).fillColor('#1B2420')
      .text(po.supplier.name, 48, 130, { width: 250 }).fontSize(8.5).fillColor('#3A4540')
      .text([po.supplier.email, po.supplier.phone, po.supplier.taxNumber ? `NPWP ${po.supplier.taxNumber}` : null].filter(Boolean).join('\n'), { width: 250 });
    const meta: [string, string][] = [['Tanggal', tgl(po.orderDate)], ['Proyek', `${po.project.code} — ${po.project.name}`], ['Tanggal kirim', tgl(po.deliveryDate)], ['Alamat kirim', po.deliveryAddress ?? '-'], ['Termin', `${po.supplier.paymentTerm} hari`]];
    let my = 130;
    for (const [k, v] of meta) {
      doc.font('Helvetica').fontSize(8.5).fillColor('#6A756F').text(k, 320, my, { width: 70 });
      doc.fillColor('#1B2420').text(v, 390, my, { width: 157 });
      my = doc.y + 3;
    }
    let y = this.table(doc, Math.max(my, doc.y) + 16, [
      { h: 'No', w: 26 }, { h: 'Uraian', w: 205 }, { h: 'Volume', w: 60, right: true }, { h: 'Sat.', w: 38 }, { h: 'Harga satuan', w: 80, right: true }, { h: 'Jumlah', w: 90, right: true },
    ], po.items.map((i, idx) => [String(idx + 1), i.description, Number(i.quantity).toLocaleString('id-ID'), i.unit ?? '', idr(i.unitPrice), idr(i.amount)]));
    y = this.totals(doc, y, [['Subtotal', idr(po.subtotal)], [`PPN ${Number(po.taxPct)}%`, idr(po.taxAmount)], ['Total', idr(po.total), true]]);
    if (po.terms) {
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#6A756F').text('SYARAT & KETENTUAN', 48, y + 6);
      doc.font('Helvetica').fontSize(8.5).fillColor('#3A4540').text(po.terms, 48, doc.y + 3, { width: 499 });
      y = doc.y;
    }
    this.signatures(doc, y, ['Dibuat oleh,\nProcurement', 'Disetujui oleh,\nProject Manager', 'Diterima oleh,\nSupplier']);
    await this.audit.log(u, 'EXPORT', 'PurchaseOrder', id, { format: 'pdf' });
    return { buffer: await this.toBuffer(doc), fileName: `${po.number}.pdf` };
  }

  async invoicePdf(u: AuthUser, id: string) {
    this.check(u, ['finance:read']);
    const inv = notFound(await this.prisma.customerInvoice.findFirst({ where: { id, tenantId: u.tenantId }, include: { project: { include: { company: true, customer: true } } } }), 'Invoice');
    const c = inv.project.company;
    const doc = this.pdfShell(c.name, [c.address, c.npwp ? `NPWP ${c.npwp}` : null].filter(Boolean).join('\n'), 'INVOICE', inv.number);
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#6A756F').text('DITAGIHKAN KEPADA', 48, 116).text('DETAIL', 320, 116);
    doc.font('Helvetica').fontSize(9.5).fillColor('#1B2420').text(inv.project.customer?.name ?? inv.project.ownerName ?? '-', 48, 130, { width: 250 });
    doc.fontSize(8.5).fillColor('#3A4540').text([inv.project.customer?.address, inv.project.customer?.npwp ? `NPWP ${inv.project.customer.npwp}` : null].filter(Boolean).join('\n'), { width: 250 });
    let my = 130;
    for (const [k, v] of [['Tanggal', tgl(inv.invoiceDate)], ['Jatuh tempo', tgl(inv.dueDate)], ['Proyek', `${inv.project.code} — ${inv.project.name}`], ['Nilai kontrak', idr(inv.project.contractValue)]] as [string, string][]) {
      doc.font('Helvetica').fontSize(8.5).fillColor('#6A756F').text(k, 320, my, { width: 70 });
      doc.fillColor('#1B2420').text(v, 390, my, { width: 157 });
      my = doc.y + 3;
    }
    let y = this.table(doc, Math.max(my, doc.y) + 16, [{ h: 'Uraian', w: 329 }, { h: 'Progres kumulatif', w: 80, right: true }, { h: 'Jumlah', w: 90, right: true }], [
      [inv.description ?? 'Tagihan progres pekerjaan', `${Number(inv.progressPct)}%`, idr(inv.grossAmount)],
    ]);
    y = this.totals(doc, y, [
      ['Nilai progres', idr(inv.grossAmount)], [`Retensi ${Number(inv.project.retentionPct)}%`, '- ' + idr(inv.retentionAmount)], ['PPN', idr(inv.taxAmount)], ['Total tagihan', idr(inv.total), true],
      ...(Number(inv.paidAmount) > 0 ? ([['Sudah dibayar', '- ' + idr(inv.paidAmount)], ['Sisa', idr(Number(inv.total) - Number(inv.paidAmount)), true]] as [string, string, boolean?][]) : []),
    ]);
    doc.font('Helvetica').fontSize(8.5).fillColor('#3A4540').text('Pembayaran mohon ditransfer ke rekening perusahaan dengan mencantumkan nomor invoice.', 48, y + 10, { width: 499 });
    this.signatures(doc, doc.y, ['Hormat kami,\nFinance']);
    await this.audit.log(u, 'EXPORT', 'CustomerInvoice', id, { format: 'pdf' });
    return { buffer: await this.toBuffer(doc), fileName: `${inv.number}.pdf` };
  }
}

@ApiTags('Exports')
@Controller()
export class ExportsController {
  constructor(private svc: ExportsService) {}

  private send(res: Response, f: { buffer: Buffer; fileName: string }, type: string) {
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Disposition', `attachment; filename="${f.fileName}"`);
    res.send(f.buffer);
  }

  @Get('exports/:name.xlsx')
  async excel(@CurrentUser() u: AuthUser, @Param('name') name: string, @Query('projectId') projectId: string | undefined, @Res() res: Response) {
    this.send(res, await this.svc.excel(u, name, { projectId }), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  }

  @Get('documents/purchase-orders/:id.pdf')
  async po(@CurrentUser() u: AuthUser, @Param('id') id: string, @Res() res: Response) {
    this.send(res, await this.svc.poPdf(u, id), 'application/pdf');
  }

  @Get('documents/customer-invoices/:id.pdf')
  async inv(@CurrentUser() u: AuthUser, @Param('id') id: string, @Res() res: Response) {
    this.send(res, await this.svc.invoicePdf(u, id), 'application/pdf');
  }
}

@Module({
  imports: [ProjectsModule, BillingModule, ProcurementModule, AccountingModule, InventoryModule],
  controllers: [ExportsController],
  providers: [ExportsService],
})
export class ExportsModule {}
