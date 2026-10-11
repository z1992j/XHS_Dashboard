import { useState } from 'react';
import type { Order } from '../types';
import { RENEW_PREVIEW } from '../config';
import { carrierBadge } from '../format';

/**
 * renewalCandidates() 的返回行。expiry 已是 YYYY-MM-DD 字符串（stats 层用
 * ymdOf 夹紧日期后格式化），这里直接展示，不再二次转 Date。
 */
export type RenewalCandidate = { order: Order; expiry: string; daysLeft: number };

export interface RenewalCardProps {
  items: RenewalCandidate[];
  /** 到期候选是按「手机号最近一次办理」去重后的结果，行点击开详情 */
  onOpenDetail: (o: Order) => void;
}

/**
 * 续约提醒：有到期客户时才出现；是要去打电话的行动清单，所以放在趋势图上面。
 * 列表数据由调用方用 renewalCandidates(selectOrders(...,'month')) 算好传入
 * —— 到期的单都是一两年前办的，吃了月份筛选就永远是空的。
 */
export default function RenewalCard({ items, onOpenDetail }: RenewalCardProps) {
  const [expanded, setExpanded] = useState(false);
  if (!items.length) return null;

  const expired = items.filter((r) => r.daysLeft < 0).length;
  const upcoming = items.length - expired;
  const shown = expanded ? items : items.slice(0, RENEW_PREVIEW);

  return (
    <div className="orders-renew-wrap">
      <div className="orders-renew-card">
        <h3>
          续约提醒
          <span className="hint">
            {upcoming > 0 && <>30 天内到期 <b>{upcoming}</b> 位</>}
            {upcoming > 0 && expired > 0 && ' · '}
            {expired > 0 && <>已到期 <b>{expired}</b> 位</>}
            {/* 没有单独记录装机日，办理日期是能拿到的最近似值 —— 写清楚推算口径 */}
            {' · 到期日按办理日期 + 时限推算'}
          </span>
          {items.length > RENEW_PREVIEW && (
            <button type="button" className="orders-btn-link" onClick={() => setExpanded(!expanded)}>
              {expanded ? '收起' : `展开全部 ${items.length} 位`}
            </button>
          )}
        </h3>
        <table className="orders-renew-table">
          <thead>
            <tr>
              <th>客户</th><th>手机号</th><th className="orders-renew-city">城市</th><th>原套餐</th>
              <th className="orders-renew-apply">办理日期</th><th>到期日</th><th className="text-right">状态</th>
            </tr>
          </thead>
          <tbody>
            {shown.map(({ order: o, expiry, daysLeft }) => (
              <tr
                key={o.id}
                className="clickable"
                onClick={() => onOpenDetail(o)}
                title="点击查看订单详情"
              >
                <td className="col-name">{o.name}</td>
                {/* tel: 链接在手机上点一下就能拨号；阻止冒泡，免得同时弹出详情 */}
                <td>
                  <a
                    className="orders-renew-tel"
                    href={`tel:${o.phone}`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {o.phone}
                  </a>
                </td>
                <td className="orders-renew-city">{o.city}</td>
                <td>
                  <span className={`orders-badge ${carrierBadge(o.carrier)}`}>{o.carrier}</span>{' '}
                  <span className="col-package">{o.package}</span>{' '}
                  <span className="orders-an-muted">{o.duration}</span>
                </td>
                <td className="orders-renew-apply">{o.applyDate}</td>
                <td>{expiry}</td>
                <td className="text-right">{renderStatus(daysLeft)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** 行内状态：已到期 N 天 / 今天到期 / 剩 N 天，配色走 agingLevel 的三档 */
function renderStatus(daysLeft: number) {
  if (daysLeft < 0) return <span className="age-bad">已到期 {-daysLeft} 天</span>;
  if (daysLeft === 0) return <span className="age-bad">今天到期</span>;
  return <span className={daysLeft <= 7 ? 'age-warn' : 'age-ok'}>剩 {daysLeft} 天</span>;
}
