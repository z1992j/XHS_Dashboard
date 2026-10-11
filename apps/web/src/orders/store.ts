/**
 * 销售订单页面的模块级 store + useSyncExternalStore 订阅。
 *
 * 行为逐条照抄旧版 app.js 的全局可变状态段（约 234~330 行）与各 action：
 * 视图切分不重新请求、编辑按 id 不按下标、删除可撤销、登出清缓存。
 * getSnapshot 必须返回同一个引用（只在状态变化时换新对象），
 * 否则 useSyncExternalStore 会无限重渲染。
 */
import { useSyncExternalStore } from 'react';
import type { Order, OrderRow, Filters, OrdersModal, BootstrapState, ViewScope } from './types';
import { EMPTY_FILTERS } from './types';
import { SALES_PERSON, TREND_METRIC_KEY } from './config';
import { todayStr } from './date';
import { appConfirm } from './confirm';
import {
  loadOrders, insertOrder, insertOrders, patchOrder, deleteOrder, reinsertOrder,
  orderSession, toRow, clearCachedOrders,
} from './client';

/** 单人使用：新建订单一律记在这个名下（历史数据与导出格式兼容）。 */
const isMine = (o: Order) => o.salesPerson === SALES_PERSON;

export interface OrderSnapshot {
  /** 当前视图（mine/all）里的订单，未筛选未排序 */
  orders: Order[];
  /** 数据库返回的全部记录（含非本人归属），判重与全量统计用 */
  allOrders: Order[];
  filters: Filters;
  view: ViewScope;
  /** 当前视图之外还有多少条（mine 视图下 = 非本人的条数） */
  hiddenCount: number;
  /** 服务端说有多少条但这次没全给：> 0 表示被截断了，界面必须提示 */
  truncatedTotal: number;
  /** 读不到总数且条数已达可疑量级：无法证明数据取全 */
  countUnverified: boolean;
  /** true 表示网络失败、用的是 localStorage 缓存 */
  usingCache: boolean;
  /** 离线缓存的写入时间戳；非离线态为 0 */
  cachedAt: number;
  bootstate: BootstrapState;
  /** 与 bootstate==='needs-password' 等价，给 UI 的便捷位 */
  needsPassword: boolean;
  ready: boolean;
  loading: boolean;
  /** 请求/保存失败文案（登录失败也走这里） */
  error: string;
  saving: boolean;
  modal: OrdersModal;
  trendMetric: 'commission' | 'count';
}

interface StoreState extends OrderSnapshot {
  /** bootstrap 是否已经跑过：StrictMode 下 effect 会执行两次，别真的发两轮请求 */
  bootstrapped: boolean;
}

// 趋势图看的是佣金还是订单量，记住上一次的选择
function readTrendMetric(): 'commission' | 'count' {
  try {
    return localStorage.getItem(TREND_METRIC_KEY) === 'count' ? 'count' : 'commission';
  } catch {
    return 'commission';
  }
}

let state: StoreState = {
  orders: [],
  allOrders: [],
  filters: { ...EMPTY_FILTERS },
  view: 'mine',
  hiddenCount: 0,
  truncatedTotal: 0,
  countUnverified: false,
  usingCache: false,
  cachedAt: 0,
  bootstate: 'loading',
  needsPassword: false,
  ready: false,
  loading: false,
  error: '',
  saving: false,
  modal: null,
  trendMetric: readTrendMetric(),
  bootstrapped: false,
};

const listeners = new Set<() => void>();

