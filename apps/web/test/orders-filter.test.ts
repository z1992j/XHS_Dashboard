/**
 * 筛选/排序纯函数测试。覆盖：排除自身维度、月份前缀匹配、
 * payback 子集、sortOrders 不改原数组且稳定、q 命中字段。
 */
import { describe, it, expect } from 'vitest';
import { selectOrders, sortOrders, getFilteredOrders, activeFilterCount, scopeText } from '../src/orders/filter';
import { EMPTY_FILTERS } from '../src/orders/types';
import type { Filters } from '../src/orders/types';
import { mkOrder } from './order-fixture';

const f = (over: Partial<Filters> = {}): Filters => ({ ...EMPTY_FILTERS, ...over });

describe('selectOrders — q 命中字段', () => {
  const orders = [
    mkOrder({ name: '张三', phone: '13800000001', city: '广州', package: '300m', province: '广东', carrier: '联通' }),
    mkOrder({ name: '李四', phone: '13800000002', city: '深圳', package: '1000M', province: '广东', carrier: '移动' }),
  ];

  it('命中姓名 / 手机号 / 城市 / 套餐 / 省份 / 运营商（大小写不敏感）', () => {
    const cases: [string, number][] = [
      ['张三', 1], ['13800000002', 1], ['深圳', 1], ['1000m', 1], ['1000M', 1], ['广东', 2], ['移动', 1],
    ];
    for (const [q, n] of cases) {
      expect(selectOrders(orders, f({ q })).length, q).toBe(n);
    }
  });

  it('q 先 trim 再匹配；空 q 不过滤', () => {
    expect(selectOrders(orders, f({ q: ' 张三 ' })).length).toBe(1);
    expect(selectOrders(orders, f({ q: '' })).length).toBe(2);
  });
});

describe('selectOrders — 精确维度与月份前缀', () => {
  const orders = [
    mkOrder({ province: '广东', city: '广州', carrier: '联通', applyDate: '2026-08-15' }),
    mkOrder({ province: '广东', city: '深圳', carrier: '移动', applyDate: '2026-09-01' }),
    mkOrder({ province: '江苏', city: '无锡', carrier: '联通', applyDate: '2025-09-20' }),
  ];

  it('province/city/carrier 精确相等', () => {
    expect(selectOrders(orders, f({ province: '广东' })).length).toBe(2);
    expect(selectOrders(orders, f({ city: '广州' })).length).toBe(1);
    expect(selectOrders(orders, f({ carrier: '联通' })).length).toBe(2);
  });

  it('month 是 applyDate 前缀：2026-09 匹配单月，2026 匹配整年', () => {
    expect(selectOrders(orders, f({ month: '2026-09' })).map((o) => o.applyDate)).toEqual(['2026-09-01']);
    expect(selectOrders(orders, f({ month: '2026' })).length).toBe(2);
    expect(selectOrders(orders, f({ month: '' })).length).toBe(3);
  });

  it('维度叠加生效', () => {
    expect(selectOrders(orders, f({ province: '广东', carrier: '联通' })).length).toBe(1);
  });
});

describe('selectOrders — payback 子集', () => {
  const orders = [
    mkOrder({ applyDate: '2026-09-01', paybackDate: '2026-09-20' }), // 已结佣
    mkOrder({ applyDate: '2026-07-01', paybackDate: '' }),           // 未结佣 100 天
    mkOrder({ applyDate: '2026-09-25', paybackDate: '' }),           // 未结佣 < 30 天
    mkOrder({ applyDate: '2026-08-20', paybackDate: '' }),           // 未结佣 50 天
  ];

  it('paid 只留有结佣日期的', () => {
    expect(selectOrders(orders, f({ payback: 'paid' })).length).toBe(1);
  });

  it('unpaid 只留没有结佣日期的', () => {
    expect(selectOrders(orders, f({ payback: 'unpaid' })).length).toBe(3);
  });

  it('over30 / over60 是 unpaid 的进一步收窄（按账龄）', () => {
    const over30 = selectOrders(orders, f({ payback: 'over30' }));
    const over60 = selectOrders(orders, f({ payback: 'over60' }));
    expect(over60.map((o) => o.applyDate)).toEqual(['2026-07-01']);
    expect(over30.map((o) => o.applyDate).sort()).toEqual(['2026-07-01', '2026-08-20'].sort());
    // over60 ⊂ over30 ⊂ unpaid
    expect(over30.length).toBeLessThanOrEqual(selectOrders(orders, f({ payback: 'unpaid' })).length);
    expect(over60.length).toBeLessThanOrEqual(over30.length);
  });
});

