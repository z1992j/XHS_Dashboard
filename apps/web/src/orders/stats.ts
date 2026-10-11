/**
 * 统计计算：看板卡片、结佣周期、续约提醒、聚合分组。
 * 全部纯函数；语义照抄旧版 app.js 的 renderStats（约 528 行）、
 * comboGroups/cityGroups/groupBy（约 625/737/1031 行）与续约段（约 902 行）。
 */
import type { Order } from './types';
import { parseYmd, addMonthsClamped, currentYm, lastMonthYm } from './date';

/** 从办理日期到今天的天数；日期缺失或在未来时返回 null（账龄对未来的单没有意义）。 */
export function agingDays(o: Order, today: Date = startOfTodayLocal()): number | null {
  if (o.paybackDate) return null;
  const d = parseYmd(o.applyDate);
  if (!d) return null;
  const days = Math.round((today.getTime() - d.getTime()) / 86400000);
  return days >= 0 ? days : null;
}

/** 30 / 60 天两道线，与催款节奏对应。 */
export function agingLevel(days: number | null): 'age-bad' | 'age-warn' | 'age-ok' | '' {
  if (days === null) return '';
  if (days >= 60) return 'age-bad';
  if (days >= 30) return 'age-warn';
  return 'age-ok';
}

/** 办理日期 → 结佣日期的天数；只有已结佣的订单才有这个值。 */
export function settleDays(o: Order): number | null {
  if (!o.paybackDate) return null;
  const a = parseYmd(o.applyDate);
  const b = parseYmd(o.paybackDate);
  if (!a || !b) return null;
  const days = Math.round((b.getTime() - a.getTime()) / 86400000);
  return days >= 0 ? days : null;
}

/**
 * 用中位数而不是平均：样本少的时候一笔拖很久的单会把平均值整个带偏。
 * 偶数个取中间两个的平均，四舍五入到整天。
 */
export function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((x, y) => x - y);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function medianNum(nums: number[]): number {
  return median(nums) as number;
}

/** 当前口径的结佣周期三数：中位数 / 最快 / 最慢，没有已结佣订单时返回 null。 */
export function settleStats(list: Order[]): { median: number; min: number; max: number; n: number } | null {
  const days = list.map(settleDays).filter((d): d is number => d !== null);
  if (!days.length) return null;
  return { median: medianNum(days), min: Math.min(...days), max: Math.max(...days), n: days.length };
}

const startOfTodayLocal = (): Date => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

// 时限写法五花八门：6个月 / 1年 / 18个月 / 一年 / 两年 / 半年；认不出返回 0
const CN_DIGITS: Record<string, number> = {
  '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9,
};
const CN_NUM_CHARS = '0-9一二两三四五六七八九十';

/** 「一年」「两年」「十五个月」这类中文数字，销售发来的原文里很常见。 */
export function cnNumber(s: string): number {
  const t = (s || '').trim();
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  const m = t.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/);
  if (m) return (m[1] ? CN_DIGITS[m[1]] : 1) * 10 + (m[2] ? CN_DIGITS[m[2]] : 0);
  if (t.length === 1 && CN_DIGITS[t]) return CN_DIGITS[t];
  return 0;
}

/** 合约时限文案 -> 月数。 */
export function durationMonths(str: string): number {
  const s = String(str || '').trim();
  if (!s) return 0;
  if (/半年/.test(s)) return 6;
  const y = s.match(new RegExp('([' + CN_NUM_CHARS + ']+)\\s*年'));
  if (y && cnNumber(y[1])) return cnNumber(y[1]) * 12;
  const m = s.match(new RegExp('([' + CN_NUM_CHARS + ']+)\\s*个?月'));
  if (m && cnNumber(m[1])) return cnNumber(m[1]);
  return 0;
}

/**
 * 到期日 = 办理日期 + 时限。没有单独记录装机日，办理日期是能拿到的最近似值。
 * 到期是二次客资机会：提前联系续约或推荐升级。
 */
export function expiryDate(o: Order): Date | null {
  const start = parseYmd(o.applyDate);
  const months = durationMonths(o.duration);
  return start && months ? addMonthsClamped(start, months) : null;
}

