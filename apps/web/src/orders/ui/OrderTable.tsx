import type { Order, SortKey } from '../types';
import { carrierBadge } from '../format';
import { agingDays, agingLevel } from '../stats';

export interface OrderTableProps {
  rows: Order[];
  /** 当前口径的合计（totals() 的结果，只含套餐费/佣金），给表尾合计行 */
  totals: { count: number; packageFee: number; commission: number };
  sort: SortKey;
  desc: boolean;
  onSetSort: (k: SortKey) => void;
  onOpenDetail: (o: Order) => void;
  onEdit: (o: Order) => void;
  onDelete: (o: Order) => void;
  onOpenLogs: (o: Order) => void;
  /** 服务端给出的总条数；> rows.length 表示被接口截断 */
  truncatedTotal: number;
  /** 全量条数已达 COUNT_SUSPICIOUS_AT 且读不到服务端总数：无法证明数据取全 */
  countUnverified: boolean;
  /** 当前是不是「筛完没有」（决定空态文案） */
  hasAnyData: boolean;
}

const COLUMNS: { key?: SortKey; label: string; cls?: string }[] = [
  { label: '序号' },
  { key: 'applyDate', label: '办理日期' },
  { key: 'payback', label: '结佣日期' },
  { label: '姓名' },
  { label: '手机号' },
  { label: '省份' },
  { key: 'city', label: '城市' },
  { label: '运营商' },
  { label: '套餐' },
  { label: '时限' },
  { label: '安装费', cls: 'text-right' },
  { key: 'packageFee', label: '套餐费', cls: 'text-right' },
  { key: 'commission', label: '佣金', cls: 'text-right' },
  { key: 'commissionRate', label: '佣金率', cls: 'text-right' },
  { label: '身份证号' },
  { label: '地址' },
  { label: '操作' },
];

/** 已结佣显示日期；未结佣显示已拖欠天数，比一个「-」有用得多 */
function PaybackCell({ o }: { o: Order }) {
  if (o.paybackDate) return <>{o.paybackDate}</>;
  const days = agingDays(o);
  if (days === null) return <span className="age-ok">未结佣</span>;
  return <span className={agingLevel(days)}>未结佣 {days}天</span>;
}

export default function OrderTable(props: OrderTableProps) {
  const {
    rows, totals, sort, desc, onSetSort,
    onOpenDetail, onEdit, onDelete, onOpenLogs,
    truncatedTotal, countUnverified, hasAnyData,
  } = props;

  // totals() 只给套餐费/佣金；安装费合计在组件层现算（旧版表尾同样展示三列金额）
  const sumInstall = rows.reduce((s, o) => s + (Number(o.installFee) || 0), 0);

  return (
    <div className="orders-table-wrap">
      {/* 被截断时所有统计都是不完整的，不说清楚会让人按错的数字做判断 */}
      {truncatedTotal > 0 && (
        <div className="orders-trunc-banner visible" role="alert">
          ⚠️ <b>数据未取全</b>：仅加载了前 {rows.length} 条（共 {truncatedTotal} 条）。
          <b>当前所有统计、图表和合计都是不完整的。</b>
        </div>
      )}
      {truncatedTotal <= 0 && countUnverified && (
        <div className="orders-trunc-banner visible" role="alert">
          ⚠️ <b>无法确认数据是否取全</b>：已取回 {rows.length} 条，但没读到服务端返回的总数，
          无法核验是否取全。
        </div>
      )}

      <table>
        <thead>
          <tr>
            {COLUMNS.map((col) => (
              <th
                key={col.label}
                className={col.cls}
                onClick={col.key && onSetSort ? () => onSetSort(col.key as SortKey) : undefined}
                role={col.key ? 'button' : undefined}
              >
                {col.label}
                {col.key && sort === col.key && (desc ? ' ↓' : ' ↑')}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((o, i) => (
            <tr
              key={o.id}
              className={!o.paybackDate ? 'unpaid-row' : ''}
              onClick={() => onOpenDetail(o)}
            >
              <td className="nowrap">{i + 1}</td>
              <td className="nowrap">{o.applyDate}</td>
              <td className="nowrap"><PaybackCell o={o} /></td>
              <td className="col-name nowrap">{o.name}</td>
              <td className="nowrap">{o.phone}</td>
              <td className="nowrap">{o.province}</td>
              <td className="nowrap">{o.city}</td>
              <td className="nowrap">
                <span className={`orders-badge ${carrierBadge(o.carrier)}`}>{o.carrier}</span>
              </td>
              <td className="nowrap col-package">{o.package}</td>
              <td className="nowrap">{o.duration}</td>
              <td className="text-right nowrap">¥{o.installFee.toLocaleString()}</td>
              <td className="text-right nowrap">¥{o.packageFee.toLocaleString()}</td>
              <td className="text-right col-commission nowrap">¥{o.commission.toLocaleString()}</td>
              <td className="text-right nowrap">{Math.round(o.commissionRate * 100)}%</td>
              <td className="nowrap col-id">{o.idCard}</td>
              <td className="col-address"><span title={o.address}>{o.address}</span></td>
              <td className="nowrap" onClick={(e) => e.stopPropagation()}>
                <button type="button" className="orders-btn orders-btn-sm orders-btn-cancel" onClick={() => onEdit(o)}>编辑</button>
                <button type="button" className="orders-btn orders-btn-sm orders-btn-cancel" onClick={() => onOpenLogs(o)}>日志</button>
                <button type="button" className="orders-btn orders-btn-sm orders-btn-danger" onClick={() => onDelete(o)}>删除</button>
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="total-row">
            {/* 表头前 10 列（序号…时限）固定，其后为 安装费/套餐费/佣金 三列，
                尾部为 佣金率/身份证号/地址/操作。合计行的单元格必须与当前
                可见列一一对应，colspan 写错列宽模型就乱了。 */}
            <td colSpan={10}>合计 ({rows.length}笔)</td>
            <td className="text-right">¥{sumInstall.toLocaleString()}</td>
            <td className="text-right">¥{totals.packageFee.toLocaleString()}</td>
            <td className="text-right col-commission">¥{totals.commission.toLocaleString()}</td>
            <td colSpan={4} />
          </tr>
        </tfoot>
      </table>
      {rows.length === 0 && (
        <div className="orders-empty">
          {/* 空态要区分「没有数据」与「筛完没有」：一个是还没有录过，一个该放宽条件了 */}
          {hasAnyData ? '当前筛选条件下没有订单，试试清除筛选' : '暂无订单数据'}
        </div>
      )}
    </div>
  );
}
