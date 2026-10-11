import { describe, it, expect, vi, beforeEach } from 'vitest';

// client 是外部边界（fetch/缓存），整块 mock 掉；store 只测自己的业务逻辑。
// toRow/fromRow 是纯映射，保留真实现（mock 掉的话断言 sales_person 就没意义了）。
// 注意 vi.resetModules() 不会重置 mock 注册表：factory 结果跨用例共享，
// 所以 beforeEach 里还要 clearAllMocks 清掉调用计数。
vi.mock('../src/orders/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/orders/client')>();
  return {
    ...actual,
    loadOrders: vi.fn(async () => ({ rows: [], truncatedTotal: 0, countUnverified: false, usingCache: false, cachedAt: 0 })),
    insertOrder: vi.fn(async () => undefined),
    insertOrders: vi.fn(async () => undefined),
    patchOrder: vi.fn(async () => undefined),
    deleteOrder: vi.fn(async () => undefined),
    reinsertOrder: vi.fn(async () => undefined),
    orderSession: {
      restore: vi.fn(() => null),
      hasStored: vi.fn(() => false),
      login: vi.fn(async () => ({ ok: true, error: '' })),
      refresh: vi.fn(async () => null),
      logout: vi.fn(),
      current: vi.fn(() => null),
    },
    clearCachedOrders: vi.fn(),
  };
});

import { SALES_PERSON, TREND_METRIC_KEY } from '../src/orders/config';
import { EMPTY_FILTERS } from '../src/orders/types';
import { mkOrder } from './order-fixture';
import type { Order } from '../src/orders/types';

// store 是模块级单例（bootstrapped 守卫、删除快照都是模块级变量），
// 每个用例重置模块注册表，拿一份全新的 store / client / confirm。
let store: typeof import('../src/orders/store');
let client: typeof import('../src/orders/client');
let confirm: typeof import('../src/orders/confirm');

beforeEach(async () => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.resetModules();
  store = await import('../src/orders/store');
  client = await import('../src/orders/client');
  confirm = await import('../src/orders/confirm');
});

/** 登录态 + 给定订单载入（模拟 bootstrap 成功后的数据就绪）。 */
async function loadAsReady(orders: Order[]): Promise<void> {
  vi.mocked(client.loadOrders).mockImplementation(async () => ({
    rows: orders, truncatedTotal: 0, countUnverified: false, usingCache: false, cachedAt: 0,
  }));
  vi.mocked(client.orderSession.restore).mockReturnValue({
    token: 't', refresh: 'r', expiresAt: Date.now() + 60000,
  });
  await store.actions.bootstrap();
}

describe('bootstrap', () => {
  it('无会话 → needs-password，不拉数据', async () => {
    await store.actions.bootstrap();
    const s = store.readSnapshot();
    expect(s.bootstate).toBe('needs-password');
    expect(s.needsPassword).toBe(true);
    expect(client.loadOrders).not.toHaveBeenCalled();
  });

  it('无会话但留有残缺存储 → 提示重新输密码', async () => {
    vi.mocked(client.orderSession.hasStored).mockReturnValue(true);
    await store.actions.bootstrap();
    expect(store.readSnapshot().error).toBe('请重新输入密码，以连接数据库');
  });

  it('会话有效 → ready 并拉数据', async () => {
    await loadAsReady([mkOrder()]);
    const s = store.readSnapshot();
    expect(s.bootstate).toBe('ready');
    expect(s.ready).toBe(true);
    expect(s.allOrders).toHaveLength(1);
    expect(s.needsPassword).toBe(false);
  });

  it('会话过期且续期失败 → 清会话回密码页', async () => {
    vi.mocked(client.orderSession.restore).mockReturnValue({
      token: 't', refresh: 'r', expiresAt: Date.now() - 1,
    });
    vi.mocked(client.orderSession.refresh).mockResolvedValue(null);
    await store.actions.bootstrap();
    expect(client.orderSession.logout).toHaveBeenCalled();
    const s = store.readSnapshot();
    expect(s.bootstate).toBe('needs-password');
    expect(s.error).toBe('登录已过期，请重新输入密码');
    expect(client.loadOrders).not.toHaveBeenCalled();
  });

  it('StrictMode 下二次调用不重复拉数据（bootstrapped 守卫）', async () => {
    await loadAsReady([]);
    await store.actions.bootstrap();
    expect(client.loadOrders).toHaveBeenCalledTimes(1);
  });
});

