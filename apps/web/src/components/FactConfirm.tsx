import { useState } from 'react';
import { AlertTriangle, Check, Plus, Trash2, ScanLine } from 'lucide-react';
import type { VisionFact } from '../lib/api';

/**
 * 事实确认卡 —— 看图成文功能的信任锚点。
 *
 * 模型从图里读出的每一条信息都要在这里过一遍人眼才能进入生成环节。
 * 没有这一步，这个功能就是一台价格编造机：文案卖的是套餐价格和带宽，
 * 模型把 59 读成 58，用户发出去，客户就按错的价格上门。
 *
 * 所以低置信度的条目默认不勾选，必须显式确认。
 */

interface Props {
  scene: string;
  hasText: boolean;
  facts: VisionFact[];
  warnings: string[];
  onChange: (facts: VisionFact[]) => void;
  onConfirm: (facts: VisionFact[]) => void;
  disabled?: boolean;
}

export default function FactConfirm({
  scene, hasText, facts, warnings, onChange, onConfirm, disabled,
}: Props) {
  // 高置信度默认勾上；低置信度必须用户自己点，避免"一路下一步"把错数字带过去
  const [accepted, setAccepted] = useState<Set<number>>(
    () => new Set(facts.map((f, i) => (f.confidence === 'high' ? i : -1)).filter(i => i >= 0))
  );
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');

  const lowCount = facts.filter(f => f.confidence === 'low').length;
  const pendingLow = facts.filter((f, i) => f.confidence === 'low' && !accepted.has(i)).length;

  const toggle = (i: number) => {
    setAccepted(prev => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  };

  const editFact = (i: number, patch: Partial<VisionFact>) => {
    const next = facts.map((f, idx) => (idx === i ? { ...f, ...patch } : f));
    onChange(next);
    // 用户手改过的值就是他自己确认的，直接勾上
    if (patch.value !== undefined) setAccepted(prev => new Set(prev).add(i));
  };

  const removeFact = (i: number) => {
    onChange(facts.filter((_, idx) => idx !== i));
    setAccepted(prev => {
      const next = new Set<number>();
      for (const idx of prev) {
        if (idx < i) next.add(idx);
        else if (idx > i) next.add(idx - 1);
      }
      return next;
    });
  };

  const addFact = () => {
    const k = newKey.trim();
    const v = newValue.trim();
    if (!k || !v) return;
    onChange([...facts, { key: k, value: v, confidence: 'high' }]);
    setAccepted(prev => new Set(prev).add(facts.length));
    setNewKey('');
    setNewValue('');
  };

  const confirmedFacts = facts.filter((_, i) => accepted.has(i));

  return (
    <div className="white-card p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold flex items-center gap-2" style={{ color: 'var(--text)' }}>
          <ScanLine size={15} style={{ color: 'var(--primary)' }} />
          确认图中信息
        </span>
        <span className="text-[11px]" style={{ color: 'var(--text-3)' }}>
          已确认 {confirmedFacts.length}/{facts.length}
        </span>
      </div>

      {scene && (
        <p className="text-xs leading-relaxed px-3 py-2 rounded-lg" style={{ background: 'var(--bg)', color: 'var(--text-2)' }}>
          {scene}
        </p>
      )}

      {!hasText && (
        <div className="alert-yellow">
          <span>⚠</span>
          这张图没有读到套餐信息。可以在下面手动补充，或者换一张带文字的图片 —— 直接生成的话只能写氛围向的内容。
        </div>
      )}

      {warnings.map((w, i) => (
        <div key={i} className="flex items-start gap-2 text-[11px] px-3 py-2 rounded-lg"
          style={{ background: 'var(--accent-light)', color: 'var(--text-2)' }}>
          <AlertTriangle size={12} className="shrink-0 mt-0.5" style={{ color: 'var(--accent)' }} />
          {w}
        </div>
      ))}

      {facts.length > 0 && (
        <div className="space-y-1.5">
          {facts.map((f, i) => {
            const on = accepted.has(i);
            const low = f.confidence === 'low';
            return (
              <div
                key={i}
                className="flex items-center gap-2 px-2.5 py-2 rounded-lg"
                style={{
                  background: low && !on ? 'var(--accent-light)' : 'var(--bg)',
                  border: '1px solid ' + (low && !on ? 'var(--accent)' : 'var(--border)'),
                }}
              >
                <button
                  onClick={() => toggle(i)}
                  className="w-4 h-4 rounded shrink-0 flex items-center justify-center"
                  style={{
                    background: on ? 'var(--success)' : 'transparent',
                    border: '1.5px solid ' + (on ? 'var(--success)' : 'var(--text-3)'),
                  }}
                  aria-label={on ? `取消确认 ${f.key}` : `确认 ${f.key}`}
                >
                  {on && <Check size={10} className="text-white" />}
                </button>

                <input
                  value={f.key}
                  onChange={(e) => editFact(i, { key: e.target.value })}
                  className="w-20 shrink-0 text-[11px] px-1.5 py-1 rounded bg-transparent"
                  style={{ color: 'var(--text-3)', border: '1px solid transparent' }}
                  aria-label="信息名称"
                />
                <input
                  value={f.value}
                  onChange={(e) => editFact(i, { value: e.target.value })}
                  className="flex-1 min-w-0 text-[13px] px-2 py-1 rounded input-glow"
                  style={{ border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text)' }}
                  aria-label={`${f.key} 的值`}
                />

                {low && (
                  <span className="text-[9px] px-1.5 py-0.5 rounded-full shrink-0"
                    style={{ background: 'var(--accent)', color: '#fff' }}>
                    请核对
                  </span>
                )}

                <button onClick={() => removeFact(i)} className="btn-icon danger shrink-0" aria-label={`删除 ${f.key}`}>
                  <Trash2 size={12} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* 手动补充：图里没印出来但用户知道的信息 */}
      <div className="flex items-center gap-1.5">
        <input
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          placeholder="补充项"
          className="w-20 text-[11px] px-2 py-1.5 rounded-lg input-glow"
          style={{ border: '1px solid var(--border)', background: 'var(--bg)' }}
        />
        <input
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addFact(); } }}
          placeholder="内容"
          className="flex-1 min-w-0 text-[12px] px-2.5 py-1.5 rounded-lg input-glow"
          style={{ border: '1px solid var(--border)', background: 'var(--bg)' }}
        />
        <button
          onClick={addFact}
          disabled={!newKey.trim() || !newValue.trim()}
          className="btn-outlined shrink-0 px-2.5 py-1.5 rounded-lg text-[11px] font-medium flex items-center gap-1 disabled:opacity-40"
        >
          <Plus size={11} />
          添加
        </button>
      </div>

      {pendingLow > 0 && (
        <p className="text-[11px]" style={{ color: 'var(--accent)' }}>
          还有 {pendingLow} 条低置信度信息没确认，它们不会被写进文案
        </p>
      )}

      <button
        onClick={() => onConfirm(confirmedFacts)}
        disabled={disabled}
        className="btn-primary w-full h-10 rounded-xl text-sm flex items-center justify-center gap-2"
      >
        <Check size={15} />
        {confirmedFacts.length > 0
          ? `用这 ${confirmedFacts.length} 条信息生成文案`
          : '不带具体信息，直接生成'}
      </button>

      {lowCount > 0 && (
        <p className="text-[10px] text-center" style={{ color: 'var(--text-3)' }}>
          数字类信息请务必核对原图，发布后写错价格很难补救
        </p>
      )}
    </div>
  );
}