/** 前后各看 30 天：快到期的要联系，刚过期的还来得及挽回。 */
export const RENEW_WINDOW = 30;

/**
 * 续约候选。第二个参数是全库订单：同一手机号后来又办过单，说明已经续上了，
 * 不必再提醒（判断依据是全量，而不是当前视图，否则切个筛选提醒就变了）。
 * expiry 是夹紧后的到期日（YYYY-MM-DD），UI 直接展示。
 */
export function renewalCandidates(
  list: Order[],
  allOrders: Order[],
  today: Date = startOfTodayLocal(),
): { order: Order; expiry: string; daysLeft: number }[] {
  const latestByPhone = new Map<string, string>();
  allOrders.forEach((o) => {
    if (!o.phone || !o.applyDate) return;
    const known = latestByPhone.get(o.phone);
    if (!known || o.applyDate > known) latestByPhone.set(o.phone, o.applyDate);
  });
  return list
    .filter((o) => !o.phone || latestByPhone.get(o.phone) === o.applyDate)
    .map((o) => {
      const exp = expiryDate(o);
      if (!exp) return null;
      // 夹紧日拿天数：1/31 + 1 个月算到 2/28，不是 3/3
      const daysLeft = Math.round((exp.getTime() - today.getTime()) / 86400000);
      if (daysLeft < -RENEW_WINDOW || daysLeft > RENEW_WINDOW) return null;
      return { order: o, expiry: ymdOf(exp), daysLeft };
    })
    .filter((r): r is { order: Order; expiry: string; daysLeft: number } => r !== null)
    .sort((a, b) => a.daysLeft - b.daysLeft);
}

const ymdOf = (d: Date): string => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

export function totals(list: Order[]): { count: number; packageFee: number; commission: number } {
  return {
    count: list.length,
    packageFee: list.reduce((s, o) => s + (Number(o.packageFee) || 0), 0),
    commission: list.reduce((s, o) => s + (Number(o.commission) || 0), 0),
  };
}

/**
 * 四张看板卡。本月/上月的环比按自然月从全量 allOrders 取，不受月份筛选影响，
 * 否则筛到 8 月时「本月订单」会变成 0，读起来是错的。
 */
export function statCards(
  list: Order[],
  allOrders: Order[],
  today: Date = startOfTodayLocal(),
): StatCard[] {
  const total = list.length;
  const totalCommission = list.reduce((s, o) => s + (Number(o.commission) || 0), 0);

  const ym = currentYm(today);
  const lastYm = lastMonthYm(today);
  const thisMonthOrders = allOrders.filter((o) => o.applyDate && o.applyDate.startsWith(ym));
  const lastMonthOrders = allOrders.filter((o) => o.applyDate && o.applyDate.startsWith(lastYm));
  const monthNew = thisMonthOrders.length;
  const monthCommission = thisMonthOrders.reduce((s, o) => s + (Number(o.commission) || 0), 0);

  // 环比：按订单数比，上月为 0 时百分比没有意义，只说明是新增
  let deltaPct: number | null = null;
  if (lastMonthOrders.length > 0) {
    deltaPct = Math.round(((monthNew - lastMonthOrders.length) / lastMonthOrders.length) * 100);
  }

  const unpaid = list.filter((o) => !o.paybackDate);
  const agings = unpaid.map((o) => agingDays(o, today)).filter((d): d is number => d !== null);
  const oldestAging = agings.length ? Math.max(...agings) : null;

  // 结佣周期：CPS 模式下「钱多久到」比「做了多少单」更值得盯
  const st = settleStats(list);

  return [
    {
      label: '本月订单',
      value: `${monthNew} 笔`,
      sub: deltaPct !== null ? undefined : lastMonthOrders.length === 0 && monthNew > 0
        ? '上月无订单'
        : `本月佣金 ${monthCommission.toLocaleString()}`,
      deltaPct,
      click: { kind: 'month', value: ym },
    },
    {
      label: '佣金合计',
      value: `¥${totalCommission.toLocaleString()}`,
      sub: `共 ${total} 笔订单`,
      click: { kind: 'all', value: '' },
    },
    {
      label: '未结佣',
      value: `${unpaid.length} 笔`,
      warn: unpaid.length > 0,
      // 这张卡不放金额（此前明确要求去掉）；压着多少钱看下面的账龄分布卡
      sub: oldestAging !== null ? `最久 ${oldestAging} 天` : undefined,
      click: { kind: 'payback', value: 'unpaid' },
    },
    {
      label: '结佣周期（中位数）',
      value: st ? `${st.median} 天` : '—',
      sub: st
        ? `最快 ${st.min} · 最慢 ${st.max} 天（${st.n} 笔已结佣）`
        : '还没有已结佣的订单',
      click: st ? { kind: 'payback', value: 'paid' } : undefined,
    },
  ];
}

