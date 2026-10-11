import { Download, Search, Upload, Zap } from 'lucide-react';
import type { Filters, Order, PaybackFilter, SortKey, ViewScope } from '../types';
import { activeFilterCount } from '../filter';

export interface ToolbarProps {
  filters: Filters;
  view: ViewScope;
  /** 有非本人归属记录才露出视图切换（照抄 refreshViewToggle 的条件） */
  hiddenCount: number;
  orders: Order[];
  onOpenModal: (kind: 'csv') => void;
  toggleView: () => void;
  applyPayback: (v: PaybackFilter) => void;
  clearFilters: () => void;
  setSort: (k: SortKey) => void;
  setSearch: (q: string) => void;
  patchFilters: (p: Partial<Filters>) => void;
  openForm: (o?: Order) => void;
  openSmart: () => void;
}

const CARRIERS = ['联通', '移动', '电信'];
const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'applyDate', label: '办理日期' },
  { key: 'payback', label: '结佣日期' },
  { key: 'commission', label: '佣金' },
  { key: 'packageFee', label: '套餐费' },
  { key: 'commissionRate', label: '佣金率' },
  { key: 'name', label: '姓名' },
  { key: 'city', label: '城市' },
];

const PAYBACK_CHIPS: { value: PaybackFilter; label: string; cls: string; sub?: boolean }[] = [
  { value: 'unpaid', label: '未结佣', cls: 'orders-chip-unpaid' },
  { value: 'over30', label: '逾 30 天', cls: 'orders-chip-sm', sub: true },
  { value: 'over60', label: '逾 60 天', cls: 'orders-chip-sm', sub: true },
  { value: 'paid', label: '已结佣', cls: '' },
];