function set(patch: Partial<StoreState>): void {
  state = { ...state, ...patch };
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function getSnapshot(): StoreState {
  return state;
}

/** 直接读当前快照（测试与非 React 场景用；React 侧走 useOrderState）。 */
export function readSnapshot(): OrderSnapshot {
  return state;
}

/* ---------------- 内部动作 ---------------- */

// 收到数据后重新切分两个视图；换视图时也走这里，无需重新请求。
// 数据库里可能还留着他人（或早期导入归属为空）的历史记录，它们不进入
// 当前视图，但会在顶部标出条数，避免悄无声息地消失。
function applyView(all: Order[], view: ViewScope): { orders: Order[]; hiddenCount: number } {
  const mine = all.filter(isMine);
  return view === 'mine'
    ? { orders: mine, hiddenCount: all.length - mine.length }
    : { orders: all.filter((o) => !isMine(o)), hiddenCount: mine.length };
}

async function refreshData(): Promise<void> {
  set({ loading: true });
  try {
    const r = await loadOrders();
    set({
      allOrders: r.rows,
      ...applyView(r.rows, state.view),
      truncatedTotal: r.truncatedTotal,
      countUnverified: r.countUnverified,
      usingCache: r.usingCache,
      cachedAt: r.cachedAt,
      loading: false,
      ready: true,
    });
  } catch (e) {
    set({
      loading: false,
      ready: true,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

// 删除前留的 toRow 快照，失败/成功后都可供「撤销」取用（取出即清）
let lastDeleteSnapshot: OrderRow | null = null;

/** 取上次删除留下的快照（撤销删除用）；取出后即清空。 */
export function takeLastDeleteSnapshot(): OrderRow | null {
  const r = lastDeleteSnapshot;
  lastDeleteSnapshot = null;
  return r;
}

/* ---------------- action 集 ---------------- */

export const actions = {
  /**
   * 启动：恢复会话 → 过期就续期 → refresh 失败清会话回密码页。
   * 登录前不拉数据（无令牌的请求会被 RLS 直接拒掉）。
   */
  async bootstrap(): Promise<void> {
    if (state.bootstrapped) return;
    set({ bootstrapped: true });
    const s = orderSession.restore();
    if (!s) {
      // 残缺会话（上次没换到数据库令牌）缓存着没意义，提示重新输密码再试一次
      set({
        bootstate: 'needs-password',
        needsPassword: true,
        error: orderSession.hasStored() ? '请重新输入密码，以连接数据库' : '',
      });
      return;
    }
    if (Date.now() >= s.expiresAt) {
      const next = await orderSession.refresh();
      if (!next) {
        orderSession.logout();
        set({ bootstate: 'needs-password', needsPassword: true, error: '登录已过期，请重新输入密码' });
        return;
      }
    }
    set({ bootstate: 'ready', needsPassword: false, error: '' });
    await refreshData();
  },

  /** 登录：密码换令牌（并按 remember 落库），成功后拉数据。 */
  async login(password: string, remember: boolean): Promise<boolean> {
    set({ saving: true, error: '' });
    const r = await orderSession.login(password, remember);
    if (!r.ok) {
      set({ saving: false, error: r.error });
      return false;
    }
    set({ saving: false, bootstate: 'ready', needsPassword: false });
    await refreshData();
    return true;
  },

  /**
   * 登出：会话与订单缓存都清掉 —— 退出后不该在本机留客户资料。
   * 清空列表回密码页，避免下次登录前闪现上一任的旧数据。
   */
  logout(): void {
    orderSession.logout();
    clearCachedOrders();
    set({
      bootstate: 'needs-password',
      needsPassword: true,
      ready: false,
      allOrders: [],
      orders: [],
      hiddenCount: 0,
      truncatedTotal: 0,
      countUnverified: false,
      usingCache: false,
      cachedAt: 0,
      modal: null,
      error: '',
    });
  },

  /** 局部合并筛选。province 变了必须清 city：城市下拉选项跟着省份走。 */
  patchFilters(p: Partial<Filters>): void {
    const next: Filters = { ...state.filters, ...p };
    if (p.province !== undefined && p.province !== state.filters.province) next.city = '';
    set({ filters: next });
  },

  /**
   * 视图切换只重新切分已有的 allOrders，不重新请求。
   * 切视图时重置 province/city：城市选项跟着省份走，换一边后原选择
   * 大概率不在新选项里，与其被静默置空不如显式清掉。
   */
  toggleView(): void {
    const view: ViewScope = state.view === 'mine' ? 'all' : 'mine';
    set({
      view,
      filters: { ...state.filters, view, province: '', city: '' },
      ...applyView(state.allOrders, view),
    });
  },

  /** 看板卡片用：直接套用，不做反选（反选是胶囊自己的事）。 */
  applyPayback(v: Filters['payback']): void {
    set({ filters: { ...state.filters, payback: v } });
  },

  /** 清筛选但保留排序：排序是「怎么摆」，不是「看哪些」。 */
  clearFilters(): void {
    const { sort, desc, view } = state.filters;
    set({ filters: { ...EMPTY_FILTERS, sort, desc, view } });
  },

  /** 点表头排序：同列再点反向，换列回到降序（和旧版下拉的手感一致）。 */
  setSort(key: Filters['sort']): void {
    const desc = state.filters.sort === key ? !state.filters.desc : true;
    set({ filters: { ...state.filters, sort: key, desc } });
  },

  setSearch(q: string): void {
    set({ filters: { ...state.filters, q } });
  },

  /**
   * 打开表单。编辑态必须带 editingId = 那条订单的 id —— 不能只记数组下标：
   * 表单开着期间数据可能被重载或撤销删除，下标会指向另一条，就会改错单。
   * 新增态 editingId = null，且 seed 里没有 id（保存逻辑按 editingId 分支）。
   */
  openForm(o?: Order): void {
    set({
      modal: o
        ? { kind: 'form', editingId: o.id, seed: { ...o } }
        : { kind: 'form', editingId: null, seed: { applyDate: todayStr() } },
    });
  },

  openDetail(o: Order): void {
    set({ modal: { kind: 'detail', order: o } });
  },

  openCsv(): void {
    set({ modal: { kind: 'csv' } });
  },

  openLogs(o: Order): void {
    set({ modal: { kind: 'logs', order: o } });
  },

  openSmart(): void {
    set({ modal: { kind: 'smart' } });
  },

  closeModal(): void {
    set({ modal: null });
  },

  /**
   * 保存（新增或编辑）。编辑/新增由当前 modal 态的 editingId 区分：
   * 智能录入批量保存时 modal 是 'smart'，也走新增分支。
   * 校验在表单层做过一遍，这里挡最后一道（批量保存不经表单）。
   */
  async submitOrder(draft: Partial<Order>): Promise<boolean> {
    const modal = state.modal;
    const editingId = modal && modal.kind === 'form' ? modal.editingId : null;

    const name = (draft.name || '').trim();
    const phone = (draft.phone || '').trim();
    const packageFee = Number(draft.packageFee) || 0;
    if (!name || !phone || !packageFee) {
      set({ error: '请填写姓名、手机号和套餐费' });
      return false;
    }
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      set({ error: '手机号格式不正确，应为 11 位数字' });
      return false;
    }
    const idCard = (draft.idCard || '').trim().toUpperCase();
    if (idCard && !/^\d{17}[\dX]$/.test(idCard)) {
      set({ error: '身份证号格式不正确，应为 18 位' });
      return false;
    }
    if (draft.paybackDate && draft.applyDate && draft.paybackDate < draft.applyDate) {
      set({ error: '结佣日期不能早于办理日期' });
      return false;
    }

    // 新增时提醒重复手机号，只在「走表单的新增」这一条路径上弹，查的是全库
    // （含隐藏的非本人归属记录），不是当前视图 —— 对应旧版 saveOrder 里那段。
    // 智能录入批量（modal.kind==='smart'）不弹：旧版 saveSmartBatch 直接入库，
    // 撞重的行由 checkParsed 的「手机号已存在」警告默认不勾选，要留就自己勾上；
    // 在这里再弹一次会把一批变成 N 个确认框，是旧版没有的手感。
    // CSV 导入也不走这里（importCsv 直接批量写，判重已在 buildImportPlan 做完）。
    // confirm 走注入点而不是 window.confirm，测试与嵌入环境才能接管。
    if (editingId == null && modal && modal.kind === 'form') {
      const dup = state.allOrders.find((o) => o.phone === phone);
      if (dup) {
        // 撞到的那条不是自己录的，把归属说清楚，否则用户不知道在给谁确认
        const owner = isMine(dup) ? '' : ' · 归属：' + (dup.salesPerson || '(空)');
        const ok = await appConfirm(
          '手机号 ' + phone + ' 已存在（' + (dup.name || '') + ' · ' + (dup.applyDate || '无日期') +
          owner + '），仍要继续新增吗？',
        );
        if (!ok) return false;
      }
    }

    // 佣金率：UI 层（表单/智能录入）传进来的已是 0~1 小数且算好 4 位小数，
    // 原样收下；只有没传时才按 commission/packageFee 现算。
    const commission = Number(draft.commission) || 0;
    let rate = draft.commissionRate
      ? Number(draft.commissionRate)
      : (packageFee > 0 ? commission / packageFee : 0);
    rate = Math.round(rate * 10000) / 10000;

    const order: Partial<Order> = {
      applyDate: draft.applyDate || '',
      paybackDate: draft.paybackDate || '',
      name,
      phone,
      province: (draft.province || '').trim(),
      city: (draft.city || '').trim(),
      carrier: draft.carrier || '联通',
      package: draft.package || '300m',
      duration: draft.duration || '1年',
      installFee: Number(draft.installFee) || 0,
      packageFee,
      commission,
      commissionRate: rate,
      idCard,
      address: (draft.address || '').trim(),
      // 编辑时保留该订单原来的 salesPerson（改归属只能走 claimOrder），
      // 新增才落到当前账号名下
      salesPerson:
        editingId != null
          ? state.allOrders.find((o) => o.id === editingId)?.salesPerson || SALES_PERSON
          : SALES_PERSON,
    };

    set({ saving: true, error: '' });
    try {
      if (editingId != null) {
        await patchOrder(editingId, toRow(order));
      } else {
        await insertOrder(toRow(order));
      }
      await refreshData();
      return true;
    } catch (e) {
      set({ saving: false, error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  },

  /**
   * 删除：先把删除前的完整数据留下来（撤销时原样插回），失败不抛出、
   * 返回 false 让 UI 出提示。
   */
  async removeOrder(id: number): Promise<boolean> {
    const o = state.allOrders.find((x) => x.id === id);
    if (!o) return false;
    lastDeleteSnapshot = toRow(o);
    set({ saving: true, error: '' });
    try {
      await deleteOrder(id);
      await refreshData();
      return true;
    } catch (e) {
      set({ saving: false, error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  },

  /** 把删掉的订单重新插回去（撤销删除）。 */
  async reinsertOrder(row: OrderRow): Promise<boolean> {
    set({ saving: true, error: '' });
    try {
      await reinsertOrder(row);
      await refreshData();
      return true;
    } catch (e) {
      set({ saving: false, error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  },

  /** 把历史订单改到自己名下：只 PATCH sales_person 一个字段。 */
  async claimOrder(o: Order): Promise<boolean> {
    set({ saving: true, error: '' });
    try {
      await patchOrder(o.id, { sales_person: SALES_PERSON });
      await refreshData();
      return true;
    } catch (e) {
      set({ saving: false, error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  },

  /**
   * CSV 导入：rows 是不含 id 的待写入行，分批 POST（一批要么全进要么
   * 全不进，不会留半截）。重复判定在 buildImportPlan 阶段就做完了，
   * 所以这里的 skipped 恒为 0（UI 的「跳过 N 条重复」读的是 plan.skipped）。
   */
  async importCsv(rows: OrderRow[]): Promise<{ ok: number; skipped: number }> {
    set({ saving: true, error: '' });
    const CHUNK = 100; // 分批提交，避免一条一条发请求
    let ok = 0;
    const errors: string[] = [];
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      try {
        await insertOrders(chunk);
        ok += chunk.length;
      } catch (e) {
        errors.push('第 ' + (i + 1) + '–' + Math.min(i + chunk.length, rows.length) + ' 条：' +
          (e instanceof Error ? e.message : String(e)));
      }
    }
    await refreshData();
    set({ saving: false });
    if (errors.length) set({ error: '部分批次失败：' + errors.join('；') });
    return { ok, skipped: 0 };
  },

  setTrendMetric(m: 'commission' | 'count'): void {
    try { localStorage.setItem(TREND_METRIC_KEY, m); } catch { /* 忽略 */ }
    set({ trendMetric: m });
  },
};

/** React 订阅入口：只读快照。 */
export function useOrderState(): OrderSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** React 订阅入口：快照 + 全部 action（action 引用稳定，可直接进依赖数组）。 */
export type OrderStore = OrderSnapshot & typeof actions;

export function useOrders(): OrderStore {
  const snapshot = useOrderState();
  return { ...snapshot, ...actions };
}
