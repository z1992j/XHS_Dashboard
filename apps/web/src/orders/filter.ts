/**
 * 筛选与排序。语义逐条照抄旧版 app.js 的 selectOrders（约 1067 行）与
 * getFilteredOrders（约 1089 行）—— 这套规则是页面所有数字的口径来源。
 */
import type { Filters, Order, SortKey } from './types';

/** q 命中字段：小写包含匹配；phone 用原文匹配（省得数字被奇怪的小写规则扰动）。 */
function hitQuery(o: Order, q: string): boolean {
  const nq = q.toLowerCase();
  return (
    (o.name || '').toLowerCase().includes(nq) ||
    (o.phone || '').includes(q) ||
    (o.city || '').toLowerCase().includes(nq) ||
    (o.package || '').toLowerCase().includes(nq) ||
    (o.province || '').toLowerCase().includes(nq) ||
    (o.carrier || '').toLowerCase().includes(nq)
  );
}

/** 过滤口径里的账龄（unpaid 且办理日期在过去才有账龄）。 */
function filterAgingDays(o: Order): number {
  if (o.paybackDate) return -1;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(o.applyDate || '');
  if (!m) return -1;
  const start = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((today.getTime() - start.getTime()) / 86400000);
}

/**
 * 按维度取数。except 用来排除某一个维度自身的筛选：
 * 按月份拆的趋势图若吃掉月份筛选就只剩一根柱子；运营商图、地区图同理。
 * 这些图改为「不吃自己那一维，但高亮选中项」，其余维度照常生效。
 */
export function selectOrders(orders: Order[], f: Filters, except?: 'month' | 'region' | 'carrier'): Order[] {
  const q = f.q.trim().toLowerCase();
  const carrierFilter = except === 'carrier' ? '' : f.carrier;
  const provinceFilter = except === 'region' ? '' : f.province;
  const cityFilter = except === 'region' ? '' : f.city;
  const monthFilter = except === 'month' ? '' : f.month;
  return orders.filter((o) => {
    if (q && !hitQuery(o, q)) return false;
    if (carrierFilter && o.carrier !== carrierFilter) return false;
    if (provinceFilter && o.province !== provinceFilter) return false;
    if (cityFilter && o.city !== cityFilter) return false;
    // 月份筛选值就是日期前缀：'' 全部、'2026' 整年、'2026-09' 单月，
    // 所以匹配逻辑一句 startsWith 就够，不必再维护起止日期两个输入框。
    if (monthFilter && !(o.applyDate || '').startsWith(monthFilter)) return false;
    if (f.payback === 'paid' && !o.paybackDate) return false;
    if (f.payback === 'unpaid' && o.paybackDate) return false;
    if (f.payback === 'over30' && !(filterAgingDays(o) >= 30)) return false;
    if (f.payback === 'over60' && !(filterAgingDays(o) >= 60)) return false;
    return true;
  });
}

/**
 * 返回新数组，不改原入参：视图数组被 useMemo 缓存，原地排序会让上一次
 * 渲染的引用也跟着变，React 比较不出来就白缓存了。
 */
export function sortOrders(list: Order[], key: SortKey, desc: boolean): Order[] {
  const num = (v: unknown): number => Number(v) || 0;
  const cmp = (a: Order, b: Order): number => {
    let va: string | number, vb: string | number;
    if (key === 'applyDate') { va = a.applyDate || ''; vb = b.applyDate || ''; }
    else if (key === 'payback') { va = a.paybackDate || ''; vb = b.paybackDate || ''; }
    else if (key === 'commission') { va = num(a.commission); vb = num(b.commission); }
    else if (key === 'packageFee') { va = num(a.packageFee); vb = num(b.packageFee); }
    else if (key === 'commissionRate') { va = num(a.commissionRate); vb = num(b.commissionRate); }
    else if (key === 'name') { return (a.name || '').localeCompare(b.name || '', 'zh-CN'); }
    else { return (a.city || '').localeCompare(b.city || '', 'zh-CN'); }
    if (va < vb) return desc ? 1 : -1;
    if (va > vb) return desc ? -1 : 1;
    return 0;
  };
  // slice 拷贝保序原数组（入参被 useMemo 缓存，不能原地排序）；
  // 比较相等时返回 0，Array.sort 本身是稳定的
  return list.slice().sort(cmp);
}

/** 卡片、图表、表格用的是同一份筛选结果 + 排序。 */
export function getFilteredOrders(orders: Order[], f: Filters): Order[] {
  return sortOrders(selectOrders(orders, f), f.sort, f.desc);
}

/**
 * 当前生效的筛选条件个数，给「清除筛选」按钮的角标。
 * 搜索框也算一个条件：点「热销组合」会把套餐写进搜索框，不计入的话
 * 只剩它生效时按钮会消失，表格却仍是筛过的。
 */
export function activeFilterCount(f: Filters): number {
  let n = 0;
  if (f.q.trim()) n++;
  if (f.province) n++;
  if (f.city) n++;
  if (f.carrier) n++;
  if (f.month) n++;
  if (f.payback) n++;
  return n;
}

/**
 * 当前口径一行字：写清楚这批数字是什么口径的，不然筛完不知道看的是哪一撮。
 * 照抄旧版 renderScope（约 506 行）的拼装顺序。
 */
export function scopeText(f: Filters, count: number): string {
  const parts: string[] = [];
  if (f.month) {
    const m = /^(\d{4})-(\d{2})$/.exec(f.month);
    parts.push(m ? `${m[1]} 年 ${m[2]} 月` : `${f.month} 全年`);
  }
  if (f.province) parts.push(f.province);
  if (f.city) parts.push(f.city);
  if (f.carrier) parts.push(f.carrier);
  const statusText: Record<string, string> = {
    unpaid: '未结佣', paid: '已结佣', over30: '逾 30 天', over60: '逾 60 天',
  };
  const pb = statusText[f.payback];
  if (pb) parts.push(pb);
  const q = f.q.trim();
  if (q) parts.push(`搜索「${q}」`);
  return parts.length
    ? `当前口径：${parts.join(' · ')} —— 以下卡片、图表与表格均只统计这 ${count} 笔`
    : `当前口径：全部 ${count} 笔订单`;
}
