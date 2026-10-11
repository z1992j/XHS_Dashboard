import type { Order } from '../types';
import Modal from '../Modal';
import { SALES_PERSON } from '../config';
import { agingDays } from '../stats';
import { money } from '../format';

export interface OrderDetailProps {
  order: Order;
  onClose: () => void;
  onEdit: (o: Order) => void;
  onDelete: (o: Order) => void;
  claimOrder: (o: Order) => Promise<boolean>;
}

/** 字段顺序照抄旧版 showRowDetail；未结佣时结佣日期行写账龄。 */
export default function OrderDetail({ order: o, onClose, onEdit, onDelete, claimOrder }: OrderDetailProps) {
  const aging = agingDays(o);
  const isMine = o.salesPerson === SALES_PERSON;

  const fields: [string, string][] = [
    ['办理日期', o.applyDate || '-'],
    [
      '结佣日期',
      o.paybackDate || (aging !== null ? `未结佣（已 ${aging} 天）` : '未结佣'),
    ],
    ['姓名', o.name],
    ['手机号', o.phone],
    ['省份', o.province],
    ['城市', o.city],
    ['运营商', o.carrier],
    ['套餐', o.package],
    ['时限', o.duration],
    ['安装费', money(o.installFee)],
    ['套餐费', money(o.packageFee)],
    ['佣金', money(o.commission)],
    ['佣金率', `${Math.round(o.commissionRate * 100)}%`],
    ['身份证号', o.idCard || '-'],
    ['地址', o.address || '-'],
  ];
  // 只有非本人订单才显示归属，本人视图下这一行是废话
  if (!isMine) fields.push(['当前归属', o.salesPerson || '(空)']);

  const handleClaim = async () => {
    const ok = await claimOrder(o);
    if (ok) onClose();
  };

  return (
    <Modal title="订单详情" onClose={onClose} narrow>
      <div className="orders-detail-rows">
        {fields.map(([label, value]) => (
          <div key={label} className="orders-detail-row">
            <span className="dl">{label}</span>
            <span className="dv">{value}</span>
          </div>
        ))}
      </div>
      <div className="orders-modal-actions">
        {/* 只有非本人订单才给「归到我名下」：把历史遗留记录收编进自己的统计 */}
        {!isMine && (
          <button type="button" className="orders-btn orders-btn-sm orders-btn-claim" onClick={handleClaim}>
            归到我名下
          </button>
        )}
        <button type="button" className="orders-btn orders-btn-sm orders-btn-cancel" onClick={() => onEdit(o)}>
          编辑
        </button>
        <button type="button" className="orders-btn orders-btn-sm orders-btn-danger" onClick={() => onDelete(o)}>
          删除
        </button>
      </div>
    </Modal>
  );
}
