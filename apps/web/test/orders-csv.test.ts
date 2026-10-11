import { describe, it, expect } from 'vitest';
import {
  buildCSV,
  parseCSV,
  normalizeDate,
  normalizeRate,
  buildImportPlan,
} from '../src/orders/csv';
import { mkOrder } from './order-fixture';

describe('parseCSV', () => {
  it('基础逗号切分', () => {
    expect(parseCSV('a,b,c\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('引号内逗号与换行不切分', () => {
    expect(parseCSV('a,"b,x\ny",c')).toEqual([['a', 'b,x\ny', 'c']]);
  });

  it('双引号转义', () => {
    expect(parseCSV('"a""b"')).toEqual([['a"b']]);
  });

  it('CRLF 行尾', () => {
    expect(parseCSV('a,b\r\nc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('跳过全空行（含只有逗号的行）', () => {
    expect(parseCSV('a,b\n,,\n\nc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('末尾无换行也能收尾', () => {
    expect(parseCSV('a,b\nc')).toEqual([
      ['a', 'b'],
      ['c'],
    ]);
  });
});

describe('buildCSV', () => {
  it('表头与旧版逐字一致（16 列）', () => {
    const firstLine = buildCSV([]).split('\n')[0];
    expect(firstLine).toBe(
      '序号,办理日期,结佣日期,姓名,手机号,省份,城市,运营商,套餐,时限,安装费,套餐费,佣金,佣金率,身份证号,地址',
    );
  });

  it('空列表只有表头一行', () => {
    expect(buildCSV([])).toBe(
      '序号,办理日期,结佣日期,姓名,手机号,省份,城市,运营商,套餐,时限,安装费,套餐费,佣金,佣金率,身份证号,地址',
    );
  });

  it('所有单元格都被引号包裹并转义内部引号', () => {
    const o = mkOrder({ name: '张"三"', address: '广东省广州市,天河区' });
    const csv = buildCSV([o]);
    const lines = csv.split('\n');
    expect(lines[1]).toContain('"张""三"""');
    expect(lines[1]).toContain('"广东省广州市,天河区"');
    // 值内的逗号不产生新列
    const parsed = parseCSV(csv);
    expect(parsed).toHaveLength(2);
    expect(parsed[1][3]).toBe('张"三"');
  });

  it('佣金率写成整数百分比；序号从 1 开始', () => {
    const o = mkOrder({ commissionRate: 0.345 });
    const parsed = parseCSV(buildCSV([o]));
    expect(parsed[1][0]).toBe('1');
    expect(parsed[1][13]).toBe('35%'); // 0.345 → 34.5 → 四舍五入 35
  });

  it('空结佣日期导出为空引号', () => {
    const o = mkOrder({ paybackDate: '' });
    const parsed = parseCSV(buildCSV([o]));
    expect(parsed[1][2]).toBe('');
  });
});

describe('normalizeDate', () => {
  it('多种分隔符', () => {
    expect(normalizeDate('2026/9/1')).toBe('2026-09-01');
    expect(normalizeDate('2026-9-1')).toBe('2026-09-01');
    expect(normalizeDate('2026.9.1')).toBe('2026-09-01');
  });

  it('带时分秒只取日期', () => {
    expect(normalizeDate('2026/09/01 12:30:00')).toBe('2026-09-01');
  });

  it('8 位数字', () => {
    expect(normalizeDate('20260901')).toBe('2026-09-01');
  });

  it('认不出返回空串', () => {
    expect(normalizeDate('九月一号')).toBe('');
    expect(normalizeDate('')).toBe('');
    expect(normalizeDate('26/9/1')).toBe('');
  });
});

describe('normalizeRate', () => {
  it('百分数写法（≥1 按百分数四舍五入取整）', () => {
    expect(normalizeRate('30')).toBe(0.3);
    expect(normalizeRate('30%')).toBe(0.3);
    expect(normalizeRate('35.6%')).toBe(0.36); // Math.round(35.6)/100
  });

  it('已是小数', () => {
    expect(normalizeRate('0.3')).toBe(0.3);
  });

  it('非法值返回 0', () => {
    expect(normalizeRate('abc')).toBe(0);
    expect(normalizeRate('')).toBe(0);
    expect(normalizeRate('-5')).toBe(0);
  });
});

describe('buildImportPlan', () => {
  it('标准表头：字段映射与数值转换', () => {
    const table = [
      ['姓名', '手机号', '办理日期', '运营商', '套餐', '套餐费', '佣金', '佣金率'],
      ['张三', '17365306527', '2026-09-01', '联通', '300m', '600', '300', '30%'],
    ];
    const plan = buildImportPlan(table, []);
    expect(plan.error).toBeUndefined();
    expect(plan.rows).toHaveLength(1);
    const r = plan.rows[0];
    expect(r.name).toBe('张三');
    expect(r.phone).toBe('17365306527');
    expect(r.apply_date).toBe('2026-09-01');
    expect(r.package_fee).toBe(600);
    expect(r.commission).toBe(300);
    expect(r.commission_rate).toBe(0.3);
    expect(r.sales_person).toBe('');
  });

  it('预览行 7 列且最多 5 行', () => {
    const header = ['姓名', '手机号', '办理日期'];
    const table = [
      header,
      ...Array.from({ length: 8 }, (_, i) => ['用户' + i, '1390000000' + i, '2026-09-01']),
    ];
    const plan = buildImportPlan(table, []);
    expect(plan.preview).toHaveLength(5);
    expect(plan.rows).toHaveLength(8);
    expect(plan.preview[0]).toEqual(['用户0', '13900000000', '2026-09-01', '—', '—', '0', '']);
  });

  it('手机号剥掉空格与横线', () => {
    const table = [['姓名', '手机号'], ['张三', '173-6530 6527']];
    const plan = buildImportPlan(table, []);
    expect(plan.rows[0].phone).toBe('17365306527');
  });

  it('「序号」等未映射列名被报告', () => {
    const table = [
      ['序号', '姓名', '手机号', '办理日期'],
      ['1', '张三', '17365306527', '2026-09-01'],
    ];
    const plan = buildImportPlan(table, []);
    expect(plan.error).toBeUndefined();
    expect(plan.unmapped).toEqual(['序号']);
    expect(plan.rows).toHaveLength(1);
  });

  it('缺「姓名」或「手机号」表头 → error', () => {
    const noName = buildImportPlan([['手机号', '办理日期'], ['17365306527', '2026-09-01']], []);
    expect(noName.error).toContain('姓名');
    const noPhone = buildImportPlan([['姓名', '办理日期'], ['张三', '2026-09-01']], []);
    expect(noPhone.error).toContain('手机号');
  });

  it('表或数据行整体为空 → error', () => {
    expect(buildImportPlan([['姓名']], []).error).toContain('没有数据行');
    expect(buildImportPlan([], []).error).toContain('没有数据行');
  });

  it('缺姓名或手机号的数据行计入 invalid', () => {
    const table = [
      ['姓名', '手机号'],
      ['', '17365306527'],
      ['李四', ''],
      ['王五', '17365306528'],
    ];
    const plan = buildImportPlan(table, []);
    expect(plan.invalid).toBe(2);
    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0].name).toBe('王五');
  });

  it('与库内 手机号+办理日期 重复 → skipped', () => {
    const db = [mkOrder({ phone: '17365306527', applyDate: '2026-09-01' })];
    const table = [['姓名', '手机号', '办理日期'], ['张三', '17365306527', '2026-09-01']];
    const plan = buildImportPlan(table, db);
    expect(plan.skipped).toBe(1);
    expect(plan.rows).toHaveLength(0);
  });

  it('同手机号不同日期算两笔，不跳过', () => {
    const db = [mkOrder({ phone: '17365306527', applyDate: '2026-09-01' })];
    const table = [['姓名', '手机号', '办理日期'], ['张三', '17365306527', '2026-09-15']];
    const plan = buildImportPlan(table, db);
    expect(plan.skipped).toBe(0);
    expect(plan.rows).toHaveLength(1);
  });

  it('文件内前文重复也跳过（不止查库）', () => {
    const table = [
      ['姓名', '手机号', '办理日期'],
      ['张三', '17365306527', '2026-09-01'],
      ['李四', '17365306527', '2026-09-01'],
    ];
    const plan = buildImportPlan(table, []);
    expect(plan.skipped).toBe(1);
    expect(plan.rows).toHaveLength(1);
  });
});