describe('selectOrders — 排除自身维度', () => {
  const orders = [
    mkOrder({ province: '广东', city: '广州', carrier: '联通', applyDate: '2026-08-15' }),
    mkOrder({ province: '广东', city: '深圳', carrier: '移动', applyDate: '2026-09-01' }),
    mkOrder({ province: '江苏', city: '无锡', carrier: '联通', applyDate: '2025-09-20' }),
  ];

  it("except='month' 忽略月份筛选，其余照常", () => {
    const base = f({ month: '2026-09', carrier: '联通' });
    expect(selectOrders(orders, base).length).toBe(0);           // 9 月的联通没有
    expect(selectOrders(orders, base, 'month').length).toBe(2);  // 月份被豁免，只剩联通
  });

  it("except='carrier' 忽略运营商筛选", () => {
    const base = f({ carrier: '联通', province: '广东' });
    expect(selectOrders(orders, base).length).toBe(1);
    expect(selectOrders(orders, base, 'carrier').length).toBe(2);
  });

  it("except='region' 同时忽略省份和城市", () => {
    const base = f({ province: '广东', city: '广州' });
    expect(selectOrders(orders, base).length).toBe(1);
    expect(selectOrders(orders, base, 'region').length).toBe(3);
  });

  it("except='region' 不豁免运营商", () => {
    const base = f({ province: '广东', city: '广州', carrier: '移动' });
    expect(selectOrders(orders, base, 'region').length).toBe(1);
  });
});

describe('sortOrders', () => {
  const orders = [
    mkOrder({ applyDate: '2026-09-10', paybackDate: '2026-09-20', commission: 100, name: '王五', city: '深圳' }),
    mkOrder({ applyDate: '2026-08-01', paybackDate: '', commission: 300, name: '张三', city: '广州' }),
    mkOrder({ applyDate: '2026-08-01', paybackDate: '2026-09-01', commission: 200, name: '李四', city: '北京' }),
  ];

  it('applyDate 按字符串比较；缺失当空串', () => {
    const sorted = sortOrders(orders, 'applyDate', true);
    expect(sorted.map((o) => o.applyDate)).toEqual(['2026-09-10', '2026-08-01', '2026-08-01']);
    expect(sortOrders(orders, 'applyDate', false)[0].applyDate).toBe('2026-08-01');
  });

  it('payback 排序：缺失排最后（desc 时空串最小）', () => {
    const asc = sortOrders(orders, 'payback', false);
    expect(asc[0].paybackDate).toBe('');
    expect(asc[asc.length - 1].paybackDate).toBe('2026-09-20');
  });

  it('commission / packageFee / commissionRate 按 Number(x)||0', () => {
    expect(sortOrders(orders, 'commission', true).map((o) => o.commission)).toEqual([300, 200, 100]);
    const withNaN = [mkOrder({ commission: NaN }), mkOrder({ commission: 50 })];
    expect(sortOrders(withNaN, 'commission', false).map((o) => o.commission)).toEqual([NaN, 50]);
  });

  it("name/city 用 localeCompare('zh-CN')", () => {
    expect(sortOrders(orders, 'name', false).map((o) => o.name)).toEqual(['李四', '王五', '张三']);
    expect(sortOrders(orders, 'city', false).map((o) => o.city)).toEqual(['北京', '广州', '深圳']);
  });

  it('不改原数组，且相等时保持原相对顺序（稳定）', () => {
    const original = [...orders];
    const sorted = sortOrders(orders, 'applyDate', true);
    expect(orders).toEqual(original);                       // 原数组未动
    expect(sorted).not.toBe(orders);
    // 同为 2026-08-01 的两条保持输入顺序
    const eq = sorted.filter((o) => o.applyDate === '2026-08-01');
    expect(eq[0].name).toBe('张三');
    expect(eq[1].name).toBe('李四');
  });
});

describe('getFilteredOrders', () => {
  it('= sortOrders(selectOrders(...)) 的组合', () => {
    const orders = [
      mkOrder({ applyDate: '2026-08-01', carrier: '联通' }),
      mkOrder({ applyDate: '2026-09-01', carrier: '移动' }),
      mkOrder({ applyDate: '2026-09-10', carrier: '联通' }),
    ];
    const out = getFilteredOrders(orders, f({ carrier: '联通', sort: 'applyDate', desc: false }));
    expect(out.map((o) => o.applyDate)).toEqual(['2026-08-01', '2026-09-10']);
  });
});

describe('activeFilterCount / scopeText', () => {
  it('q 也算一个条件', () => {
    expect(activeFilterCount(f({}))).toBe(0);
    expect(activeFilterCount(f({ q: '300m' }))).toBe(1);
    expect(activeFilterCount(f({ q: '  ' }))).toBe(0);
    expect(activeFilterCount(f({ q: '300m', province: '广东', city: '广州', carrier: '联通', month: '2026-09', payback: 'unpaid' }))).toBe(6);
  });

  it('scopeText 拼出当前口径', () => {
    expect(scopeText(f({}), 12)).toBe('当前口径：全部 12 笔订单');
    expect(scopeText(f({ month: '2026-09', province: '广东', city: '广州', carrier: '联通', payback: 'unpaid', q: '300m' }), 3))
      .toBe('当前口径：2026 年 09 月 · 广东 · 广州 · 联通 · 未结佣 · 搜索「300m」 —— 以下卡片、图表与表格均只统计这 3 笔');
  });

  it("scopeText 的月份：'2026' 整年、'2026-09' 单月", () => {
    expect(scopeText(f({ month: '2026' }), 1)).toContain('2026 全年');
    expect(scopeText(f({ month: '2026-09' }), 1)).toContain('2026 年 09 月');
  });
});
