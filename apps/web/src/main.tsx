import React, { Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter, Routes, Route } from 'react-router-dom';
import './index.css';
// 订单模块的样式是独立一套（沿用 Sales-order 的类名），变量取自 index.css 的 :root。
// 它不属于 tailwind 体系，必须在这里显式引入 —— 只在页面组件里 import 会让
// 首屏样式随懒加载 chunk 才到，登录页会先裸奔一帧。
import './orders/orders.css';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import { bootstrapTheme } from './lib/theme';

bootstrapTheme();

// Service Worker：订单页断网时靠它回退到本地缓存。
// 只走相对路径 'sw.js' —— base 是 './'，部署在 /dashboard/ 还是根路径都指向
// <root>/sw.js，作用域也正好是 <root>/，不需要写死前缀。
// file:// 和 data: 下注册必然抛错，先判协议；注册失败不影响主流程，吞掉即可。
if ('serviceWorker' in navigator && /^https?:$/.test(window.location.protocol)) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

const Dashboard = React.lazy(() => import('./pages/Dashboard'));
const Writer = React.lazy(() => import('./pages/Writer'));
const Library = React.lazy(() => import('./pages/Library'));
const Orders = React.lazy(() => import('./pages/Orders'));

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <HashRouter>
        <Suspense fallback={<div className="text-center py-20" style={{ color: 'var(--text-3)' }}>加载中...</div>}>
          <Routes>
            <Route element={<App />}>
              {/* 工作台首页 + 三个业务模块。设置页已删除 ——
                  其中唯一还需要的动作（风格画像「重新分析」）已内联到仿写页，
                  访问令牌则由 TokenGate 在 401 时自动弹出。
                  销售订单是按 Sales-order 的语义原生重写的页面（#/orders），
                  不再用 iframe。 */}
              <Route path="/" element={<Dashboard />} />
              <Route path="/writer" element={<Writer />} />
              <Route path="/library" element={<Library />} />
              <Route path="/orders" element={<Orders />} />
              <Route path="*" element={<Dashboard />} />
            </Route>
          </Routes>
        </Suspense>
      </HashRouter>
    </ErrorBoundary>
  </React.StrictMode>
);
