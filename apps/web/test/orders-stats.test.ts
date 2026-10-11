/**
 * 统计纯函数测试。重点：中位数不被离群值带偏、续约 ±30 天窗口与
 * 「已续费的手机号不再提醒」、月末夹紧与闰年、账龄边界、聚合排序。
 */
import { describe, it, expect } from 'vitest';
import {
  agingDays, agingLevel, settleDays, median, settleStats,
  durationMonths, expiryDate, renewalCandidates,
  totals, statCards, groupBy, comboGroups, cityGroups, cnNumber,
} from '../src/orders/stats';
import { mkOrder } from './order-fixture';

/** 把「今天」固定住：返回的日期可作 agingDays / renewalCandidates 的第二参。 */
function fixedToday(): Date {
  const d = new Date(2026, 9, 11); // 2026-10-11 本地
  d.setHours(0, 0, 0, 0);
  return d;
}

describe('agingDays / agingLevel', () => {
  it('已结佣返回 null', () => {
    expect(agingDays(mkOrder({ paybackDate: '2026-09-20' }), fixedToday())).toBeNull();
  });

  it('日期缺失或在未来返回 null', () => {
    expect(agingDays(mkOrder({ applyDate: '' }), fixedToday())).toBeNull();
    expect(agingDays(mkOrder({ applyDate: '2026-10-12' }), fixedToday())).toBeNull();
  });

  it('账龄按本地零点整日计算', () => {
    expect(agingDays(mkOrder({ applyDate: '2026-10-11' }), fixedToday())).toBe(0);
    expect(agingDays(mkOrder({ applyDate: '2026-10-01' }), fixedToday())).toBe(10);
  });

  it('账龄分级：>=60 bad，>=30 warn，其余 ok，null 空串', () => {
    expect(agingLevel(59)).toBe('age-warn');
    expect(agingLevel(60)).toBe('age-bad');
    expect(agingLevel(29)).toBe('age-ok');
    expect(agingLevel(null)).toBe('');
  });
});

describe('settleDays / median / settleStats', () => {
  it('settleDays = 结佣日期 - 办理日期；未结佣或日期缺失返回 null', () => {
    expect(settleDays(mkOrder({ applyDate: '2026-09-01', paybackDate: '2026-09-21' }))).toBe(20);
    expect(settleDays(mkOrder({ paybackDate: '' }))).toBeNull();
    expect(settleDays(mkOrder({ applyDate: '', paybackDate: '2026-09-21' }))).toBeNull();
  });

  it('median：奇数取中位，偶数取中间两个四舍五入平均；空返回 null', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(3);          // (2+3)/2 = 2.5 → round → 3（银行家舍入边界见下）
    expect(median([1, 2, 4, 5])).toBe(3);          // (2+4)/2 = 3
    expect(median([1, 2, 3, 10])).toBe(3);         // (2+3)/2 = 2.5 → 3
    expect(median([])).toBeNull();
  });

  it('中位数不被离群值带偏（平均值会）', () => {
    const days = [10, 11, 12, 13, 200];
    expect(median(days)).toBe(12);
    expect(Math.round(days.reduce((s, x) => s + x, 0) / days.length)).toBe(49); // 对照：平均被带偏
  });

  it('settleStats 汇总 min/max/n；无已结佣返回 null', () => {
    const list = [
      mkOrder({ applyDate: '2026-09-01', paybackDate: '2026-09-11' }),   // 10
      mkOrder({ applyDate: '2026-08-01', paybackDate: '2026-08-11' }),   // 10
      mkOrder({ applyDate: '2026-09-05', paybackDate: '' }),             // 未结佣
    ];
    const st = settleStats(list);
    expect(st).toEqual({ median: 10, min: 10, max: 10, n: 2 });
    expect(settleStats([mkOrder({ paybackDate: '' })])).toBeNull();
  });
});

describe('durationMonths / cnNumber / expiryDate', () => {
  it('半年=6；中文数字与阿拉伯数字都认', () => {
    expect(durationMonths('半年')).toBe(6);
    expect(durationMonths('1年')).toBe(12);
    expect(durationMonths('一年')).toBe(12);
    expect(durationMonths('两年')).toBe(24);
    expect(durationMonths('十五年')).toBe(180);
    expect(durationMonths('18个月')).toBe(18);
    expect(durationMonths('十五个月')).toBe(15);
    expect(durationMonths('12个月')).toBe(12);
    expect(durationMonths('')).toBe(0);
    expect(durationMonths('不认识')).toBe(0);
    expect(cnNumber('十')).toBe(10);
    expect(cnNumber('二十三')).toBe(23);
  });

  it('1/31 + 1 个月 = 2/28（夹紧，不溢出成 3 月初）', () => {
    const o = mkOrder({ applyDate: '2023-01-31', duration: '1个月' });
    const exp = expiryDate(o);
    expect(exp).not.toBeNull();
    expect(exp!.getFullYear()).toBe(2023);
    expect(exp!.getMonth()).toBe(1);      // 2 月
    expect(exp!.getDate()).toBe(28);
  });

  it('闰年 2024-02-29 + 1 年 = 2025-02-28', () => {
    const o = mkOrder({ applyDate: '2024-02-29', duration: '1年' });
    const exp = expiryDate(o);
    expect(exp!.getFullYear()).toBe(2025);
    expect(exp!.getMonth()).toBe(1);
    expect(exp!.getDate()).toBe(28);
  });

  it('时限认不出时到期日为 null', () => {
    expect(expiryDate(mkOrder({ duration: '' }))).toBeNull();
    expect(expiryDate(mkOrder({ applyDate: '', duration: '1年' }))).toBeNull();
  });
});

