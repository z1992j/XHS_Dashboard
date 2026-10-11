import { useEffect } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { PenLine, FolderOpen, ClipboardList, LayoutGrid, Sun, Moon } from 'lucide-react';
import { useTheme } from './lib/theme';
import TokenGate from './components/TokenGate';
import BrandMark from './components/BrandMark';
import { syncTemplates } from './lib/templates';

const tabs = [
  { to: '/', icon: LayoutGrid, label: '工作台', end: true },
  { to: '/writer', icon: PenLine, label: '文案仿写' },
  { to: '/library', icon: FolderOpen, label: '素材库' },
  { to: '/orders', icon: ClipboardList, label: '销售订单' },
];

function ThemeToggle() {
  const { resolved, toggle } = useTheme();
  return (
    <button
      className="theme-toggle"
      onClick={toggle}
      aria-label={resolved === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
      title={resolved === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
    >
      {resolved === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}

/**
 * 工作台外壳。
 *
 * 三个业务模块共用一条头部栏：文案仿写、素材库（红薯助手的两个页面）、
 * 销售订单（React 原生页面，随本壳渲染）。
 *
 * 销售订单要占满整个视口宽度：.app-main 在 /orders 下去掉居中的
 * max-width（CSS 里用 .app-main-flush 覆盖），17 列的订单表格才放得下。
 * 注意不再锁 .app-shell-flush：旧 iframe 方案要求整壳一屏高、滚动只发生
 * 在 iframe 内部，现在订单页和别的页面一样跟随外壳整体滚动，
 * 它自己的 .orders-table-wrap 在桌面端维持内部吸顶滚动。
 *
 * 设置页已删除：其中唯一还需要的动作（风格画像「重新分析」）内联到了
 * 仿写页「我的风格」那一行；访问令牌不需要手动入口，服务端返回 401 时
 * TokenGate 会自己弹出来。
 */
export default function App() {
  const { pathname } = useLocation();

  // 启动时把本地模板和云端副本合并一次。失败静默 —— 本地缓存照常可用。
  useEffect(() => { syncTemplates().catch(() => {}); }, []);

  // 销售订单要占满视口：外层再套一层居中宽度会把它的表格压窄。
  const flush = pathname === '/orders';

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header-inner">
          <div className="brand">
            <BrandMark size={30} />
            <span className="brand-text">
              <span className="brand-name">运营工作台</span>
              <span className="brand-sub">文案仿写 · 素材库 · 销售订单</span>
            </span>
          </div>
          <nav className="head-nav" aria-label="主导航">
            {tabs.map((tab) => (
              <NavLink
                key={tab.to}
                to={tab.to}
                end={tab.end}
                title={tab.label}
                aria-label={tab.label}
                className={({ isActive }) => `head-nav-link ${isActive ? 'active' : ''}`}
              >
                <tab.icon size={14} />
                <span className="head-nav-label">{tab.label}</span>
              </NavLink>
            ))}
          </nav>
          <ThemeToggle />
        </div>
      </header>

      <main className={`app-main ${flush ? 'app-main-flush' : ''}`}>
        <Outlet />
      </main>

      {/* 只在用得到文案 API 的路由上挂令牌弹窗。
          外壳启动时会同步一次云端模板，线上后端开了鉴权 → 回 401 →
          TokenGate 自己弹出来。如果人正在「销售订单」（数据在 Supabase，
          跟这台后端无关），那个弹窗会盖在订单登录页上面，
          两个密码看起来一模一样，点确定必然失败。 */}
      {!flush && <TokenGate />}
    </div>
  );
}