describe('login / logout', () => {
  it('login 成功 → ready 并拉数据', async () => {
    expect(await store.actions.login('pw', true)).toBe(true);
    const s = store.readSnapshot();
    expect(s.bootstate).toBe('ready');
    expect(s.needsPassword).toBe(false);
    expect(client.loadOrders).toHaveBeenCalled();
  });

  it('login 失败 → error 透传，不拉数据', async () => {
    vi.mocked(client.orderSession.login).mockResolvedValueOnce({ ok: false, error: '密码不对' });
    expect(await store.actions.login('bad', false)).toBe(false);
    const s = store.readSnapshot();
    expect(s.error).toBe('密码不对');
    expect(s.bootstate).toBe('loading'); // 停留在登录前
    expect(client.loadOrders).not.toHaveBeenCalled();
  });

  it('logout：清会话与订单缓存，列表清空回密码页', async () => {
    await loadAsReady([mkOrder()]);
    store.actions.logout();
    expect(client.orderSession.logout).toHaveBeenCalled();
    expect(client.clearCachedOrders).toHaveBeenCalled();
    const s = store.readSnapshot();
    expect(s.bootstate).toBe('needs-password');
    expect(s.allOrders).toEqual([]);
    expect(s.orders).toEqual([]);
    expect(s.ready).toBe(false);
    expect(s.modal).toBeNull();
  });
});

describe('视图与筛选', () => {
  const mine = mkOrder({ id: 1, salesPerson: SALES_PERSON });
  const other = mkOrder({ id: 2, salesPerson: '别人' });

  it('mine 视图只看自己的，hiddenCount 是对方的条数', async () => {
    await loadAsReady([mine, other]);
    const s = store.readSnapshot();
    expect(s.orders).toEqual([mine]);
    expect(s.hiddenCount).toBe(1);
    expect(s.allOrders).toHaveLength(2);
  });

  it('toggleView 只重切不重新请求，并把省份/城市清空', async () => {
    await loadAsReady([mine, other]);
    vi.mocked(client.loadOrders).mockClear();
    store.actions.patchFilters({ province: '广东', city: '广州', q: '张三' });
    store.actions.toggleView();
    const s = store.readSnapshot();
    expect(s.view).toBe('all');
    expect(client.loadOrders).not.toHaveBeenCalled();
    expect(s.orders).toEqual([other]);
    expect(s.hiddenCount).toBe(1);
    expect(s.filters.province).toBe('');
    expect(s.filters.city).toBe('');
    expect(s.filters.q).toBe('张三'); // 其他筛选保留
    expect(s.filters.view).toBe('all');
  });

  it('patchFilters：省份变化清城市，省份没变保留城市', async () => {
    await loadAsReady([]);
    store.actions.patchFilters({ province: '广东', city: '广州' });
    store.actions.patchFilters({ province: '江苏' });
    expect(store.readSnapshot().filters.province).toBe('江苏');
    expect(store.readSnapshot().filters.city).toBe('');
    store.actions.patchFilters({ province: '江苏', city: '南京' });
    store.actions.patchFilters({ province: '江苏' }); // 同值不清城市
    expect(store.readSnapshot().filters.city).toBe('南京');
  });

  it('clearFilters 保留排序与视图', async () => {
    await loadAsReady([]);
    store.actions.setSort('packageFee');
    store.actions.setSort('packageFee'); // 同列反向
    store.actions.patchFilters({ q: '张', province: '广东', payback: 'paid' });
    store.actions.clearFilters();
    const f = store.readSnapshot().filters;
    expect(f.sort).toBe('packageFee');
    expect(f.desc).toBe(false);
    expect(f.q).toBe('');
    expect(f.province).toBe('');
    expect(f.payback).toBe(EMPTY_FILTERS.payback);
    expect(f.view).toBe('mine');
  });

  it('setSort：同列再点反向，换列回降序', async () => {
    // 初始 sort=applyDate、desc=true（EMPTY_FILTERS），同列再点是反向
    store.actions.setSort('commission');
    expect(store.readSnapshot().filters.sort).toBe('commission');
    expect(store.readSnapshot().filters.desc).toBe(true);
    store.actions.setSort('commission');
    expect(store.readSnapshot().filters.desc).toBe(false);
    store.actions.setSort('applyDate');
    expect(store.readSnapshot().filters.sort).toBe('applyDate');
    expect(store.readSnapshot().filters.desc).toBe(true);
  });
});