describe('renewalCandidates — ±30 天窗口与已续费抑制', () => {
  const today = fixedToday(); // 2026-10-11

  it('到期日落在 ±30 天内才提醒，且按 daysLeft 升序', () => {
    // 1年合约：申请日 = 到期日 - 1 年
    const list = [
      mkOrder({ id: 1, phone: '13800000001', applyDate: '2025-10-05', duration: '1年' }),  // 到期 2026-10-05，-6 天
      mkOrder({ id: 2, phone: '13800000002', applyDate: '2025-10-25', duration: '1年' }),  // 到期 2026-10-25，+14 天
      mkOrder({ id: 3, phone: '13800000003', applyDate: '2025-09-01', duration: '1年' }),  // 到期 2026-09-01，-40 天：出窗
      mkOrder({ id: 4, phone: '13800000004', applyDate: '2025-12-01', duration: '1年' }),  // 到期 2026-12-01，+51 天：出窗
    ];
    const items = renewalCandidates(list, list, today);
    expect(items.map((r) => r.order.id)).toEqual([1, 2]);
    expect(items[0].daysLeft).toBe(-6);
    expect(items[1].daysLeft).toBe(14);
  });

  it('窗口边界 ±30 天含头含尾', () => {
    const list = [
      mkOrder({ id: 1, phone: '13800000001', applyDate: '2025-09-11', duration: '1年' }), // 到期 2026-09-11，-30
      mkOrder({ id: 2, phone: '13800000002', applyDate: '2025-11-10', duration: '1年' }), // 到期 2026-11-10，+30
    ];
    const items = renewalCandidates(list, list, today);
    expect(items.map((r) => r.order.id).sort()).toEqual([1, 2]);
  });

  it('同手机号后来又办过单（applyDate 更大）则不再提醒', () => {
    const list = [
      mkOrder({ id: 1, phone: '13800000001', applyDate: '2025-10-05', duration: '1年' }), // 旧单，快到期
      mkOrder({ id: 2, phone: '13800000001', applyDate: '2026-09-15', duration: '1年' }), // 续过的
    ];
    const items = renewalCandidates(list, list, today);
    expect(items.map((r) => r.order.id)).not.toContain(1);
  });

  it('判断「已续费」看的是全量 allOrders，不是当前视图', () => {
    const view = [mkOrder({ id: 1, phone: '13800000001', applyDate: '2025-10-05', duration: '1年' })];
    const all = [...view, mkOrder({ id: 2, phone: '13800000001', applyDate: '2026-09-15', duration: '1年' })];
    expect(renewalCandidates(view, all, today)).toEqual([]);
  });

  it('到期日按夹紧后的日期算：1/31 办的半年单 → 7/31', () => {
    const list = [mkOrder({ id: 1, phone: '13800000001', applyDate: '2026-01-31', duration: '6个月' })];
    const items = renewalCandidates(list, list, new Date(2026, 6, 31)); // 2026-07-31
    expect(items.length).toBe(1);
    expect(items[0].expiry).toBe('2026-07-31');
    expect(items[0].daysLeft).toBe(0);
  });
});

describe('totals — NaN 安全', () => {
  it('NaN/undefined 字段按 0 累加，不污染合计', () => {
    const list = [
      mkOrder({ packageFee: 600, commission: 300 }),
      mkOrder({ packageFee: NaN, commission: undefined as unknown as number }),
    ];
    const t = totals(list);
    expect(t.count).toBe(2);
    expect(t.packageFee).toBe(600);
    expect(t.commission).toBe(300);
  });
});

