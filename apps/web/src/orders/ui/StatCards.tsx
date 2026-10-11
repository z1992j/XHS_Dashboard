import type { StatCard } from '../stats';

/**
 * 四张看板卡。点击行为由 stats.statCards 给出（click.kind）：
 * 本月订单→跳该月筛选、佣金合计→清月份、未结佣→筛未结佣、结佣周期→筛已结佣。
 * 上月为 0 时 stats 层已把 deltaPct 置 null 并给了「上月无订单」文案。
 */
export default function StatCards({
  cards,
  onCardClick,
}: {
  cards: StatCard[];
  onCardClick?: (c: StatCard) => void;
}) {
  return (
    <div className="orders-stats">
      {cards.map((c) => {
        const clickable = Boolean(c.click && onCardClick);
        return (
          <div
            key={c.label}
            className={`orders-stat-card${c.warn ? ' warn' : ''}${clickable ? ' clickable' : ''}`}
            onClick={clickable ? () => onCardClick!(c) : undefined}
            title={clickable ? '点击查看对应记录' : undefined}
            role={clickable ? 'button' : undefined}
            tabIndex={clickable ? 0 : undefined}
            onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') onCardClick!(c); } : undefined}
          >
            <div className="label">{c.label}</div>
            <div className="value">{c.value}</div>
            {c.deltaPct != null ? (
              // 环比：按订单数比，上月为 0 时百分比没有意义，只说明是新增
              <span className={`delta ${c.deltaPct > 0 ? 'delta-up' : c.deltaPct < 0 ? 'delta-down' : 'delta-flat'}`}>
                {c.deltaPct > 0 ? '↑' : c.deltaPct < 0 ? '↓' : '–'} {Math.abs(c.deltaPct)}% 环比上月
              </span>
            ) : (
              c.sub && <div className="sub">{c.sub}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}
