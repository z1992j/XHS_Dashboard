import { useMemo, useState } from 'react';
import { ChevronDown, ShieldCheck, AlertTriangle, Tags } from 'lucide-react';
import { buildInsights, MAX_PAIR_SCAN } from '../lib/insights';
import type { Material } from '../lib/api';

/**
 * 素材库洞察。
 *
 * 形式是照着「这个数据要回答什么问题」选的，不是先想画什么图：
 * - 重复风险要回答「具体哪两篇撞了」→ 排行列表，不是直方图。
 *   分布图只能告诉你"有问题"，列表直接告诉你去改哪一篇。
 * - 标签要回答「下一篇打什么」→ 横向条形（中文标签长，横向不用转头读）。
 *
 * 配色上有一条实测结论：把项目的状态三色喂给色盲校验脚本，
 * 琥珀↔绿在红色盲下 ΔE 只有 5.1（及格线 8），琥珀对白底对比度也只有 2.31:1。
 * 所以风险等级一律「颜色 + 文字标签 + 数值」三重编码，颜色只是装饰，
 * 拿掉它信息依然完整。
 */

const LEVEL_COLOR: Record<string, string> = {
  risky: 'var(--danger)',
  fair: 'var(--accent)',
  good: 'var(--success)',
};

export default function LibraryInsights({ materials }: { materials: Material[] }) {
  const [open, setOpen] = useState(false);
  // 两两比对有成本，折叠状态下不算 —— 打开素材库的人多数只是想找一篇文案
  const insights = useMemo(
    () => (open ? buildInsights(materials) : null),
    [open, materials]
  );

  if (!materials.length) return null;

  return (
    <div className="white-card overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="insights-toggle"
        aria-expanded={open}
      >
        <span className="inline-flex items-center gap-2">
          <ShieldCheck size={14} style={{ color: 'var(--primary)' }} />
          <span className="text-xs font-semibold" style={{ color: 'var(--text)' }}>素材库洞察</span>
          <span className="text-[11px]" style={{ color: 'var(--text-3)' }}>
            查重风险 · 标签分布
          </span>
        </span>
        <ChevronDown
          size={14}
          className={`transition-transform ${open ? 'rotate-180' : ''}`}
          style={{ color: 'var(--text-3)' }}
        />
      </button>

      {open && insights && (
        <div className="insights-body">
          {/* 三个数：先给结论，再给明细 */}
          <div className="stat-row">
            <div className="stat-tile">
              <div className="stat-value">{insights.total}</div>
              <div className="stat-label">素材总数</div>
            </div>
            <div className="stat-tile">
              <div
                className="stat-value"
                style={{ color: insights.riskyPairCount ? 'var(--danger)' : 'var(--success)' }}
              >
                {insights.riskyPairCount}
              </div>
              <div className="stat-label">高重合配对</div>
            </div>
            <div className="stat-tile">
              <div className="stat-value">{insights.tags.length}</div>
              <div className="stat-label">常用标签</div>
            </div>
          </div>

          {/* 重复风险 —— 这是整个面板的理由：平台对同账号重复内容一样限流，
              而此前只在生成单篇时比过原文，库里两篇旧文案撞车从来没人看见过 */}
          <section className="insights-section">
            <h3 className="insights-h">
              <AlertTriangle size={12} style={{ color: 'var(--text-3)' }} />
              库内重复风险
              {materials.length > MAX_PAIR_SCAN && (
                <span className="insights-note">仅比对最近 {insights.scanned} 篇</span>
              )}
            </h3>
            {insights.pairs.length === 0 ? (
              <p className="insights-empty">
                没有发现明显重合的配对，库里的文案彼此区分度够。
              </p>
            ) : (
              <ul className="pair-list">
                {insights.pairs.map((p) => (
                  <li key={`${p.a.id}-${p.b.id}`} className="pair-item">
                    <span
                      className="pair-score"
                      style={{ color: LEVEL_COLOR[p.level], borderColor: LEVEL_COLOR[p.level] }}
                    >
                      {p.score}
                    </span>
                    <span className="pair-titles">
                      <span className="pair-title">{p.a.title || '(无标题)'}</span>
                      <span className="pair-vs">与</span>
                      <span className="pair-title">{p.b.title || '(无标题)'}</span>
                    </span>
                    {/* 文字标签是必需的，不是冗余：状态色在红色盲下分不开 */}
                    <span className="pair-label" style={{ color: LEVEL_COLOR[p.level] }}>
                      {p.label}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* 标签分布 —— 单系列，所以不需要图例，标题已经说明了它是什么 */}
          <section className="insights-section">
            <h3 className="insights-h">
              <Tags size={12} style={{ color: 'var(--text-3)' }} />
              标签分布
            </h3>
            {insights.tags.length === 0 ? (
              <p className="insights-empty">素材还没有打过标签。</p>
            ) : (
              <ul className="tag-bars">
                {insights.tags.map((t) => (
                  <li key={t.name} className="tag-bar-row" title={`${t.name}：${t.count} 篇`}>
                    <span className="tag-bar-name">{t.name}</span>
                    <span className="tag-bar-track">
                      <span className="tag-bar-fill" style={{ width: `${t.percent}%` }} />
                    </span>
                    <span className="tag-bar-count">{t.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
