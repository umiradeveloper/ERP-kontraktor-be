/**
 * Unit test aturan bisnis inti (PRD §19): kalkulasi estimator, cost control tanpa double count,
 * umur piutang/hutang, validasi jurnal, dan presisi desimal.
 */
import { Prisma } from '@prisma/client';
import { calcTender } from './modules/tenders.module';
import { CostService } from './modules/projects.module';
import { aging } from './modules/procurement.module';
import { validateJournalLines } from './modules/accounting.module';

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

describe('Estimator tender', () => {
  const t = { overheadPct: D(5), contingencyPct: D(3), profitPct: D(10), taxPct: D(11) };

  it('menghitung overhead, contingency, profit dan PPN berjenjang', () => {
    const r = calcTender(t, [
      { amount: D('600000000'), category: 'MATERIAL' },
      { amount: D('400000000'), category: 'LABOR' },
    ]);
    expect(r.directCost.toString()).toBe('1000000000');
    expect(r.overhead.toString()).toBe('50000000');
    expect(r.contingency.toString()).toBe('30000000');
    // profit dihitung dari (biaya langsung + overhead + contingency)
    expect(r.profit.toString()).toBe('108000000');
    expect(r.subtotal.toString()).toBe('1188000000');
    expect(r.tax.toString()).toBe('130680000');
    expect(r.grandTotal.toString()).toBe('1318680000');
    expect(r.byCategory.MATERIAL.toString()).toBe('600000000');
  });

  it('BQ kosong menghasilkan nol, bukan NaN', () => {
    const r = calcTender(t, []);
    expect(r.grandTotal.toString()).toBe('0');
  });

  it('pembulatan uang 2 desimal, tanpa error floating point', () => {
    const r = calcTender({ ...t, overheadPct: D('3.333') }, [{ amount: D('0.10'), category: 'OTHER' }, { amount: D('0.20'), category: 'OTHER' }]);
    expect(r.directCost.toString()).toBe('0.3'); // 0.1 + 0.2 tepat 0.3
    expect(r.overhead.decimalPlaces()).toBeLessThanOrEqual(2);
  });
});

describe('Cost control', () => {
  const svc = new CostService(null as any);
  const Z = D(0);

  it('EAC = actual + commitment + sisa budget, varian nol bila masih di dalam budget', () => {
    const { rows, total } = svc.summarize({ MATERIAL: { budget: D(1000), commitment: D(300), actual: D(200) } });
    const m = rows.find((r) => r.category === 'MATERIAL')!;
    expect(m.etc.toString()).toBe('500');
    expect(m.eac.toString()).toBe('1000');
    expect(m.variance.toString()).toBe('0');
    expect(m.usedPct).toBe(50);
    expect(total.alert).toBe('OK');
  });

  it('overrun menghasilkan varian negatif dan alert OVER', () => {
    const { rows } = svc.summarize({ LABOR: { budget: D(100), commitment: D(40), actual: D(90) } });
    const l = rows.find((r) => r.category === 'LABOR')!;
    expect(l.eac.toString()).toBe('130');
    expect(l.variance.toString()).toBe('-30');
    expect(l.alert).toBe('OVER');
  });

  it('alert WARNING mulai 80%', () => {
    const { total } = svc.summarize({ MATERIAL: { budget: D(100), commitment: D(30), actual: D(50) } });
    expect(total.alert).toBe('WARNING');
  });

  it('perpindahan commitment → actual tidak mengubah EAC (tanpa double count)', () => {
    const before = svc.summarize({ MATERIAL: { budget: D(1000), commitment: D(400), actual: D(100) } }).total;
    // invoice 300 diposting: commitment turun 300, actual naik 300
    const after = svc.summarize({ MATERIAL: { budget: D(1000), commitment: D(100), actual: D(400) } }).total;
    expect(after.eac.toString()).toBe(before.eac.toString());
    expect(after.actual.plus(after.commitment).toString()).toBe(before.actual.plus(before.commitment).toString());
  });

  it('kategori tanpa data tetap ada dengan nilai nol', () => {
    const { rows } = svc.summarize({});
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.eac.eq(Z))).toBe(true);
  });
});

describe('Umur piutang / hutang', () => {
  const day = 86400_000;
  it('mengelompokkan saldo berdasarkan hari lewat jatuh tempo', () => {
    const now = Date.now();
    const r = aging([
      { dueDate: new Date(now + 5 * day), balance: D(100) },
      { dueDate: new Date(now - 10 * day), balance: D(200) },
      { dueDate: new Date(now - 45 * day), balance: D(300) },
      { dueDate: new Date(now - 75 * day), balance: D(400) },
      { dueDate: new Date(now - 120 * day), balance: D(500) },
    ]);
    expect(r.buckets.current.toString()).toBe('100');
    expect(r.buckets.d1_30.toString()).toBe('200');
    expect(r.buckets.d31_60.toString()).toBe('300');
    expect(r.buckets.d61_90.toString()).toBe('400');
    expect(r.buckets.d90p.toString()).toBe('500');
    expect(r.total.toString()).toBe('1500');
    expect(r.items[2].overdueDays).toBe(45);
  });
});

describe('Validasi jurnal manual', () => {
  it('menerima jurnal balance', () => {
    expect(validateJournalLines([{ debit: '1000000', credit: '0' }, { debit: '0', credit: '1000000' }]).toString()).toBe('1000000');
  });
  it('menolak jurnal tidak balance', () => {
    expect(() => validateJournalLines([{ debit: '1000', credit: '0' }, { debit: '0', credit: '999.99' }])).toThrow(/tidak balance/);
  });
  it('menolak baris dua sisi, nol, atau negatif', () => {
    expect(() => validateJournalLines([{ debit: '10', credit: '10' }, { debit: '0', credit: '0' }])).toThrow(/hanya boleh debit atau kredit/);
    expect(() => validateJournalLines([{ debit: '0', credit: '0' }, { debit: '0', credit: '0' }])).toThrow(/nol/);
    expect(() => validateJournalLines([{ debit: '-5', credit: '0' }, { debit: '0', credit: '-5' }])).toThrow(/negatif/);
  });
  it('balance dihitung dengan desimal tepat (0.1 + 0.2 = 0.3)', () => {
    expect(() => validateJournalLines([{ debit: '0.1', credit: '0' }, { debit: '0.2', credit: '0' }, { debit: '0', credit: '0.3' }])).not.toThrow();
  });
});
