import { useState } from 'react';
import type { Order } from '../types';
import Modal from '../Modal';
import { money } from '../format';
import { parseOrderText, splitOrderText, checkParsed } from '../smartInput';
import { appConfirm } from '../confirm';
import { toast } from '../toast';

export interface SmartInputModalProps {
  allOrders: Order[];
  onClose: () => void;
  /**
   * 单条：把解析结果交给新增表单。调用方必须开成新增态（editingId 为空），
   * 不能残留编辑中的 id —— 否则保存会覆盖掉那条订单而不是新增。
   */
  openForm: (seed: Partial<Order>) => void;
  submitOrder: (draft: Partial<Order>) => Promise<boolean>;
}

interface BatchRow {
  parsed: ReturnType<typeof parseOrderText>;
  errors: string[];
  warns: string[];
  commission: number;
  include: boolean;
}

/**
 * 智能录入：粘贴文本 → splitOrderText 判断单条/多条。
 * 单条解析后展示提取结果并把 seed 交给 openForm（新增态）；
 * 多条渲染可勾选表格，佣金可逐行改，底部按钮文案随阶段变化。
 */
export default function SmartInputModal({ allOrders, onClose, openForm, submitOrder }: SmartInputModalProps) {
  const [text, setText] = useState('');
  // '' = 还没提取；'one' = 单条已提取；'batch' = 多条已提取
  const [stage, setStage] = useState<'' | 'one' | 'batch'>('');
  const [single, setSingle] = useState<ReturnType<typeof parseOrderText> | null>(null);
  const [batch, setBatch] = useState<BatchRow[]>([]);
  const [saving, setSaving] = useState(false);

  // 改了粘贴内容就回到「提取」状态，免得拿着旧的解析结果去保存
  const reset = () => {
    setStage('');
    setSingle(null);
    setBatch([]);
  };

  const handleExtract = () => {
    const t = text.trim();
    if (!t) {
      toast('请粘贴订单信息', { type: 'warn' });
      return;
    }
    const parts = splitOrderText(t);
    if (parts.length > 1) {
      const seen = new Set<string>();
      setBatch(
        parts.map((p) => {
          const parsed = parseOrderText(p);
          const { errors, warns } = checkParsed(parsed, seen, allOrders);
          // 有错误的不能保存；手机号已在库里的多半是重复粘贴，默认不勾，需要时手动勾上
          return {
            parsed,
            errors,
            warns,
            commission: parsed.commission || 0,
            include: !errors.length && !warns.includes('手机号已存在') && !warns.includes('本批重复'),
          };
        }),
      );
      setStage('batch');
      return;
    }
    setSingle(parseOrderText(t));
    setStage('one');
  };

  // 单条：填进「新增订单」表单。openForm 的调用方负责开成新增态——
  // 否则刚编辑过别的订单再来智能录入，保存时会覆盖掉那一条
  const fillSingle = () => {
    if (!single) return;
    openForm(single);
    onClose();
  };

  const includedCount = batch.filter((r) => r.include && !r.errors.length).length;

  const saveBatch = async () => {
    const picked = batch.filter((r) => r.include && !r.errors.length);
    if (!picked.length) return;
    const missingCommission = picked.filter((r) => !r.commission).length;
    if (missingCommission > 0) {
      const ok = await appConfirm(
        `${missingCommission} 条没有填佣金，会按 ¥0 保存，之后可以再编辑。继续吗？`,
      );
      if (!ok) return;
    }
    setSaving(true);
    let nOk = 0;
    // 逐条提交：契约的 submitOrder 一次写一条，比旧版的整批 POST 慢，
    // 但能准确报告哪几条失败；批次中途失败不会丢掉已成功的条数
    for (const r of picked) {
      const p = r.parsed;
      const rate = p.packageFee > 0 ? Math.round((r.commission / p.packageFee) * 10000) / 10000 : 0;
      const ok = await submitOrder({
        applyDate: p.applyDate || '',
        paybackDate: '',
        name: p.name,
        phone: p.phone,
        province: p.province,
        city: p.city,
        carrier: p.carrier,
        package: p.package,
        duration: p.duration,
        installFee: p.installFee,
        packageFee: p.packageFee,
        commission: r.commission,
        commissionRate: rate,
        idCard: p.idCard,
        address: p.address,
      });
      if (ok) nOk++;
    }
    setSaving(false);
    if (nOk === picked.length) {
      toast(`已保存 ${nOk} 条订单`, { type: 'success' });
      onClose();
    } else {
      toast(`批量保存：成功 ${nOk} 条、失败 ${picked.length - nOk} 条`, { type: 'warn' });
    }
  };

  return (
    <Modal title="⚡ 智能录入" onClose={onClose} wide={stage === 'batch'}>
      <p className="orders-smart-sub">粘贴下单信息，自动提取并填充表单</p>
      <textarea
        className="orders-paste-area"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          reset();
        }}
        placeholder={'粘贴订单信息，例如：\n姓名：苏杰\n联系方式：17365306527\n身份证：452133200206081817\n办理地址（具体到房号）：江苏省无锡市滨湖区雪浪街道雪新苑7栋1302号\n办理套餐：移动单宽带1000兆，480元一年，包安装'}
      />
      <p className="orders-parse-hint">
        标签后带括号备注、用空格代替冒号都能识别；带宽支持 1000M / 1000兆 / 千兆，时限支持「一年」「两年」「18个月」「半年」。
        <br />
        <b>一次可以粘贴多条</b>：每条以「姓名」开头即可，会先列出来给你核对再批量保存。
      </p>

      {stage === 'one' && single && (
        <div className="orders-extracted-fields">
          {([
            ['姓名', single.name], ['手机', single.phone], ['身份证', single.idCard],
            ['地址', single.address], ['省份', single.province], ['城市', single.city],
            ['运营商', single.carrier], ['套餐', single.package], ['时限', single.duration],
            ['套餐费', single.packageFee ? `¥${single.packageFee}` : ''],
          ] as [string, string | number][])
            .filter(([, v]) => v)
            .map(([label, v]) => (
              <div key={label} className="field-row">
                <span className="field-label">{label}</span>
                <span className="field-value">{String(v)}</span>
              </div>
            ))}
        </div>
      )}

      {stage === 'batch' && (
        <div className="orders-extracted-fields batch">
          <div className="orders-batch-head">
            识别到 <b>{batch.length}</b> 条，核对后勾选要保存的；佣金可在这里直接填。
            有错误的不能勾选，「手机号已存在」的默认不勾。
          </div>
          <div className="orders-batch-scroll">
            <table className="orders-batch-table">
              <thead>
                <tr>
                  <th></th><th>姓名</th><th>手机号</th><th>城市</th><th>套餐</th>
                  <th className="text-right">套餐费</th><th>佣金</th><th>提示</th>
                </tr>
              </thead>
              <tbody>
                {batch.map((r, i) => (
                  <tr key={i} className={r.errors.length ? 'batch-bad' : ''}>
                    <td className="b-chk">
                      {/* 有错误的行禁用勾选：错误不解决，勾了也保存不了 */}
                      <input
                        type="checkbox"
                        checked={r.include}
                        disabled={r.errors.length > 0}
                        aria-label={`保存第 ${i + 1} 条`}
                        onChange={(e) =>
                          setBatch((prev) => prev.map((row, k) => (k === i ? { ...row, include: e.target.checked } : row)))
                        }
                      />
                    </td>
                    <td className="col-name b-name">{r.parsed.name || '—'}</td>
                    <td className="b-phone">{r.parsed.phone || '—'}</td>
                    <td className="b-city">{r.parsed.city || '—'}</td>
                    <td className="b-pkg">{r.parsed.carrier} {r.parsed.package} {r.parsed.duration}</td>
                    <td className="text-right b-fee">{r.parsed.packageFee ? money(r.parsed.packageFee) : '—'}</td>
                    <td className="b-com">
                      <input
                        type="number"
                        className="orders-batch-commission"
                        min={0}
                        placeholder="佣金"
                        value={r.commission || ''}
                        onChange={(e) =>
                          setBatch((prev) => prev.map((row, k) => (k === i ? { ...row, commission: Number(e.target.value) || 0 } : row)))
                        }
                      />
                    </td>
                    <td className="b-note">
                      {r.errors.map((e) => <span key={e} className="orders-batch-err">{e}</span>)}
                      {r.warns.map((w) => <span key={w} className="orders-batch-warn">{w}</span>)}
                      {!r.errors.length && !r.warns.length && <span className="orders-an-muted">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="orders-modal-actions">
        <button type="button" className="orders-btn orders-btn-cancel" onClick={onClose}>取消</button>
        {stage === 'batch' ? (
          <button
            type="button"
            className="orders-btn orders-btn-smart"
            onClick={saveBatch}
            disabled={includedCount === 0 || saving}
          >
            {saving ? '保存中…' : includedCount ? `保存 ${includedCount} 条` : '没有可保存的'}
          </button>
        ) : (
          <button type="button" className="orders-btn orders-btn-smart" onClick={stage === 'one' ? fillSingle : handleExtract}>
            {stage === 'one' ? '填充到新增表单' : '提取并填充'}
          </button>
        )}
      </div>
    </Modal>
  );
}
