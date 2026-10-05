import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  PenLine, FolderOpen, ClipboardList, ChevronRight, CloudOff, CheckCircle2, Loader2,
} from 'lucide-react';
import { fetchCapabilities, type ServerCapabilities } from '../lib/api';

interface ModuleCard {
  to: string;
  icon: typeof PenLine;
  title: string;
  desc: string;
  meta: string;
}

const modules: ModuleCard[] = [
  {
    to: '/writer',
    icon: PenLine,
    title: '文案仿写',
    desc: '粘贴小红书链接或上传套餐图，AI 保留全部关键事实、换一种表达重写。',
    meta: '链接提取 · 看图成文 · 去 AI 味 · 我的风格',
  },
  {
    to: '/library',
    icon: FolderOpen,
    title: '素材库',
    desc: '已生成的笔记存档在这里，支持搜索、批量管理，以及整库级别的重复洞察。',
    meta: '素材管理 · 仿写历史 · 库内查重',
  },
  {
    to: '/orders',
    icon: ClipboardList,
    title: '销售订单',
    desc: '宽带客资登记与结佣跟踪。智能录入、CSV 导入导出、看板与分析全部跟随筛选。',
    meta: '客资登记 · 结佣跟踪 · 续约提醒 · 热销分析',
  },
];

function CapRow({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`dash-cap ${ok ? 'on' : 'off'}`} title={ok ? '服务端已开启' : '服务端未开启或未连通'}>
      {ok ? <CheckCircle2 size={12} /> : <CloudOff size={12} />}
      {label}
    </span>
  );
}

/**
 * 工作台首页。
 *
 * 只做两件事：给出三个模块的入口，以及报一次后端连通性。
 * 订单模块的数据在 Supabase 那侧，这里探测的是文案仿写的 API，
 * 所以把它标成「文案服务」而不是笼统的「服务状态」——
 * 之前踩过一次：绿灯亮着但订单登录失败，两个不是一回事。
 */
export default function Dashboard() {
  const [cap, setCap] = useState<ServerCapabilities | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let alive = true;
    fetchCapabilities()
      .then((c) => { if (alive) setCap(c); })
      .finally(() => { if (alive) setChecking(false); });
    return () => { alive = false; };
  }, []);

  // fetchCapabilities 从不抛错，连不上时返回的是「全 false」的回落值 ——
  // 所以「有没有连通」只能看 reachable，不能看 cap 在不在。
  // 过一道局部变量，下面用字段时就不用再判空。
  const up = cap && cap.reachable ? cap : null;

  return (
    <div className="dash">
      <section className="dash-status" aria-label="文案服务状态">
        <div className="dash-status-title">
          {checking
            ? <Loader2 size={14} className="animate-spin" />
            : <span className={`dash-dot ${up ? 'ok' : 'bad'}`} />}
          <span>文案服务</span>
        </div>
        <div className="dash-caps">
          {checking ? (
            <span className="dash-cap off">正在探测…</span>
          ) : !up ? (
            // 只看字段的话这里会显示一排「未开启」，把人引向「去配服务器」，
            // 而真实原因是后端没起来 —— 所以先按 reachable 分流。
            <span className="dash-cap off">
              连不上，仿写与素材库暂时不可用；销售订单走的是另一个数据源，不受影响
            </span>
          ) : (
            <>
              <CapRow ok label="接口连通" />
              <CapRow ok={up.vision} label="看图成文" />
              <CapRow ok={up.styleProfile} label="我的风格" />
              <CapRow ok={up.gallery} label="图集" />
              <CapRow ok={up.templateSync} label="云端模板" />
              {up.textModel && (
                <span
                  className="dash-cap model"
                  title={up.textModelPinned ? '服务端 .env 钉死了型号，推代码改不动它' : '跟随代码默认值'}
                >
                  {up.textModel}
                </span>
              )}
            </>
          )}
        </div>
      </section>

      <section className="dash-grid">
        {modules.map((m) => (
          <Link key={m.to} to={m.to} className="dash-card">
            <div className="dash-card-head">
              <span className="dash-card-icon">
                <m.icon size={17} />
              </span>
              <span className="dash-card-title">{m.title}</span>
              <ChevronRight size={16} className="dash-card-arrow" />
            </div>
            <p className="dash-card-desc">{m.desc}</p>
            <p className="dash-card-meta">{m.meta}</p>
          </Link>
        ))}
      </section>
    </div>
  );
}
