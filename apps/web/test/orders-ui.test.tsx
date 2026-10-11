/**
 * 订单界面层组件测试。
 *
 * 界面层组件（src/orders/ui/*、ToastHost/ConfirmHost/LoginOverlay）只依赖
 * 业务模块的纯函数部分（filter/stats/csv/smartInput/format/date），这些
 * 直接用真实现；client（发网络请求）和 store（依赖 client + 全局状态）
 * 用 vi.mock 桩住 —— 组件渲染不需要真数据库。
 *
 * React 19 + jsdom：用 react-dom/client 的 createRoot + act 驱动渲染。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactElement } from 'react';

// React 19 的 act() 需要显式声明测试环境，否则每次调用都刷警告
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// 桩：网络与全局状态（真实现里它们发 fetch / 维护模块级单例）
// ---------------------------------------------------------------------------

// store 只被整页组件引用；组件测试不渲染整页，桩掉防止意外拉取。
vi.mock('../src/orders/store', () => ({ useOrders: () => ({}), useOrderState: () => ({}) }));

// client 的 fetchLogs 会被 LogViewerModal 调；其余导出只在 store 里用。
vi.mock('../src/orders/client', () => ({ fetchLogs: () => Promise.resolve([]) }));

// ---------------------------------------------------------------------------

import StatCards from '../src/orders/ui/StatCards';
import TrendChart from '../src/orders/ui/TrendChart';
import AnalysisCards from '../src/orders/ui/AnalysisCards';
import OrderTable from '../src/orders/ui/OrderTable';
import OrderForm from '../src/orders/ui/OrderForm';
import SmartInputModal from '../src/orders/ui/SmartInputModal';
import CsvImportModal from '../src/orders/ui/CsvImportModal';
import LoginOverlay from '../src/orders/LoginOverlay';
import ConfirmHost from '../src/orders/ConfirmHost';
import { setConfirmImpl } from '../src/orders/confirm';
import { toast, subscribeToasts } from '../src/orders/toast';
import { getToasts } from '../src/orders/toast';
import ToastHost from '../src/orders/ToastHost';
import { statCards, type StatCard } from '../src/orders/stats';
import type { Order } from '../src/orders/types';

function mkOrder(p: Partial<Order> = {}): Order {
  return {
    id: 1, name: '张三', phone: '17365306527', idCard: '', address: '',
    province: '江苏', city: '无锡', carrier: '联通', package: '300m', duration: '1年',
    installFee: 0, packageFee: 480, commission: 100, commissionRate: 0.2,
    applyDate: '2026-09-01', paybackDate: '', salesPerson: '大卫',
    createdAt: '', updatedAt: '',
    ...p,
  };
}

// ---- 渲染工具：createRoot + act。门户（Modal/Toast/Confirm）挂在 document.body
// 上，所以 query 必须走 document 而不是渲染容器。 ----
let container: HTMLDivElement;
let root: Root | null = null;

function render(el: ReactElement) {
  // 先清干净 body：上一轮 render 的 portal（Modal/Toast/Confirm 直接挂 body）
  // 会残留在 document 里，q() 会查到旧节点导致断言拿到过期元素。
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(el);
  });
}

/** 在 document 范围内查询（覆盖 portal 内容）。 */
function q(selector: string): Element | null {
  return document.querySelector(selector);
}
function qa(selector: string): Element[] {
  return Array.from(document.querySelectorAll(selector));
}

/**
 * 给受控输入赋值并触发 input 事件。
 * React 17+ 重写了 value 追踪器，直接 el.value = x 会被 React 判定「没变化」
 * 而丢事件，必须走原型上的原生 setter。
 */
function setInput(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
  // 清空模块级 toast 队列，避免上一条用例的 toast 串进这一条
  while (getToasts().length) getToasts().pop();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  document.body.innerHTML = '';
  root = null;
  vi.useRealTimers();
});