export interface StatCard {
  label: string;
  value: string;
  /** 副文案：无环比时显示（上月无订单 / 本月佣金 / 最久账龄 / 周期区间） */
  sub?: string;
  /** 上月有订单时才有环比；null 表示「上月无订单」 */
  deltaPct?: number | null;
  warn?: boolean;
  click?: { kind: 'month' | 'payback' | 'all'; value: string };
}

/** 按任意字段聚合：笔数、佣金、单均佣金、结佣周期中位数。 */
export function groupBy(list: Order[], keyOf: (o: Order) => string): GroupStat[] {
  const map = new Map<string, Order[]>();
  list.forEach((o) => {
    const k = keyOf(o);
    if (!k) return;
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(o);
  });
  return Array.from(map, ([key, items]) => {
    const commission = items.reduce((s, o) => s + (Number(o.commission) || 0), 0);
    const st = settleStats(items);
    return {
      key, count: items.length, commission,
      avgCommission: Math.round(commission / items.length),
      settleMedian: st ? st.median : null,
    };
  });
}

export interface GroupStat {
  key: string;
  count: number;
  commission: number;
  avgCommission: number;
  settleMedian: number | null;
}

/**
 * 热销组合：城市 × 运营商 × 套餐 一起看，回答「在哪、用谁家、卖哪档最好卖」。
 * 套餐写法大小写不一（300m / 300M）先统一成大写，否则同一档会被拆成两行。
 */
export function comboGroups(list: Order[]): ComboGroup[] {
  const map = new Map<string, ComboGroup>();
  list.forEach((o) => {
    const city = (o.city || '').trim();
    const carrier = (o.carrier || '').trim();
    const pkg = (o.package || '').trim().toUpperCase();
    if (!city && !carrier && !pkg) return; // 三项全空的记录没什么可分析的
    const key = [city, carrier, pkg].join('\u0001');
    if (!map.has(key)) {
      map.set(key, {
        city, carrier, pkg,
        province: (o.province || '').trim(),
        count: 0, commission: 0,
      });
    }
    const g = map.get(key)!;
    g.count++;
    g.commission += Number(o.commission) || 0;
  });
  return Array.from(map.values())
    // 笔数并列时按佣金高的排前，避免顺序随数据顺序漂移
    .sort((a, b) => b.count - a.count || b.commission - a.commission);
}

export interface ComboGroup {
  city: string;
  carrier: string;
  /** 套餐统一转大写后的写法 */
  pkg: string;
  province: string;
  count: number;
  commission: number;
}

/** 城市 Top5：按佣金排序。带上省份是因为城市筛选选项跟着省份走。 */
export function cityGroups(list: Order[]): CityGroup[] {
  const map = new Map<string, CityGroup>();
  list.forEach((o) => {
    const city = (o.city || '').trim();
    if (!city) return;
    if (!map.has(city)) {
      map.set(city, { city, province: (o.province || '').trim(), count: 0, commission: 0 });
    }
    const g = map.get(city)!;
    g.count++;
    g.commission += Number(o.commission) || 0;
  });
  return Array.from(map.values())
    .sort((a, b) => b.commission - a.commission || b.count - a.count);
}

export interface CityGroup {
  city: string;
  province: string;
  count: number;
  commission: number;
}
