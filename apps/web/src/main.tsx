import React, { Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter, Routes, Route } from 'react-router-dom';
import './index.css';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import { bootstrapTheme } from './lib/theme';

bootstrapTheme();

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
                  销售订单是原 Sales-order 静态页，整页 iframe 挂在 /orders。 */}
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