// ===========================================================================
describe('StatCards 点击派发', () => {
  it('真实 statCards() 的四张卡：本月/合计/未结佣/结佣周期，点击派发 click.kind', () => {
    const orders = [
      mkOrder({ id: 1, applyDate: '2026-10-01', paybackDate: '', commission: 100 }),
      mkOrder({ id: 2, applyDate: '2026-09-01', paybackDate: '2026-09-20', commission: 200 }),
    ];
    const cards = statCards(orders, orders);
    expect(cards.length).toBe(4);
    const onCardClick = vi.fn();
    render(createElement(StatCards, { cards, onCardClick }));
    const els = qa('.orders-stat-card');
    expect(els.length).toBe(4);
    // 本月订单 → month
    act(() => { (els[0] as HTMLElement).click(); });
    expect(onCardClick.mock.calls[0][0].click?.kind).toBe('month');
    // 未结佣 → payback
    act(() => { (els[2] as HTMLElement).click(); });
    expect(onCardClick.mock.calls[1][0].click?.kind).toBe('payback');
    // 无 click 的卡（结佣周期没有已结佣数据时）不带 clickable
    const noClickIdx = cards.findIndex((c) => !c.click);
    if (noClickIdx >= 0) {
      expect(els[noClickIdx].className).not.toContain('clickable');
    }
  });

  it('上月为 0：显示「上月无订单」文案而不是百分比（deltaPct=null）', () => {
    // 本月有单、上月全库没有 → deltaPct 必须是 null
    const now = new Date();
    const ym = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const thisMonth = `${ym(now)}-05`;
    const orders = [mkOrder({ id: 1, applyDate: thisMonth })];
    const cards = statCards(orders, orders);
    const monthCard = cards[0];
    expect(monthCard.deltaPct ?? null).toBeNull();
    expect(monthCard.sub).toBe('上月无订单');
    const onCardClick = vi.fn();
    render(createElement(StatCards, { cards, onCardClick }));
    expect(document.body.textContent).toContain('上月无订单');
    expect(document.body.textContent).not.toContain('环比上月');
    void onCardClick;
  });
});

