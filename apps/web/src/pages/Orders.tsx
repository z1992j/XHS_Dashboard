/**
 * 「销售订单登记」页面主体（原 Sales-order 的 index.html + app.css + app.js
 * 的界面层 React 重写）。
 *
 * 业务数据由 src/orders/store.ts 提供：本组件只消费 useOrders() 快照 + action，
 * 不直接碰 Supabase。旧版平移过来的关键坑（筛选联动顺序、月份筛选的例外
 * 规则、截断横幅等）都注释在对应组件里。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useOrders } from '../orders/store';
import { getFilteredOrders, selectOrders, scopeText } from '../orders/filter';
import { statCards, totals, comboGroups, cityGroups, groupBy, renewalCandidates } from '../orders/stats';
import type { Order, PaybackFilter } from '../orders/types';
import { formatDateTime } from '../orders/date';
import { toast } from '../orders/toast';
import { appConfirm } from '../orders/confirm';
import ToastHost from '../orders/ToastHost';
import ConfirmHost from '../orders/ConfirmHost';
import LoginOverlay from '../orders/LoginOverlay';
import Toolbar from '../orders/ui/Toolbar';
import StatCards from '../orders/ui/StatCards';
import TrendChart from '../orders/ui/TrendChart';
import RenewalCard from '../orders/ui/RenewalCard';
import AnalysisCards from '../orders/ui/AnalysisCards';
import OrderTable from '../orders/ui/OrderTable';
import OrderForm from '../orders/ui/OrderForm';
import OrderDetail from '../orders/ui/OrderDetail';
import SmartInputModal from '../orders/ui/SmartInputModal';
import CsvImportModal from '../orders/ui/CsvImportModal';
import LogViewerModal from '../orders/ui/LogViewerModal';

export default function Orders() {
  const s = useOrders();

  // 启动：恢复会话并拉数据。StrictMode 下 effect 会跑两次，
  // 用 ref 保证只有第一次挂载真正调 bootstrap（第二次直接跳过）。
  const bootstrapped = useRef(false);
  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    s.bootstrap().catch(() => toast('初始化失败，请刷新重试', { type: 'error' }));
    // eslint 不在依赖里报警：bootstrap 是稳定的 store action
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 网络恢复后自动重新拉取（只在离线缓存状态下才有意义）
  const usingCache = s.usingCache;
  const bootstrap = s.bootstrap;
  useEffect(() => {
    const onOnline = () => {
      if (usingCache) bootstrap();
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [usingCache, bootstrap]);

  // 「最后更新」时间戳：旧版在每次 loadData 完成后写 now()，这里等价地
  // 盯 loading 从 true 变 false 的那一刻（缓存态显示缓存时间，不更新）
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const prevLoading = useRef<boolean | null>(null);
  useEffect(() => {
    if (prevLoading.current === true && !s.loading && s.ready && !s.usingCache) {
      setLastUpdate(Date.now());
    }
    prevLoading.current = s.loading;
  }, [s.loading, s.ready, s.usingCache]);

  // 当前口径：卡片、图表、表格用的是同一份筛选结果（旧版 renderAll 的约定）
  const view = useMemo(() => getFilteredOrders(s.orders, s.filters), [s.orders, s.filters]);
  // 月份口径：本月/上月订单、趋势图、续约都按自然月取，不受月份筛选影响，
  // 否则筛到 8 月时「本月订单」会变成 0、到期的单永远不出现，读起来是错的。
  const monthScope = useMemo(() => selectOrders(s.orders, s.filters, 'month'), [s.orders, s.filters]);

  const cards = useMemo(() => statCards(view, s.allOrders), [view, s.allOrders]);
  const sums = useMemo(() => totals(view), [view]);
  const renewals = useMemo(() => renewalCandidates(monthScope, s.allOrders), [monthScope, s.allOrders]);
  const combos = useMemo(() => comboGroups(selectOrders(s.orders, s.filters)), [s.orders, s.filters]);
  const cities = useMemo(() => cityGroups(selectOrders(s.orders, s.filters, 'region')), [s.orders, s.filters]);
  const carriers = useMemo(
    () => groupBy(selectOrders(s.orders, s.filters, 'carrier'), (o) => o.carrier),
    [s.orders, s.filters],
  );

  // —— 各处点击行为（对应旧版 setMonthFilter / applyPaybackFilter）——
  const onStatCardClick = (c: ReturnType<typeof statCards>[number]) => {
    if (!c.click) return;
    if (c.click.kind === 'month') s.patchFilters({ month: c.click.value });
    else if (c.click.kind === 'payback') s.applyPayback(c.click.value as PaybackFilter);
    else s.patchFilters({ month: '' });
  };

  // 一次落三个筛选条件。城市下拉的选项跟着省份走，所以要先把省份设好
  // 再设城市，否则城市不在当前选项里会被静默置空。套餐没有独立控件，
  // 借搜索框（搜索本就覆盖套餐字段，大小写不敏感匹配）。再点同一行则整组取消。
  // 注意「已选中」判定里套餐要比大写：comboGroups 把 pkg 统一转成了大写。
  const setComboFilter = (province: string, city: string, carrier: string, pkg: string) => {
    const already =
      s.filters.city === city &&
      s.filters.carrier === carrier &&
      s.filters.q.trim().toUpperCase() === pkg;
    if (already) {
      s.clearFilters();
      return;
    }
    // 顺序敏感：先省份再城市（城市选项跟省份走），最后运营商与套餐
    if (province) s.patchFilters({ province });
    s.patchFilters(city ? { city } : { city: '' });
    s.patchFilters({ carrier: carrier || '' });
    s.setSearch(pkg || '');
  };

  // 设城市前先设省份：城市下拉的选项跟着省份走，顺序反了会被静默置空
  const setCityFilter = (province: string, city: string) => {
    if (s.filters.city === city) {
      s.patchFilters({ province: '', city: '' });
      return;
    }
    if (province) s.patchFilters({ province });
    s.patchFilters({ city });
  };

  // 从分析卡点选运营商：再点一次同一个取消，和胶囊的手感一致
  const setCarrierFilter = (name: string) => {
    s.patchFilters({ carrier: s.filters.carrier === name ? '' : name });
  };

  // 「最后更新」状态行：照抄 statusLine 的语义，写清当前口径与数据新鲜度
  const statusSuffix = s.usingCache
    ? `离线数据，缓存于 ${formatDateTime(s.cachedAt)}`
    : lastUpdate
      ? `最后更新：${formatDateTime(lastUpdate)}`
      : '数据加载中…';
  const statusLine =
    s.filters.view === 'all'
      ? `⚠️ 正在查看非本人名下的 ${s.orders.length} 条记录（你自己的 ${s.hiddenCount} 条已暂时隐藏）· ${statusSuffix}`
      : `共 ${s.orders.length} 条记录` +
        (s.hiddenCount ? `（另有 ${s.hiddenCount} 条非本人名下，未显示）` : '') +
        ` · ${statusSuffix}`;

  const handleDelete = async (o: Order) => {
    const label = `${o.name || '该订单'} · ${o.phone || ''}`;
    const ok = await appConfirm(`确认删除「${label}」？\n删除后可到该订单的操作日志中查看记录。`);
    if (!ok) return;
    const done = await s.removeOrder(o.id);
    if (done) toast(`已删除「${label}」`, { type: 'success' });
    else toast('删除失败', { type: 'error' });
  };

  const handleLogout = async () => {
    const ok = await appConfirm('确认退出登录？');
    if (ok) s.logout();
  };

  if (s.needsPassword) {
    // 无会话时不渲染主体，避免无谓的请求与闪现
    return (
      <div className="orders-page">
        <LoginOverlay
          needsPassword
          error={s.error}
          submitting={s.saving}
          onSubmit={(pwd, remember) => s.login(pwd, remember)}
        />
        <ToastHost />
        <ConfirmHost />
      </div>
    );
  }

  const modal = s.modal;
  const hasAnyData = s.orders.length > 0;

  return (
    <div className="orders-page">
      <div className="orders-page-head">
        <h1 className="orders-title">销售订单登记</h1>
        <button type="button" className="orders-btn-logout" onClick={handleLogout}>
          退出
        </button>
        <span className="orders-status-line">{statusLine}</span>
      </div>

      {s.filters.view === 'all' && (
        <div className="orders-other-banner">
          你正在查看<b>非本人名下</b>的历史记录。这里的编辑、删除、改归属都会直接写入数据库；
          新增订单仍会记在自己名下。清理完点页头的「返回我的订单」。
        </div>
      )}
      {s.usingCache && (
        <div className="orders-offline-banner">
          📴 <b>离线模式</b> —— 显示的是 {formatDateTime(s.cachedAt)} 缓存的数据，可能已不是最新。
          此状态下新增、修改、删除都会失败。
        </div>
      )}

      {/* 写清楚当前这批数字是什么口径的，不然筛完不知道看的是哪一撮 */}
      <div className="orders-scope-line">{scopeText(s.filters, view.length)}</div>

      <StatCards cards={cards} onCardClick={onStatCardClick} />
      <TrendChart
        orders={monthScope}
        metric={s.trendMetric}
        month={s.filters.month}
        onSetMonth={(m) => s.patchFilters({ month: m })}
        onSetMetric={s.setTrendMetric}
      />
      <RenewalCard items={renewals} onOpenDetail={s.openDetail} />
      <AnalysisCards
        combos={combos}
        cities={cities}
        carriers={carriers}
        activeProvince={s.filters.province}
        activeCity={s.filters.city}
        activeCarrier={s.filters.carrier}
        activePkg={s.filters.q}
        onComboClick={(g) => setComboFilter(g.province, g.city, g.carrier, g.pkg)}
        onCityClick={(g) => setCityFilter(g.province, g.city)}
        onCarrierClick={setCarrierFilter}
      />

      <Toolbar
        filters={s.filters}
        view={s.filters.view}
        hiddenCount={s.hiddenCount}
        orders={s.orders}
        onOpenModal={s.openCsv}
        toggleView={s.toggleView}
        applyPayback={s.applyPayback}
        clearFilters={s.clearFilters}
        setSort={s.setSort}
        setSearch={s.setSearch}
        patchFilters={s.patchFilters}
        openForm={s.openForm}
        openSmart={s.openSmart}
      />

      <OrderTable
        rows={view}
        totals={sums}
        sort={s.filters.sort}
        desc={s.filters.desc}
        onSetSort={s.setSort}
        onOpenDetail={s.openDetail}
        onEdit={s.openForm}
        onDelete={handleDelete}
        onOpenLogs={s.openLogs}
        truncatedTotal={s.truncatedTotal}
        countUnverified={s.countUnverified}
        hasAnyData={hasAnyData}
      />

      {modal?.kind === 'form' && (
        <OrderForm
          editingId={modal.editingId}
          seed={modal.seed}
          allOrders={s.allOrders}
          onClose={s.closeModal}
          submitOrder={s.submitOrder}
        />
      )}
      {modal?.kind === 'detail' && (
        <OrderDetail
          order={modal.order}
          onClose={s.closeModal}
          onEdit={s.openForm}
          onDelete={handleDelete}
          claimOrder={s.claimOrder}
        />
      )}
      {modal?.kind === 'csv' && (
        <CsvImportModal
          exportRows={view}
          allOrders={s.allOrders}
          onClose={s.closeModal}
          importCsv={s.importCsv}
        />
      )}
      {modal?.kind === 'logs' && <LogViewerModal order={modal.order} onClose={s.closeModal} />}
      {modal?.kind === 'smart' && (
        <SmartInputModal
          allOrders={s.allOrders}
          onClose={s.closeModal}
          // 单条解析结果回填：必须开成新增态。store.openForm 只收完整 Order，
          // 直接传会被当成编辑（editingId = o.id），这里把 id 抹成 undefined，
          // 宽松比较下等价于「无编辑目标」→ 新增态。
          openForm={(seed) => s.openForm({ ...seed, id: undefined } as unknown as Order)}
          submitOrder={s.submitOrder}
        />
      )}

      <ToastHost />
      <ConfirmHost />
    </div>
  );
}
