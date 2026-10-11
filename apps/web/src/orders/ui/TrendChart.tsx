import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Order } from '../types';
import { money } from '../format';

export interface TrendChartProps {
  orders: Order[];
  /** 已经排除月份筛选后的列表（selectOrders(...,'month)），由调用方传入 */
  metric: 'commission' | 'count';
  month: string;
  onSetMonth: (m: string) => void;
  onSetMetric: (m: 'commission' | 'count') => void;
}

interface Bucket {
  key: string;
  label: string;
  settled: number;
  unsettled: number;
  count: number;
}

/** 窄屏判断与 CSS 断点保持一致；用 resize 监听而不是只算一次，横竖屏切换要生效。 */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth <= 768);
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth <= 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return narrow;
}

/**
 * 近 12 个月（或选中年份的 12 个月）堆叠柱：未结佣在上、已结佣在下。
 * 按月拆的图不吃月份筛选，否则只剩一根柱子；选中的那个月改为高亮。
 */
export default function TrendChart({ orders, metric, month, onSetMonth, onSetMetric }: TrendChartProps) {
  const narrow = useNarrow();

  const buckets = useMemo<Bucket[]>(() => {
    // 选了某一年就看那一年的 12 个月，否则看最近 12 个自然月
    const now = new Date();
    const pickedYear = /^\d{4}$/.test(month) ? Number(month)
      : /^\d{4}-\d{2}$/.test(month) ? Number(month.slice(0, 4)) : null;
    const list: Bucket[] = [];
    for (let i = 0; i < 12; i++) {
      const d = pickedYear !== null
        ? new Date(pickedYear, i, 1)
        : new Date(now.getFullYear(), now.getMonth() - 11 + i, 1);
      list.push({
        key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
        label: `${d.getMonth() + 1}月`,
        settled: 0,
        unsettled: 0,
        count: 0,
      });
    }
    const index = new Map(list.map((b) => [b.key, b]));
    orders.forEach((o) => {
      if (!o.applyDate) return;
      const b = index.get(o.applyDate.slice(0, 7));
      if (!b) return;
      const v = metric === 'count' ? 1 : Number(o.commission) || 0;
      if (o.paybackDate) b.settled += v;
      else b.unsettled += v;
      b.count++;
    });
    return list;
  }, [orders, metric, month]);

  const isCount = metric === 'count';
  const totalOf = (b: Bucket) => b.settled + b.unsettled;
  const max = Math.max(...buckets.map(totalOf));
  const rangeLabel = /^\d{4}/.test(month) && month.length === 4 ? `${month} 年` : '近 12 个月';
  const title = rangeLabel + (isCount ? '订单量趋势' : '佣金趋势');

  // SVG 按 viewBox 等比缩放：窄屏上像素被压缩，所以字号和留白都用
  // 用户单位放大一档，否则月份标签会糊成一片或与柱子重叠。
  const W = 1000;
  const H = narrow ? 170 : 116;
  const padBottom = narrow ? 46 : 18;
  const padTop = narrow ? 18 : 16;
  const labelSize = narrow ? 26 : 10;
  const slot = W / buckets.length;
  // 柱子封顶，别把格子填满，余下的留白。宽屏 SVG 会被放大约 1.4 倍，
  // 16 用户单位落到屏幕上约 22–25px，正好在「柱宽不超过 24px」这条线附近；
  // 窄屏整体缩小，按槽宽比例走反而更合适。
  const barW = narrow ? slot * 0.56 : Math.min(slot * 0.56, 16);
  const plot = H - padTop - padBottom;
  const GAP = 2; // 堆叠两段之间留表面色间隙，靠留白分隔而不是描边

  const now = new Date();
  const currentYm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const sumSettled = buckets.reduce((s, b) => s + b.settled, 0);
  const sumUnsettled = buckets.reduce((s, b) => s + b.unsettled, 0);
  const fmtVal = (n: number) => (isCount ? `${n} 笔` : money(n));
  const fmt = (v: number) => (isCount ? String(v) : v >= 10000 ? `${(v / 10000).toFixed(1)}万` : String(v));

  return (
    <div className="orders-trend-wrap">
      <div className="orders-trend-card">
        <h3>
          {title}
          <span className="hint">
            合计 {fmtVal(sumSettled + sumUnsettled)} · 其中未结佣 {fmtVal(sumUnsettled)}
          </span>
          <span className="orders-trend-toggle">
            <button
              type="button"
              className={isCount ? '' : 'active'}
              onClick={() => onSetMetric('commission')}
            >
              佣金
            </button>
            <button
              type="button"
              className={isCount ? 'active' : ''}
              onClick={() => onSetMetric('count')}
            >
              订单数
            </button>
          </span>
        </h3>
        {/* 两个系列必须有图例，识别不能只靠颜色 */}
        <div className="orders-an-legend" style={{ margin: '2px 0 8px' }}>
          <span><i style={{ background: 'var(--c-settled)' }} />已结佣</span>
          <span><i style={{ background: 'var(--c-unsettled)' }} />未结佣</span>
          <span className="orders-an-muted">堆叠高度为当月合计</span>
        </div>
        {max <= 0 ? (
          <div className="orders-trend-empty">{rangeLabel}暂无订单数据</div>
        ) : (
          <svg className="orders-trend-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title}>
            <line x1={0} y1={H - padBottom} x2={W} y2={H - padBottom} stroke="var(--grid-line)" strokeWidth={1} />
            {buckets.map((b, i) => {
              const total = totalOf(b);
              const x = i * slot + (slot - barW) / 2;
              const isPicked = b.key === month;
              const isCurrent = !month && b.key === currentYm;
              const hTotal = total > 0 ? Math.max(2, (total / max) * plot) : 0;
              const hUnsettled = total > 0 ? (b.unsettled / total) * hTotal : 0;
              const hSettled = hTotal - hUnsettled;
              const yTop = H - padBottom - hTotal;

              // 未结佣在上、已结佣在下：下段贴基线，圆角只给整根柱子的顶端
              const seg: ReactNode[] = [];
              if (hSettled > 0) {
                seg.push(
                  <rect
                    key="s"
                    x={x.toFixed(1)}
                    y={(H - padBottom - hSettled).toFixed(1)}
                    width={barW.toFixed(1)}
                    height={hSettled.toFixed(1)}
                    fill="var(--c-settled)"
                    rx={hUnsettled > 0 ? undefined : 4}
                  />,
                );
              }
              if (hUnsettled > 0) {
                const h = Math.max(1, hUnsettled - (hSettled > 0 ? GAP : 0));
                seg.push(
                  <rect
                    key="u"
                    x={x.toFixed(1)}
                    y={yTop.toFixed(1)}
                    width={barW.toFixed(1)}
                    height={h.toFixed(1)}
                    fill="var(--c-unsettled)"
                    rx={4}
                  />,
                );
              }

              // 只给选中月/当月标数值，不是每根都标——标满了没人看
              const showValue = total > 0 && !narrow && (isPicked || isCurrent);
              // 有单的月份才能点：空月份不在月份下拉里，点了也筛不出东西
              const clickable = b.count > 0;
              const tip = `${b.key}：${b.count} 笔\n已结佣 ${isCount ? `${b.settled} 笔` : money(b.settled)} · 未结佣 ${isCount ? `${b.unsettled} 笔` : money(b.unsettled)}${clickable ? `\n${isPicked ? '点击取消月份筛选' : '点击只看这个月'}` : ''}`;
              return (
                <g
                  key={b.key}
                  className={`orders-trend-bar-g${isPicked || isCurrent ? ' current' : ''}${clickable ? ' clickable' : ''}`}
                  onClick={clickable ? () => onSetMonth(isPicked ? '' : b.key) : undefined}
                >
                  <title>{tip}</title>
                  {/* 透明热区：命中面积比柱子宽，窄柱子也好点。
                      点击和提示挂在整组上：柱子画在热区上面，挂在热区上的话点柱子本身反而没反应 */}
                  <rect
                    x={(i * slot).toFixed(1)}
                    y={padTop}
                    width={slot.toFixed(1)}
                    height={(plot + padBottom).toFixed(1)}
                    fill="transparent"
                  />
                  {seg}
                  {showValue && (
                    <text className="orders-trend-value" x={(x + barW / 2).toFixed(1)} y={yTop - 5} textAnchor="middle">
                      {fmt(total)}
                    </text>
                  )}
                  <text
                    className="orders-trend-label"
                    x={(x + barW / 2).toFixed(1)}
                    y={H - padBottom + labelSize + 4}
                    style={{ fontSize: labelSize }}
                    textAnchor="middle"
                  >
                    {b.label}
                  </text>
                </g>
              );
            })}
          </svg>
        )}
      </div>
    </div>
  );
}
