import { useMemo, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import type { Order } from '../types';
import Modal from '../Modal';
import { SALES_PERSON } from '../config';
import { todayStr } from '../date';
import { extractCityFromAddress } from '../smartInput';
import { toast } from '../toast';

export interface OrderFormProps {
  editingId: number | null;
  /** 新增时的初始值（seed 可能来自智能录入单条解析），编辑时是完整订单 */
  seed: Partial<Order>;
  /** 全库订单：判重要查全库（含隐藏的非本人归属记录），不只查当前视图 */
  allOrders: Order[];
  onClose: () => void;
  submitOrder: (draft: Partial<Order>) => Promise<boolean>;
}

const CARRIERS = ['联通', '移动', '电信'];
const PACKAGES = ['100m', '200m', '300m', '500m', '1000m'];
const DURATIONS = ['6个月', '1年', '2年', '3年'];

interface FormState {
  applyDate: string;
  paybackDate: string;
  name: string;
  phone: string;
  province: string;
  city: string;
  carrier: string;
  pkg: string;
  duration: string;
  installFee: string;
  packageFee: string;
  commission: string;
  commissionRate: string;
  idCard: string;
  address: string;
}

function initialState(editingId: number | null, seed: Partial<Order>): FormState {
  if (editingId != null) {
    const o = seed;
    return {
      applyDate: o.applyDate || '',
      paybackDate: o.paybackDate || '',
      name: o.name || '',
      phone: o.phone || '',
      province: o.province || '',
      city: o.city || '',
      carrier: o.carrier || '联通',
      pkg: o.package || '300m',
      duration: o.duration || '1年',
      installFee: o.installFee ? String(o.installFee) : '',
      packageFee: o.packageFee ? String(o.packageFee) : '',
      commission: o.commission ? String(o.commission) : '',
      commissionRate: o.commissionRate ? String(Math.round(o.commissionRate * 100)) : '',
      idCard: o.idCard || '',
      address: o.address || '',
    };
  }
  return {
    applyDate: seed.applyDate || todayStr(),
    paybackDate: '',
    name: seed.name || '',
    phone: seed.phone || '',
    province: seed.province || '',
    city: seed.city || '',
    carrier: seed.carrier || '联通',
    pkg: seed.package || '300m',
    duration: seed.duration || '1年',
    installFee: seed.installFee ? String(seed.installFee) : '',
    packageFee: seed.packageFee ? String(seed.packageFee) : '',
    commission: seed.commission ? String(seed.commission) : '',
    commissionRate: '',
    idCard: seed.idCard || '',
    address: seed.address || '',
  };
}

export default function OrderForm({ editingId, seed, allOrders, onClose, submitOrder }: OrderFormProps) {
  const [f, setF] = useState<FormState>(() => initialState(editingId, seed));
  // 编辑时佣金率是按旧佣金预填的。改了佣金或套餐费后它就对不上了，
  // 不清掉会把旧比例原样存回去。只在它仍是预填值时才清空（保存时按
  // 佣金 ÷ 套餐费 重算），手动改过的佣金率不动。
  const [prefilledRate] = useState(() =>
    editingId != null && seed.commissionRate ? String(Math.round(seed.commissionRate * 100)) : '',
  );
  const [saving, setSaving] = useState(false);

  const set = (patch: Partial<FormState>) => setF((prev) => ({ ...prev, ...patch }));

  // 给下拉框赋一个选项里没有的值，浏览器会静默置空，保存时就把原值抹掉了。
  // 智能提取和 CSV 导入都可能给出「18个月」这类非预置写法，这里按需补进候选。
  const carrierOptions = useMemo(
    () => (CARRIERS.includes(f.carrier) ? CARRIERS : [...CARRIERS, f.carrier]),
    [f.carrier],
  );
  const durationOptions = useMemo(
    () => (DURATIONS.includes(f.duration) ? DURATIONS : [...DURATIONS, f.duration]),
    [f.duration],
  );

  // 佣金率输入框的候选也一样：预填值可能是任意两位数，不预置就显示不出来
  const rateStepOk = Number(f.commissionRate) >= 0 && Number(f.commissionRate) <= 100;

  const onCommissionOrFeeChange = (patch: Partial<FormState>) => {
    setF((prev) => {
      const next = { ...prev, ...patch };
      // 预填佣金率的清空逻辑：仍是预填值时才清空，手动改过的不动
      if (prefilledRate && next.commissionRate === prefilledRate) {
        next.commissionRate = '';
      }
      return next;
    });
  };

  const onCommissionChange = (e: ChangeEvent<HTMLInputElement>) =>
    onCommissionOrFeeChange({ commission: e.target.value });
  const onPackageFeeChange = (e: ChangeEvent<HTMLInputElement>) =>
    onCommissionOrFeeChange({ packageFee: e.target.value });

  // 手动录入时，从地址栏文本识别省市并回填——复用智能录入用的同一套地址解析逻辑
  const fillLocationFromAddress = () => {
    const addr = f.address.trim();
    if (!addr) {
      toast('请先填写地址', { type: 'warn' });
      return;
    }
    const loc = extractCityFromAddress(addr);
    if (!loc.city && !loc.province) {
      toast('未能从地址中识别出省市，请手动填写', { type: 'warn' });
      return;
    }
    set({
      city: loc.city || f.city,
      province: loc.province || f.province,
    });
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;
    const name = f.name.trim();
    const phone = f.phone.trim();
    const pkgFee = Number(f.packageFee) || 0;
    if (!name || !phone || !pkgFee) {
      toast('请填写姓名、手机号和套餐费', { type: 'error' });
      return;
    }
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      toast('手机号格式不正确，应为 11 位数字', { type: 'error' });
      return;
    }
    const idCard = f.idCard.trim().toUpperCase();
    if (idCard && !/^\d{17}[\dX]$/.test(idCard)) {
      toast('身份证号格式不正确，应为 18 位', { type: 'error' });
      return;
    }
    const ratePctRaw = f.commissionRate.trim();
    if (ratePctRaw && !rateStepOk) {
      toast('佣金率应在 0–100 之间', { type: 'error' });
      return;
    }
    if (f.paybackDate && f.applyDate && f.paybackDate < f.applyDate) {
      toast('结佣日期不能早于办理日期', { type: 'error' });
      return;
    }

    // 新增时的重复手机号提醒由 store.submitOrder 统一弹（查的是全库快照）。
    // 表单层不再确认一次，否则同一个号码会连出两个确认框。
    const commission = Number(f.commission) || 0;
    const ratePct = Number(f.commissionRate);
    let rate = ratePct ? ratePct / 100 : pkgFee > 0 ? commission / pkgFee : 0;
    rate = Math.round(rate * 10000) / 10000;
    const draft: Partial<Order> = {
      applyDate: f.applyDate,
      paybackDate: f.paybackDate,
      name,
      phone,
      province: f.province.trim(),
      city: f.city.trim(),
      carrier: f.carrier,
      package: f.pkg,
      duration: f.duration,
      installFee: Number(f.installFee) || 0,
      packageFee: pkgFee,
      commission,
      commissionRate: rate,
      idCard,
      address: f.address.trim(),
      salesPerson:
        editingId != null
          ? allOrders.find((o) => o.id === editingId)?.salesPerson || SALES_PERSON
          : SALES_PERSON,
    };

    setSaving(true);
    const ok = await submitOrder(draft);
    setSaving(false);
    if (ok) onClose();
  };

  return (
    <Modal title={editingId != null ? '编辑订单' : '新增订单'} onClose={onClose}>
      <form className="orders-form-grid" onSubmit={handleSubmit}>
        <div className="orders-form-group">
          <label>办理日期 *</label>
          <input type="date" value={f.applyDate} onChange={(e) => set({ applyDate: e.target.value })} required />
        </div>
        <div className="orders-form-group">
          <label>结佣日期</label>
          <input type="date" value={f.paybackDate} onChange={(e) => set({ paybackDate: e.target.value })} />
        </div>
        <div className="orders-form-group">
          <label>姓名 *</label>
          <input value={f.name} placeholder="客户姓名" onChange={(e) => set({ name: e.target.value })} />
        </div>
        <div className="orders-form-group">
          <label>手机号 *</label>
          <input value={f.phone} placeholder="11位手机号" maxLength={11} onChange={(e) => set({ phone: e.target.value })} />
        </div>
        <div className="orders-form-group">
          <label>省份</label>
          <input value={f.province} placeholder="省份" onChange={(e) => set({ province: e.target.value })} />
        </div>
        <div className="orders-form-group">
          <label>城市</label>
          <input value={f.city} placeholder="城市" onChange={(e) => set({ city: e.target.value })} />
        </div>
        <div className="orders-form-group">
          <label>运营商</label>
          <select value={f.carrier} onChange={(e) => set({ carrier: e.target.value })}>
            {carrierOptions.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="orders-form-group">
          <label>套餐</label>
          <input value={f.pkg} list="orders-package-suggestions" placeholder="如 300m、1000M" onChange={(e) => set({ pkg: e.target.value })} />
          <datalist id="orders-package-suggestions">
            {PACKAGES.map((p) => <option key={p} value={p} />)}
          </datalist>
        </div>
        <div className="orders-form-group">
          <label>时限</label>
          <select value={f.duration} onChange={(e) => set({ duration: e.target.value })}>
            {durationOptions.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
        <div className="orders-form-group">
          <label>安装费</label>
          <input type="number" min={0} placeholder="0" value={f.installFee} onChange={(e) => set({ installFee: e.target.value })} />
        </div>
        <div className="orders-form-group">
          <label>套餐费 *</label>
          <input type="number" min={0} placeholder="0" value={f.packageFee} onChange={onPackageFeeChange} />
        </div>
        <div className="orders-form-group">
          <label>佣金 *</label>
          <input type="number" min={0} placeholder="0" value={f.commission} onChange={onCommissionChange} />
        </div>
        <div className="orders-form-group">
          <label>佣金率(%)</label>
          <input
            type="number"
            min={0}
            max={100}
            step={1}
            placeholder="自动计算"
            value={f.commissionRate}
            onChange={(e) => set({ commissionRate: e.target.value })}
          />
        </div>
        <div className="orders-form-group span2">
          <label>身份证号</label>
          <input value={f.idCard} placeholder="18位身份证号" maxLength={18} onChange={(e) => set({ idCard: e.target.value })} />
        </div>
        <div className="orders-form-group span3">
          <label className="orders-form-label-row">
            地址
            <button type="button" className="orders-btn orders-btn-sm orders-btn-ghost" onClick={fillLocationFromAddress}>
              从地址识别省市
            </button>
          </label>
          <textarea rows={2} placeholder="详细地址" value={f.address} onChange={(e) => set({ address: e.target.value })} />
        </div>
        <div className="orders-modal-actions span3">
          <button type="button" className="orders-btn orders-btn-cancel" onClick={onClose}>取消</button>
          <button type="submit" className="orders-btn orders-btn-primary" disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