export default function Toolbar(props: ToolbarProps) {
  const {
    filters, orders, hiddenCount, view,
    onOpenModal, toggleView, applyPayback, clearFilters, setSort, setSearch, patchFilters,
    openForm, openSmart,
  } = props;

  // 省份选项来自当前视图；城市跟省份走，避免一长串跨省城市
  const provinces = Array.from(new Set(orders.map((o) => o.province).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const cities = Array.from(
    new Set(orders.filter((o) => !filters.province || o.province === filters.province).map((o) => o.city).filter(Boolean)),
  ).sort((a, b) => a.localeCompare(b, 'zh-CN'));

  // 月份按年分组：值就是日期前缀（'' 全部、'2026' 整年、'2026-09' 单月），
  // 所以匹配逻辑一句 startsWith 就够；本月没单也要能选，看板「本月订单」要跳得过来
  const months = new Set(orders.map((o) => (o.applyDate || '').slice(0, 7)).filter((m) => m.length === 7));
  const now = new Date();
  months.add(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`);
  const byYear = new Map<string, string[]>();
  Array.from(months).sort().reverse().forEach((m) => {
    const y = m.slice(0, 4);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y)!.push(m);
  });

  const isUnpaid = filters.payback === 'unpaid' || filters.payback === 'over30' || filters.payback === 'over60';
  const filterCount = activeFilterCount(filters);

  return (
    <div className="orders-toolbar">
      <div className="orders-tb-row orders-tb-row-main">
        <div className="orders-search-box">
          <Search size={15} />
          <input
            type="text"
            value={filters.q}
            placeholder="搜索姓名、手机、城市、套餐…"
            onChange={(e) => setSearch(e.target.value)}
            aria-label="搜索订单"
          />
        </div>
        <div className="orders-tb-actions">
          {/* 数据库里可能还留着他人（或早期导入归属为空）的历史记录，
              只在存在这种记录（或已在 others 视图）时露出这个入口，
              避免日常使用被一个永远用不上的按钮干扰 */}
          {hiddenCount > 0 && (
            <button
              type="button"
              className={`orders-btn-view${view === 'all' ? ' active' : ''}`}
              onClick={toggleView}
            >
              {view === 'all' ? '← 返回我的订单' : `查看其他归属 (${hiddenCount})`}
            </button>
          )}
          <button type="button" className="orders-btn orders-btn-smart" onClick={openSmart}>
            <Zap size={13} /> 智能录入
          </button>
          <button type="button" className="orders-btn orders-btn-primary" onClick={() => openForm()}>
            + 新增订单
          </button>
        </div>
      </div>

      <div className="orders-tb-row orders-tb-row-filters">
        <select
          className="orders-ctrl"
          value={filters.month}
          onChange={(e) => patchFilters({ month: e.target.value })}
          aria-label="按月份筛选"
        >
          <option value="">全部时间</option>
          {Array.from(byYear).map(([year, list]) => (
            <optgroup key={year} label={year}>
              <option value={year}>{year} 全年</option>
              {list.map((m) => (
                <option key={m} value={m}>{m.replace('-', ' 年 ')} 月</option>
              ))}
            </optgroup>
          ))}
        </select>

        <select
          className="orders-ctrl"
          value={filters.province}
          onChange={(e) => patchFilters({ province: e.target.value, city: '' })}
          aria-label="按省份筛选"
        >
          <option value="">全部省份</option>
          {provinces.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>

        <select
          className="orders-ctrl"
          value={filters.city}
          onChange={(e) => patchFilters({ city: e.target.value })}
          aria-label="按城市筛选"
        >
          <option value="">全部城市</option>
          {cities.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>

        <select
          className="orders-ctrl"
          value={filters.carrier}
          onChange={(e) => patchFilters({ carrier: e.target.value })}
          aria-label="按运营商筛选"
        >
          <option value="">全部运营商</option>
          {CARRIERS.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>

        <span className="orders-sep" aria-hidden="true" />

        {PAYBACK_CHIPS.map(({ value, label, cls, sub }) => {
          // 逾期两档是「未结佣」的下一级，选中未结佣后才出现，平时不占地方
          if (sub && !isUnpaid) return null;
          const active = filters.payback === value;
          return (
            <button
              key={value}
              type="button"
              className={`orders-chip ${cls}${active ? ' active' : ''}`}
              onClick={() => {
                // 胶囊点自己 = 取消；点逾期档再点一次退回「未结佣」，不会整个清空
                applyPayback(value === filters.payback ? (sub ? 'unpaid' : '') : value);
              }}
            >
              {label}
            </button>
          );
        })}

        {/* 搜索框也算一个条件：点「热销组合」会把套餐写进搜索框，
            不计入的话只剩它生效时「清除筛选」按钮会消失，表格却仍是筛过的 */}
        <button
          type="button"
          className={`orders-btn-clear-filters${filterCount > 0 ? ' visible' : ''}`}
          onClick={clearFilters}
        >
          ✕ 清除筛选
          {filterCount > 0 && <span className="orders-filter-count">{filterCount}</span>}
        </button>
      </div>

      <div className="orders-tb-row orders-tb-row-time">
        <select
          className="orders-ctrl"
          value={`${filters.sort}_${filters.desc ? 'desc' : 'asc'}`}
          onChange={(e) => {
            const [key, dir] = e.target.value.split('_');
            setSort(key as SortKey);
            patchFilters({ desc: dir !== 'asc' });
          }}
          aria-label="排序方式"
        >
          {SORT_OPTIONS.flatMap(({ key, label }) => [
            <option key={`${key}_desc`} value={`${key}_desc`}>{label} ↓</option>,
            <option key={`${key}_asc`} value={`${key}_asc`}>{label} ↑</option>,
          ])}
        </select>
        <div className="orders-tb-actions orders-tb-actions-secondary">
          <button type="button" className="orders-btn orders-btn-ghost" onClick={() => onOpenModal('csv')}>
            <Download size={13} /> 导出 CSV
          </button>
          <button type="button" className="orders-btn orders-btn-ghost" onClick={() => onOpenModal('csv')}>
            <Upload size={13} /> 导入 CSV
          </button>
        </div>
      </div>
    </div>
  );
}
