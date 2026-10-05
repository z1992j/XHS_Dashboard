/**
 * 「销售订单登记」的宿主页面。
 *
 * 订单页是原 Sales-order 项目的整套静态代码（index.html + app.css + app.js，
 * app.js 两千多行，依赖全局函数与内联 onclick），逐字平移进 public/orders/，
 * 由这个 iframe 承载。
 *
 * 为什么不重写成 React 组件：那套代码的每一个行为（判重、按 id 保存、
 * 智能录入的多条解析、图表不吃本维筛选的例外规则）都是踩过坑之后写定的，
 * 重写只会用新的 bug 换掉已经验证过的逻辑。「平移」的要求是行为完全一致。
 *
 * iframe 占满剩余视口，让订单页在自己的文档里滚动：它的表头吸顶
 * （thead sticky）和 .table-wrap 的 max-height:calc(100vh - 200px)
 * 本来就是按「整页只有一个滚动容器」设计的，viewport 即 iframe 高度，
 * 这些规则原样成立，不需要外层再算一次高度。
 */
import { useMemo, useState } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';

export default function OrdersHost() {
  const [loaded, setLoaded] = useState(false);

  // import.meta.env.BASE_URL 已经是部署前缀（/dashboard/），
  // 订单页随之落在 /dashboard/orders/，跟着构建产物一起走，不写死域名。
  const src = useMemo(() => `${import.meta.env.BASE_URL}orders/index.html`, []);

  return (
    <div className="orders-host">
      {!loaded && (
        <div className="orders-host-loading">
          <Loader2 size={16} className="animate-spin" />
          <span>正在加载销售订单…</span>
        </div>
      )}
      <iframe
        title="销售订单登记"
        src={src}
        className="orders-frame"
        onLoad={() => setLoaded(true)}
        // 订单页要用 localStorage 存登录态与离线缓存、要下载 CSV、
        // 要开弹窗；它是同源页面，不额外放开 allow-scripts 之外的权限。
        referrerPolicy="no-referrer"
      />
      <a className="orders-open-newtab" href={src} target="_blank" rel="noreferrer">
        <ExternalLink size={13} />
        新窗口打开
      </a>
    </div>
  );
}