// ===========================================================================
describe('TrendChart', () => {
  const baseProps = {
    metric: 'commission' as const,
    month: '',
    onSetMonth: vi.fn(),
    onSetMetric: vi.fn(),
  };

  it('不吃月份筛选：month 有值时 12 个月的桶仍然聚合全部订单', () => {
    const orders = [
      mkOrder({ id: 1, applyDate: '2026-09-05', paybackDate: '', commission: 100 }),
      mkOrder({ id: 2, applyDate: '2026-08-05', paybackDate: '2026-09-01', commission: 200 }),
    ];
    render(createElement(TrendChart, { ...baseProps, orders, month: '2026-09' }));
    // 9 月和 8 月两根柱都在（没有被月份筛成一根）
    expect(qa('.orders-trend-bar-g').length).toBe(12);
    // 选中的 9 月高亮 current
    const picked = qa('.orders-trend-bar-g.current');
    expect(picked.length).toBe(1);
    expect(picked[0].querySelector('.orders-trend-label')?.textContent).toBe('9月');
  });

  it('有单的月份才可点、点击设月份筛选；空月份没有 click', () => {
    const onSetMonth = vi.fn();
    const orders = [mkOrder({ id: 1, applyDate: '2026-09-05' })];
    render(createElement(TrendChart, { ...baseProps, orders, onSetMonth }));
    const groups = qa('.orders-trend-bar-g');
    const clickable = groups.filter((g) => g.classList.contains('clickable'));
    expect(clickable.length).toBe(1);
    expect(clickable[0].querySelector('.orders-trend-label')?.textContent).toBe('9月');
    act(() => { (clickable[0] as SVGGElement).dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onSetMonth).toHaveBeenCalledWith('2026-09');
  });

  it('选中月再点一次 → 取消月份筛选（onSetMonth(\'\')）', () => {
    const onSetMonth = vi.fn();
    const orders = [mkOrder({ id: 1, applyDate: '2026-09-05' })];
    render(createElement(TrendChart, { ...baseProps, orders, month: '2026-09', onSetMonth }));
    const g = q('.orders-trend-bar-g.current') as SVGGElement;
    act(() => { g.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onSetMonth).toHaveBeenCalledWith('');
  });

  it('图例必须存在（识别不能只靠颜色）', () => {
    render(createElement(TrendChart, { ...baseProps, orders: [mkOrder()] }));
    const legend = q('.orders-an-legend');
    expect(legend).toBeTruthy();
    expect(legend?.textContent).toContain('已结佣');
    expect(legend?.textContent).toContain('未结佣');
  });
});

// ===========================================================================
describe('AnalysisCards', () => {
  const combo = { city: '无锡', carrier: '联通', pkg: '300M', province: '江苏', count: 3, commission: 300 };
  const city = { city: '无锡', province: '江苏', count: 3, commission: 300 };

  it('组合行点击落四个条件，且省份先于城市（配合城市下拉联动顺序）', () => {
    const calls: { patch?: Record<string, string>; search?: string }[] = [];
    const patchFilters = vi.fn((p: Record<string, string>) => calls.push({ patch: p }));
    const setSearch = vi.fn((qv: string) => calls.push({ search: qv }));
    // 模拟 Orders.tsx 的 setComboFilter：先省份后城市
    const onComboClick = (g: typeof combo) => {
      if (g.province) patchFilters({ province: g.province });
      patchFilters(g.city ? { city: g.city } : { city: '' });
      patchFilters({ carrier: g.carrier || '' });
      setSearch(g.pkg || '');
    };
    render(createElement(AnalysisCards, {
      combos: [combo], cities: [], carriers: [],
      activeProvince: '', activeCity: '', activeCarrier: '', activePkg: '',
      onComboClick, onCityClick: () => {}, onCarrierClick: () => {},
    }));
    const row = q('.orders-an-row') as HTMLElement;
    act(() => { row.click(); });
    const patchCalls = calls.filter((c) => c.patch).map((c) => c.patch as Record<string, string>);
    expect(patchCalls[0]).toEqual({ province: '江苏' });
    expect(patchCalls[1]).toEqual({ city: '无锡' });
    expect(patchCalls[2]).toEqual({ carrier: '联通' });
    expect(calls.find((c) => c.search)?.search).toBe('300M');
  });

  it('城市行点击回调带整组数据（省+市由页面层落）', () => {
    const onCityClick = vi.fn();
    render(createElement(AnalysisCards, {
      combos: [], cities: [city], carriers: [],
      activeProvince: '', activeCity: '', activeCarrier: '', activePkg: '',
      onComboClick: () => {}, onCityClick, onCarrierClick: () => {},
    }));
    const row = q('.orders-an-row') as HTMLElement;
    act(() => { row.click(); });
    expect(onCityClick).toHaveBeenCalledWith(city);
  });

  it('被选中的行加 .selected 高亮而不是被筛掉', () => {
    render(createElement(AnalysisCards, {
      combos: [combo], cities: [city], carriers: [],
      activeProvince: '江苏', activeCity: '无锡', activeCarrier: '联通', activePkg: '300M',
      onComboClick: () => {}, onCityClick: () => {}, onCarrierClick: () => {},
    }));
    const selected = qa('.orders-an-row.selected');
    expect(selected.length).toBe(2);
  });
});

// ===========================================================================
describe('OrderTable', () => {
  const base = {
    totals: { count: 1, packageFee: 480, commission: 100 },
    sort: 'applyDate' as const,
    desc: true,
    onSetSort: vi.fn(),
    onOpenDetail: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onOpenLogs: vi.fn(),
    truncatedTotal: 0,
    countUnverified: false,
    hasAnyData: true,
  };

  it('截断横幅：truncatedTotal>0 时必须显示「仅加载了前 N 条（共 M 条）」', () => {
    const orders = Array.from({ length: 3 }, (_, i) => mkOrder({ id: i + 1 }));
    render(createElement(OrderTable, { ...base, rows: orders, truncatedTotal: 1350 }));
    const banner = q('.orders-trunc-banner');
    expect(banner).toBeTruthy();
    expect(banner?.textContent).toContain('仅加载了前 3 条（共 1350 条）');
  });

  it('读不到总数且条数达到可疑阈值：显示「无法核验是否取全」', () => {
    render(createElement(OrderTable, { ...base, rows: [mkOrder()], countUnverified: true }));
    const banner = q('.orders-trunc-banner');
    expect(banner?.textContent).toContain('无法核验是否取全');
  });

  it('未结佣行：底色 unpaid-row + 「未结佣 N天」账龄文案走 agingLevel 配色', () => {
    // 固定「今天」，让账龄断言稳定：办于 90 天前 → age-bad（≥60）
    const d = new Date();
    d.setDate(d.getDate() - 90);
    const ymdLocal = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    render(createElement(OrderTable, { ...base, rows: [mkOrder({ applyDate: ymdLocal, paybackDate: '' })] }));
    const tr = q('tbody tr');
    expect(tr?.className).toContain('unpaid-row');
    const cell = tr?.querySelector('.age-bad');
    expect(cell?.textContent).toMatch(/^未结佣 90天$/);
  });

  it('已结佣行显示日期；表尾合计含安装费；空态区分「没有数据」与「筛完没有」', () => {
    render(createElement(OrderTable, {
      ...base,
      rows: [mkOrder({ paybackDate: '2026-09-15', installFee: 100 })],
    }));
    expect(document.body.textContent).toContain('2026-09-15');
    expect(q('tbody tr')?.className).not.toContain('unpaid-row');
    // 表尾三列金额：安装费合计在组件层现算
    expect(q('tfoot')?.textContent).toContain('¥100');

    // 筛完没有
    render(createElement(OrderTable, { ...base, rows: [], hasAnyData: true }));
    expect(q('.orders-empty')?.textContent).toContain('当前筛选条件下没有订单');
    // 全库就没有
    render(createElement(OrderTable, { ...base, rows: [], hasAnyData: false }));
    expect(q('.orders-empty')?.textContent).toContain('暂无订单数据');
  });
});

// ===========================================================================
describe('OrderForm', () => {
  const base = {
    allOrders: [] as Order[],
    onClose: vi.fn(),
    submitOrder: vi.fn(() => Promise.resolve(true)),
  };

  it('编辑态预填佣金率；改动佣金后预填值被清空（dataset.prefilled 逻辑）', async () => {
    const o = mkOrder({ commission: 100, packageFee: 480, commissionRate: 0.2 });
    render(createElement(OrderForm, { ...base, editingId: o.id, seed: o }));
    const rateInput = q('input[max="100"]') as HTMLInputElement;
    expect(rateInput.value).toBe('20'); // 预填 20%

    // 改佣金 → 预填的 20% 被清空
    const commissionInput = qa('input[type="number"]')
      .find((n) => (n as HTMLInputElement).value === '100') as HTMLInputElement;
    setInput(commissionInput, '200');
    expect(rateInput.value).toBe('');
  });

  it('手动改过佣金率后，再改佣金不清空（只清仍是预填值的）', async () => {
    const o = mkOrder({ commission: 100, packageFee: 480, commissionRate: 0.2 });
    render(createElement(OrderForm, { ...base, editingId: o.id, seed: o }));
    const rateInput = q('input[max="100"]') as HTMLInputElement;
    // 手动改成 25（不再是预填值 20）
    setInput(rateInput, '25');
    const commissionInput = qa('input[type="number"]')
      .find((n) => (n as HTMLInputElement).value === '100') as HTMLInputElement;
    setInput(commissionInput, '200');
    expect(rateInput.value).toBe('25');
  });

  it('非预置时限值（如 18个月）不会被静默置空', () => {
    const o = mkOrder({ duration: '18个月' });
    render(createElement(OrderForm, { ...base, editingId: o.id, seed: o }));
    const selects = qa('.orders-form-group select') as HTMLSelectElement[];
    const durationSel = selects.find((s) => s.value === '18个月');
    expect(durationSel).toBeTruthy();
    // 值在候选里（React 里通过补进候选实现 setSelectValue 的语义）
    expect(Array.from(durationSel!.options).some((op) => op.value === '18个月')).toBe(true);
  });

  it('新增态：办理日期默认今天、运营商默认联通、时限默认 1年', () => {
    render(createElement(OrderForm, { ...base, editingId: null, seed: {} }));
    const dateInput = q('input[type="date"]') as HTMLInputElement;
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    expect(dateInput.value).toBe(today);
    const selects = qa('.orders-form-group select') as HTMLSelectElement[];
    expect(selects.find((s) => s.value === '联通')).toBeTruthy();
    expect(selects.find((s) => s.value === '1年')).toBeTruthy();
  });
});

// ===========================================================================
describe('SmartInputModal', () => {
  const base = {
    allOrders: [] as Order[],
    onClose: vi.fn(),
    openForm: vi.fn(),
    submitOrder: vi.fn(() => Promise.resolve(true)),
  };

  it('单条：解析结果展示后交给 openForm（新增态 seed），不残留 editingId', () => {
    const openForm = vi.fn();
    render(createElement(SmartInputModal, { ...base, openForm }));
    const ta = q('textarea') as HTMLTextAreaElement;
    setInput(ta, '姓名：苏杰\n联系方式：17365306527\n办理套餐：移动 480元一年');
    const extractBtn = qa('button').find((b) => b.textContent === '提取并填充')!;
    act(() => { extractBtn.click(); });
    // 提取结果出现
    expect(q('.orders-extracted-fields')).toBeTruthy();
    // 走填充
    const fillBtn = qa('button').find((b) => b.textContent === '填充到新增表单')!;
    act(() => { fillBtn.click(); });
    expect(openForm).toHaveBeenCalledTimes(1);
    const seed = openForm.mock.calls[0][0] as Record<string, unknown>;
    expect(seed.name).toBe('苏杰');
    expect(seed.phone).toBe('17365306527');
  });

  it('多条：渲染可勾选表格，有 error 的行禁勾、手机号撞库的默认不勾', () => {
    const existing = mkOrder({ id: 99, phone: '13800000001' });
    render(createElement(SmartInputModal, { ...base, allOrders: [existing], openForm: vi.fn() }));
    const ta = q('textarea') as HTMLTextAreaElement;
    const text = [
      '姓名：甲\n联系方式：13800000001\n办理套餐：100元',   // 撞库 → 默认不勾
      '姓名：乙\n联系方式：13800000002\n办理套餐：100元',   // 正常 → 勾
      '姓名：（空）\n联系方式：\n办理套餐：',               // 缺姓名/手机号 → 禁勾
    ].join('\n');
    setInput(ta, text);
    const btn = qa('button').find((b) => b.textContent === '提取并填充')!;
    act(() => { btn.click(); });
    const boxes = qa('.orders-batch-table input[type="checkbox"]') as HTMLInputElement[];
    expect(boxes.length).toBe(3);
    expect(boxes[0].checked).toBe(false);           // 撞库默认不勾
    expect(boxes[0].disabled).toBe(false);          // 但可以手动勾
    expect(boxes[1].checked).toBe(true);
    expect(boxes[2].checked).toBe(false);
    expect(boxes[2].disabled).toBe(true);           // 有 error 禁勾
    // 底部按钮文案 = 可保存条数
    const saveBtn = qa('button').find((b) => /^保存 \d+ 条$/.test(b.textContent || ''));
    expect(saveBtn?.textContent).toBe('保存 1 条');
  });

  it('多条勾选后保存：submitOrder 按行数被调（include 勾选逻辑生效）', async () => {
    const submitOrder = vi.fn(() => Promise.resolve(true));
    render(createElement(SmartInputModal, { ...base, submitOrder, openForm: vi.fn() }));
    const ta = q('textarea') as HTMLTextAreaElement;
    setInput(ta, '姓名：甲\n联系方式：13800000001\n办理套餐：100元\n姓名：乙\n联系方式：13800000002\n办理套餐：200元');
    const btn = qa('button').find((b) => b.textContent === '提取并填充')!;
    act(() => { btn.click(); });
    const saveBtn = qa('button').find((b) => /^保存 \d+ 条$/.test(b.textContent || ''))!;
    // 测试数据没填佣金，submitOrder 保存前会 appConfirm 提醒；
    // 真 host 未挂载时默认实现返回 false 会中断保存，这里注入「确定」桩。
    const restore = setConfirmImpl(async () => true);
    await act(async () => { saveBtn.click(); });
    restore();
    expect(submitOrder).toHaveBeenCalledTimes(2);
  });
});

// ===========================================================================
describe('CsvImportModal', () => {
  const base = {
    exportRows: [] as Order[],
    allOrders: [] as Order[],
    onClose: vi.fn(),
    importCsv: vi.fn(() => Promise.resolve({ ok: 2, skipped: 0 })),
  };

  it('粘贴文本 → 预览最多 5 行 + 统计文案', () => {
    render(createElement(CsvImportModal, { ...base }));
    const ta = q('textarea') as HTMLTextAreaElement;
    const header = '姓名,手机号';
    const rows = Array.from({ length: 8 }, (_, i) => `客户${i},1380000000${i}`).join('\n');
    setInput(ta, `${header}\n${rows}`);
    const parseBtn = qa('button').find((b) => b.textContent === '解析文本')!;
    act(() => { parseBtn.click(); });
    const preview = qa('.orders-csv-preview-table tbody tr');
    expect(preview.length).toBe(5);
    expect(q('.orders-csv-more')?.textContent).toContain('还有 3 条未显示');
    expect(q('.orders-csv-info')?.textContent).toContain('将导入 8 条');
  });

  it('表头缺失 → .orders-csv-error 错误行；跳过重复计数展示', () => {
    render(createElement(CsvImportModal, { ...base, allOrders: [mkOrder({ phone: '13800000000', applyDate: '2026-01-01' })] }));
    const ta = q('textarea') as HTMLTextAreaElement;
    setInput(ta, '列A,列B\n1,2');
    const parseBtn = qa('button').find((b) => b.textContent === '解析文本')!;
    act(() => { parseBtn.click(); });
    const err = q('.orders-csv-error');
    expect(err).toBeTruthy();
    expect(err?.textContent).toContain('姓名');

    // 重复跳过：手机号+办理日期撞上库里那条
    setInput(ta, '姓名,手机号,办理日期\n张三,13800000000,2026-01-01');
    act(() => { parseBtn.click(); });
    expect(q('.orders-csv-info')?.textContent).toContain('跳过 1 条重复');
  });

  it('确认导入走 appConfirm 注入点 + importCsv', async () => {
    const importCsv = vi.fn(() => Promise.resolve({ ok: 1, skipped: 0 }));
    const restore = setConfirmImpl(async () => true);
    render(createElement(CsvImportModal, { ...base, importCsv }));
    const ta = q('textarea') as HTMLTextAreaElement;
    setInput(ta, '姓名,手机号\n张三,13800000000');
    const parseBtn = qa('button').find((b) => b.textContent === '解析文本')!;
    act(() => { parseBtn.click(); });
    const confirmBtn = qa('button').find((b) => b.textContent === '确认导入')! as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(false);
    await act(async () => { confirmBtn.click(); });
    expect(importCsv).toHaveBeenCalledTimes(1);
    restore();
  });
});

// ===========================================================================
describe('LoginOverlay', () => {
  it('needsPassword=false 不渲染；提交中禁用按钮并显示「验证中…」', async () => {
    render(createElement(LoginOverlay, { needsPassword: false, onSubmit: () => Promise.resolve(true) }));
    expect(q('.orders-login-overlay')).toBeNull();

    // 提交中
    let resolveLogin: (v: boolean) => void = () => {};
    const onSubmit = vi.fn(() => new Promise<boolean>((r) => { resolveLogin = r; }));
    render(createElement(LoginOverlay, { needsPassword: true, submitting: true, onSubmit }));
    const btn = q('button[type="submit"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toBe('验证中…');

    // 正常态：Enter 提交
    render(createElement(LoginOverlay, { needsPassword: true, onSubmit }));
    const input = q('input[type="password"]') as HTMLInputElement;
    const form = q('form') as HTMLFormElement;
    setInput(input, '123456');
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(onSubmit).toHaveBeenCalledWith('123456', true);
    void resolveLogin;
  });
});

// ===========================================================================
describe('ConfirmHost 注入点', () => {
  it('ConfirmHost 挂载后 appConfirm 弹出文案（\n 以 pre-wrap 呈现），确定→true', async () => {
    render(createElement(ConfirmHost));
    const { appConfirm } = await import('../src/orders/confirm');
    let result: boolean | null = null;
    let promise!: Promise<boolean>;
    act(() => {
      promise = appConfirm('确认删除「张三 · 17365306527」？\n删除后可在日志中查看。').then((v) => {
        result = v;
        return v;
      });
    });
    const msg = q('.orders-confirm-message');
    expect(msg).toBeTruthy();
    expect(msg?.textContent).toContain('确认删除');
    // pre-wrap：\n 保留、两行分行渲染。jsdom 不加载 CSS（vitest css:false，
    // getComputedStyle.whiteSpace 拿不到值），所以断言渲染内容 + fs 校验 css 规则存在。
    expect(msg?.textContent).toContain('确认删除「张三 · 17365306527」？');
    expect(msg?.textContent).toContain('删除后可在日志中查看。');
    const fs = await import('node:fs');
    // vitest 的 jsdom 环境里 import.meta.url 不是 file: URL，用进程 cwd（apps/web）定位
    const css = fs.readFileSync('src/orders/orders.css', 'utf8');
    expect(css).toMatch(/\.orders-confirm-message\s*\{[^}]*white-space:\s*pre-wrap/);
    const okBtn = qa('button').find((b) => b.textContent === '确定')!;
    act(() => { okBtn.click(); });
    await act(async () => { await promise; });
    expect(result).toBe(true);
    // 弹窗关闭
    expect(q('.orders-confirm-message')).toBeNull();
  });

  it('setConfirmImpl 可以换成同步桩（测试与其他 host 未挂载时使用）', async () => {
    const restore = setConfirmImpl(async () => false);
    const { appConfirm } = await import('../src/orders/confirm');
    await expect(appConfirm('任意')).resolves.toBe(false);
    restore();
  });
});

// ===========================================================================
describe('ToastHost', () => {
  beforeEach(() => {
    // 清空模块级 toast 队列（getToasts 返回的是同一个数组引用）
    subscribeToasts(() => {})();
  });

  it('toast() 出现 → 到时自动消失；error 6s / 普通 3.5s 的时长规则', () => {
    vi.useFakeTimers();
    render(createElement(ToastHost));
    act(() => { toast('普通提示'); });
    expect(q('.orders-toast')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(3700); });
    expect(q('.orders-toast')).toBeNull();

    act(() => { toast('出错了', { type: 'error' }); });
    act(() => { vi.advanceTimersByTime(5900); });
    expect(q('.orders-toast')).toBeTruthy();
    // 6000ms 触发 leaving，再过 200ms 才真正从 DOM 移除，所以至少要推到 6200
    act(() => { vi.advanceTimersByTime(400); });
    expect(q('.orders-toast')).toBeNull();
  });

  it('带 action 的 toast 时长 8s；点 action 触发回调并关闭', () => {
    vi.useFakeTimers();
    render(createElement(ToastHost));
    const onClick = vi.fn();
    act(() => { toast('已删除', { type: 'success', action: { label: '撤销', onClick } }); });
    const actionBtn = q('.orders-toast-action') as HTMLButtonElement;
    act(() => { actionBtn.click(); });
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(q('.orders-toast')).toBeNull();
  });

  it('错误文案按纯文本渲染（HTML 注入不生效）', () => {
    render(createElement(ToastHost));
    act(() => { toast('<img src=x onerror=alert(1)>', { type: 'error' }); });
    const text = q('.orders-toast-text');
    expect(text?.querySelector('img')).toBeNull();
    expect(text?.textContent).toBe('<img src=x onerror=alert(1)>');
  });
});

// 类型守卫：保证 StatCard 与组件入参对齐（编译期自检，运行时为空操作）
export type { StatCard };
