import { useEffect, useState } from 'react';
import type { Order, OrderLog } from '../types';
import Modal from '../Modal';
import { fetchLogs } from '../client';
import { formatDateTime } from '../date';

export interface LogViewerModalProps {
  order: Order;
  onClose: () => void;
}

const ACTION_ZH: Record<string, string> = {
  create: '➕ 新增',
  insert: '➕ 新增',
  update: '✏️ 修改',
  delete: '❌ 删除',
  import: '⬆ 导入',
};

const FIELD_ZH: Record<string, string> = {
  apply_date: '办理日期', payback_date: '结佣日期', name: '姓名', phone: '手机号',
  province: '省份', city: '城市', carrier: '运营商', package: '套餐', duration: '时限',
  install_fee: '安装费', package_fee: '套餐费', commission: '佣金',
  commission_rate: '佣金率', id_card: '身份证号', address: '地址', sales_person: '销售员',
};

/**
 * 操作日志弹窗：拉 fetchLogs(order.id) 显示该订单的操作日志。
 * 请求失败显示 .orders-log-error 而不是整页崩 —— 日志表可能还没建。
 */
export default function LogViewerModal({ order, onClose }: LogViewerModalProps) {
  const [logs, setLogs] = useState<OrderLog[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    fetchLogs(order.id)
      .then((rows) => {
        if (alive) setLogs(rows);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [order.id]);

  return (
    <Modal title={`📋 操作日志 — ${order.name || ''} ${order.phone || ''}`} onClose={onClose}>
      {error && <div className="orders-log-error" role="alert">加载失败：{error}</div>}
      {!error && logs === null && <div className="orders-log-empty">加载中…</div>}
      {!error && logs !== null && logs.length === 0 && (
        <div className="orders-log-empty">暂无操作日志</div>
      )}
      {!error && logs && logs.length > 0 && (
        <div className="orders-log-list">
          {logs.map((log) => (
            <div key={log.id} className="orders-log-item">
              <div className="orders-log-header">
                <span>
                  <span className={`orders-log-action orders-log-action-${log.action}`}>
                    {ACTION_ZH[log.action] || log.action}
                  </span>
                  {' · '}
                  {log.operator || '未知'}
                </span>
                <span className="orders-log-time">{formatDateTime(log.createdAt)}</span>
              </div>
              {(log.field || log.newValue || log.oldValue) && (
                <div className="orders-log-diff">
                  <div className="log-diff-row">
                    <span className="log-diff-field">{FIELD_ZH[log.field] || log.field || '—'}</span>
                    <span className="log-diff-old">{log.oldValue || '（空）'}</span>
                    <span className="log-diff-arrow">→</span>
                    <span className="log-diff-new">{log.newValue || '（空）'}</span>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