describe('statCards — 两条必须保住的语义', () => {
  const today = fixedToday(); // 2026-10

  it('(a) 本月/上月环比从全量 allOrders 取，不受 view 筛选影响', () => {
    // view 只剩一条旧单；allOrders 里有本月 2 条、上月 1 条
    const view = [mkOrder({ applyDate: '2025-01-01' })];
    const allOrders = [
      ...view,
      mkOrder({ applyDate: '2026-10-01' }),
      mkOrder({ applyDate: '2026-10-05', paybackDate: '2026-10-09' }),
      mkOrder({ applyDate: '2026-09-01' }),
    ];
    const cards = statCards(view, allOrders, today);
    expect(cards[0].label).toBe('本月订单');
    expect(cards[0].value).toBe('2 笔');            // 不是 0：月份口径不跟随 view
    expect(cards[0].deltaPct).toBe(100);            // (2-1)/1
  });

  it('(b) 上月为 0 时不算百分比：deltaPct=null，sub 给「上月无订单」', () => {
    const allOrders = [mkOrder({ applyDate: '2026-10-01' })];
    const cards = statCards(allOrders, allOrders, today);
    expect(cards[0].deltaPct).toBeNull();
    expect(cards[0].sub).toBe('上月无订单');
  });

  it('佣金合计/未结佣/结佣周期按传入口径统计；未结佣带最久账龄', () => {
    const view = [
      mkOrder({ commission: 100, packageFee: 200, paybackDate: '2026-09-30', applyDate: '2026-09-20' }),
      mkOrder({ commission: 50, packageFee: 100, paybackDate: '', applyDate: '2026-07-01' }), // 102 天
      mkOrder({ commission: 80, packageFee: 160, paybackDate: '', applyDate: '2026-09-25' }),
    ];
    const cards = statCards(view, view, today);
    expect(cards[1].value).toBe('¥230');
    expect(cards[2].warn).toBe(true);
    expect(cards[2].sub).toBe('最久 102 天');
    const st = cards[3];
    expect(st.value).toBe('10 天');                 // 中位数 10
    expect(st.sub).toContain('1 笔已结佣');
  });

  it('click 提示月份/结佣跳转；没有已结佣时周期卡不给 click', () => {
    const cards = statCards([mkOrder()], [mkOrder()], today);
    expect(cards[0].click).toEqual({ kind: 'month', value: '2026-10' });
    expect(cards[1].click).toEqual({ kind: 'all', value: '' });
    expect(cards[2].click).toEqual({ kind: 'payback', value: 'unpaid' });
    expect(cards[3].click).toBeUndefined();
  });
});

describe('groupBy / comboGroups / cityGroups — 排序', () => {
  it('groupBy：笔数、佣金、单均、结佣中位数', () => {
    const list = [
      mkOrder({ carrier: '联通', commission: 100, paybackDate: '2026-09-11', applyDate: '2026-09-01' }),
      mkOrder({ carrier: '联通', commission: 200 }),
      mkOrder({ carrier: '移动', commission: 60 }),
    ];
    const g = groupBy(list, (o) => o.carrier);
    const unicom = g.find((x) => x.key === '联通')!;
    expect(unicom.count).toBe(2);
    expect(unicom.commission).toBe(300);
    expect(unicom.avgCommission).toBe(150);
    expect(unicom.settleMedian).toBe(10);
  });

  it('comboGroups：package 统一大写、三项全空跳过、count 倒序并列按 commission 倒序', () => {
    const list = [
      mkOrder({ city: '广州', carrier: '联通', package: '300m' }),
      mkOrder({ city: '广州', carrier: '联通', package: '300M' }),      // 同组
      mkOrder({ city: '深圳', carrier: '移动', package: '1000m', commission: 999 }),
      mkOrder({ city: '', carrier: '', package: '' }),                  // 跳过
    ];
    const g = comboGroups(list);
    expect(g.length).toBe(2);
    expect(g[0]).toMatchObject({ city: '广州', carrier: '联通', pkg: '300M', count: 2, commission: 600 });
    expect(g[1]).toMatchObject({ city: '深圳', carrier: '移动', pkg: '1000M', count: 1, commission: 999 });
  });

  it('comboGroups 并列时按佣金高的排前', () => {
    const list = [
      mkOrder({ city: 'A城', carrier: '联通', package: '300m', commission: 100 }),
      mkOrder({ city: 'B城', carrier: '移动', package: '500m', commission: 500 }),
    ];
    expect(comboGroups(list)[0].city).toBe('B城');
  });

  it('cityGroups：跳过无城市记录，按 commission 倒序', () => {
    const list = [
      mkOrder({ city: '广州', province: '广东', commission: 100 }),
      mkOrder({ city: '深圳', province: '广东', commission: 300 }),
      mkOrder({ city: '', province: '广东', commission: 999 }),  // 跳过
    ];
    const g = cityGroups(list);
    expect(g.map((x) => x.city)).toEqual(['深圳', '广州']);
    expect(g[0]).toMatchObject({ province: '广东', count: 1, commission: 300 });
  });
});