describe('modal', () => {
  it('openForm 新增：editingId=null，seed 只带今天的办理日期', () => {
    store.actions.openForm();
    const m = store.readSnapshot().modal;
    expect(m?.kind).toBe('form');
    if (m?.kind === 'form') {
      expect(m.editingId).toBeNull();
      expect(m.seed).toEqual({ applyDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
      expect(m.seed).not.toHaveProperty('id');
    }
  });

  it('openForm 编辑：editingId 按订单 id（不按下标），seed 是完整拷贝', () => {
    const o = mkOrder({ id: 7 });
    store.actions.openForm(o);
    const m = store.readSnapshot().modal;
    if (m?.kind === 'form') {
      expect(m.editingId).toBe(7);
      expect(m.seed).toEqual(o);
      expect(m.seed).not.toBe(o); // 拷贝，不共享引用
    }
  });

  it('openDetail / openCsv / openLogs / openSmart / closeModal', () => {
    const o = mkOrder({ id: 3 });
    store.actions.openDetail(o);
    expect(store.readSnapshot().modal).toEqual({ kind: 'detail', order: o });
    store.actions.openCsv();
    expect(store.readSnapshot().modal).toEqual({ kind: 'csv' });
    store.actions.openLogs(o);
    expect(store.readSnapshot().modal).toEqual({ kind: 'logs', order: o });
    store.actions.openSmart();
    expect(store.readSnapshot().modal).toEqual({ kind: 'smart' });
    store.actions.closeModal();
    expect(store.readSnapshot().modal).toBeNull();
  });
});

describe('submitOrder', () => {
  it('必填校验：姓名/手机号/套餐费', async () => {
    await loadAsReady([]);
    expect(await store.actions.submitOrder({ name: '', phone: '17365306527', packageFee: 600 })).toBe(false);
    expect(store.readSnapshot().error).toBe('请填写姓名、手机号和套餐费');
    expect(await store.actions.submitOrder({ name: '张三', phone: '', packageFee: 600 })).toBe(false);
    expect(await store.actions.submitOrder({ name: '张三', phone: '17365306527', packageFee: 0 })).toBe(false);
    expect(client.insertOrder).not.toHaveBeenCalled();
  });

  it('手机号格式 / 身份证格式 / 结佣日期早于办理日期', async () => {
    await loadAsReady([]);
    expect(await store.actions.submitOrder({ name: '张三', phone: '123', packageFee: 600 })).toBe(false);
    expect(store.readSnapshot().error).toBe('手机号格式不正确，应为 11 位数字');
    expect(await store.actions.submitOrder({ name: '张三', phone: '17365306527', packageFee: 600, idCard: '123' })).toBe(false);
    expect(store.readSnapshot().error).toBe('身份证号格式不正确，应为 18 位');
    expect(await store.actions.submitOrder({
      name: '张三', phone: '17365306527', packageFee: 600,
      applyDate: '2026-09-10', paybackDate: '2026-09-01',
    })).toBe(false);
    expect(store.readSnapshot().error).toBe('结佣日期不能早于办理日期');
  });

  it('新增成功：落到 SALES_PERSON 名下，rate 未传时按 commission/packageFee 现算', async () => {
    await loadAsReady([]);
    const ok = await store.actions.submitOrder({
      name: '张三', phone: '17365306527', packageFee: 600, commission: 300,
      applyDate: '2026-09-01', carrier: '联通', package: '300m', duration: '1年',
    });
    expect(ok).toBe(true);
    expect(client.insertOrder).toHaveBeenCalledTimes(1);
    const row = vi.mocked(client.insertOrder).mock.calls[0][0];
    expect(row.sales_person).toBe(SALES_PERSON);
    expect(row.commission_rate).toBe(0.5);
    expect(row.name).toBe('张三');
  });

  it('新增成功：rate 已传时原样收下（4 位小数舍入）', async () => {
    await loadAsReady([]);
    await store.actions.submitOrder({
      name: '张三', phone: '17365306527', packageFee: 600, commission: 300,
      commissionRate: 0.33333,
    });
    expect(vi.mocked(client.insertOrder).mock.calls[0][0].commission_rate).toBe(0.3333);
  });

  it('编辑：走 patchOrder 并保留原 salesPerson（归属只能走 claimOrder）', async () => {
    await loadAsReady([mkOrder({ id: 5, salesPerson: '别人' })]);
    store.actions.openForm(mkOrder({ id: 5, salesPerson: '别人' }));
    const ok = await store.actions.submitOrder({
      id: 5, name: '张三', phone: '17365306527', packageFee: 600, commission: 300,
    });
    expect(ok).toBe(true);
    expect(client.patchOrder).toHaveBeenCalledTimes(1);
    expect(client.insertOrder).not.toHaveBeenCalled();
    const row = vi.mocked(client.patchOrder).mock.calls[0][1];
    expect(row.sales_person).toBe('别人');
  });

  it('表单新增撞到已有手机号：confirm 拒绝则不保存，同意才保存（旧版 saveOrder 的确认）', async () => {
    await loadAsReady([mkOrder({ id: 1, phone: '17365306527', name: '张三' })]);
    const spy = vi.fn<(message: string) => Promise<boolean>>(async () => false);
    const restore = confirm.setConfirmImpl(spy);
    store.actions.openForm(); // modal.kind==='form' 且 editingId=null → 新增
    const refused = await store.actions.submitOrder({
      name: '李四', phone: '17365306527', packageFee: 600,
    });
    expect(refused).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toContain('17365306527');
    expect(client.insertOrder).not.toHaveBeenCalled();

    spy.mockImplementation(async () => true);
    const accepted = await store.actions.submitOrder({
      name: '李四', phone: '17365306527', packageFee: 600,
    });
    expect(accepted).toBe(true);
    expect(client.insertOrder).toHaveBeenCalledTimes(1);
    confirm.setConfirmImpl(restore);
  });

  it('撞到的那条归属不是本人：确认文案带上归属（旧版 isMine 分支）', async () => {
    await loadAsReady([mkOrder({ id: 1, phone: '17365306527', salesPerson: '别人' })]);
    const spy = vi.fn<(message: string) => Promise<boolean>>(async () => true);
    const restore = confirm.setConfirmImpl(spy);
    store.actions.openForm();
    await store.actions.submitOrder({ name: '李四', phone: '17365306527', packageFee: 600 });
    expect(spy.mock.calls[0][0]).toContain('归属：别人');
    confirm.setConfirmImpl(restore);
  });

  it('编辑自己已有的手机号不弹确认（只有新增才查重）', async () => {
    await loadAsReady([mkOrder({ id: 1, phone: '17365306527' })]);
    const spy = vi.fn<(message: string) => Promise<boolean>>(async () => false);
    const restore = confirm.setConfirmImpl(spy);
    store.actions.openForm(mkOrder({ id: 1, phone: '17365306527' }));
    const ok = await store.actions.submitOrder({
      id: 1, name: '张三改', phone: '17365306527', packageFee: 600,
    });
    expect(ok).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    confirm.setConfirmImpl(restore);
  });

  it('智能录入批量不弹 store 的 confirm（旧版 saveSmartBatch 直接入库，撞重靠默认不勾选）', async () => {
    await loadAsReady([mkOrder({ id: 1, phone: '17365306527' })]);
    const spy = vi.fn<(message: string) => Promise<boolean>>(async () => false);
    const restore = confirm.setConfirmImpl(spy);
    store.actions.openSmart(); // modal.kind==='smart'
    const ok = await store.actions.submitOrder({
      name: '李四', phone: '17365306527', packageFee: 600,
    });
    expect(ok).toBe(true); // 不被 confirm 挡
    expect(spy).not.toHaveBeenCalled();
    expect(client.insertOrder).toHaveBeenCalledTimes(1);
    confirm.setConfirmImpl(restore);
  });

  it('无 modal 的程序化提交不弹 confirm（与智能批量同一口径：只表单查重）', async () => {
    await loadAsReady([mkOrder({ id: 1, phone: '17365306527' })]);
    const spy = vi.fn<(message: string) => Promise<boolean>>(async () => false);
    const restore = confirm.setConfirmImpl(spy);
    const ok = await store.actions.submitOrder({
      name: '李四', phone: '17365306527', packageFee: 600,
    });
    expect(ok).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    confirm.setConfirmImpl(restore);
  });

  it('保存失败：error 记录 HTTP 文案并返回 false', async () => {
    await loadAsReady([]);
    vi.mocked(client.insertOrder).mockRejectedValueOnce(new Error('HTTP 409 conflict'));
    const ok = await store.actions.submitOrder({
      name: '张三', phone: '17365306527', packageFee: 600,
    });
    expect(ok).toBe(false);
    expect(store.readSnapshot().error).toBe('HTTP 409 conflict');
    expect(store.readSnapshot().saving).toBe(false);
  });
});

describe('removeOrder / reinsertOrder', () => {
  it('删除前留快照（撤销用），成功后刷新', async () => {
    const o = mkOrder({ id: 9 });
    await loadAsReady([o]);
    expect(await store.actions.removeOrder(9)).toBe(true);
    expect(client.deleteOrder).toHaveBeenCalledWith(9);
    const row = store.takeLastDeleteSnapshot();
    expect(row).not.toBeNull();
    expect(row?.phone).toBe(o.phone);
    expect(store.takeLastDeleteSnapshot()).toBeNull(); // 取出即清
  });

  it('删除不存在的 id → false 且不留快照', async () => {
    await loadAsReady([]);
    expect(await store.actions.removeOrder(999)).toBe(false);
    expect(store.takeLastDeleteSnapshot()).toBeNull();
  });

  it('删除失败：返回 false、error 记录、快照仍可取', async () => {
    await loadAsReady([mkOrder({ id: 9 })]);
    vi.mocked(client.deleteOrder).mockRejectedValueOnce(new Error('HTTP 500'));
    expect(await store.actions.removeOrder(9)).toBe(false);
    expect(store.readSnapshot().error).toBe('HTTP 500');
    expect(store.takeLastDeleteSnapshot()).not.toBeNull();
  });

  it('reinsertOrder：撤销删除走插入 + 刷新', async () => {
    await loadAsReady([]);
    const row = { name: '张三', phone: '17365306527' } as Parameters<typeof store.actions.reinsertOrder>[0];
    expect(await store.actions.reinsertOrder(row)).toBe(true);
    expect(vi.mocked(client.reinsertOrder)).toHaveBeenCalledWith(row);
  });
});

describe('claimOrder', () => {
  it('只 PATCH sales_person 一个字段', async () => {
    await loadAsReady([mkOrder({ id: 4, salesPerson: '别人' })]);
    expect(await store.actions.claimOrder(mkOrder({ id: 4, salesPerson: '别人' }))).toBe(true);
    expect(client.patchOrder).toHaveBeenCalledWith(4, { sales_person: SALES_PERSON });
  });
});

describe('importCsv', () => {
  const rows120 = (): Parameters<typeof store.actions.importCsv>[0] =>
    Array.from({ length: 120 }, (_, i) => ({
      name: '用户' + i, phone: '13900000' + String(i).padStart(3, '0'),
    })) as Parameters<typeof store.actions.importCsv>[0];

  it('120 条分两批 POST（100 + 20）；skipped 恒为 0', async () => {
    await loadAsReady([]);
    const r = await store.actions.importCsv(rows120());
    expect(r).toEqual({ ok: 120, skipped: 0 });
    expect(vi.mocked(client.insertOrders)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(client.insertOrders).mock.calls[0][0]).toHaveLength(100);
    expect(vi.mocked(client.insertOrders).mock.calls[1][0]).toHaveLength(20);
  });

  it('某批失败：其余照发，error 汇总，ok 只数成功批次', async () => {
    await loadAsReady([]);
    vi.mocked(client.insertOrders).mockRejectedValueOnce(new Error('HTTP 400'));
    const r = await store.actions.importCsv(rows120());
    expect(r.ok).toBe(20);
    expect(store.readSnapshot().error).toContain('部分批次失败');
    expect(store.readSnapshot().error).toContain('1–100');
  });
});

describe('杂项', () => {
  it('setTrendMetric 持久化到 localStorage', () => {
    store.actions.setTrendMetric('count');
    expect(localStorage.getItem(TREND_METRIC_KEY)).toBe('count');
    expect(store.readSnapshot().trendMetric).toBe('count');
    store.actions.setTrendMetric('commission');
    expect(localStorage.getItem(TREND_METRIC_KEY)).toBe('commission');
  });

  it('快照引用稳定：不改状态时多次取到同一对象，变化时换新对象', () => {
    const s1 = store.readSnapshot();
    expect(store.readSnapshot()).toBe(s1); // useSyncExternalStore 依赖这一点
    store.actions.setSearch('x');
    const s2 = store.readSnapshot();
    expect(s2).not.toBe(s1);
    expect(s2.filters.q).toBe('x');
  });

  it('loadOrders 失败：ready=true 且 error 记录（缓存兜底由 client 负责）', async () => {
    vi.mocked(client.orderSession.restore).mockReturnValue({
      token: 't', refresh: 'r', expiresAt: Date.now() + 60000,
    });
    vi.mocked(client.loadOrders).mockRejectedValueOnce(new Error('HTTP 500'));
    await store.actions.bootstrap();
    const s = store.readSnapshot();
    expect(s.ready).toBe(true);
    expect(s.error).toBe('HTTP 500');
  });
});
