# 🍠 小红书运营工作台

> 把「文案仿写」和「销售订单」两套工具收进一个工作台：一条导航、一次登录、一个部署产物。

<p align="center">
  <img src="apps/web/public/logo.svg" alt="小红书运营工作台" width="110" height="110" />
</p>

<p align="center">
  <a href="https://github.com/z1992j/XHS_Dashboard/actions/workflows/deploy-web.yml"><img src="https://github.com/z1992j/XHS_Dashboard/actions/workflows/deploy-web.yml/badge.svg" alt="Deploy Frontend" /></a>
  <a href="https://github.com/z1992j/XHS_Dashboard/actions/workflows/deploy-server.yml"><img src="https://github.com/z1992j/XHS_Dashboard/actions/workflows/deploy-server.yml/badge.svg" alt="Deploy Backend" /></a>
  <a href="https://github.com/z1992j/XHS_Dashboard/actions/workflows/test.yml"><img src="https://github.com/z1992j/XHS_Dashboard/actions/workflows/test.yml/badge.svg" alt="CI Tests" /></a>
</p>

---

## 这是什么

两个已经在跑的项目合并成一个工作台，功能全部保留，没有删减：

| 模块 | 来源 | 落地形态 |
|---|---|---|
| 文案仿写 | [XHS-writer](https://github.com/z1992j/XHS-writer) `apps/web` 的 Writer 页 | React 页面，路由 `#/writer` |
| 素材库 | 同上，Library 页 | React 页面，路由 `#/library` |
| 销售订单 | [Sales-order](https://github.com/z1992j/Sales-order) 整站 | 静态页，`/dashboard/orders/`，路由 `#/orders` 用 iframe 承载 |
| 工作台首页 | 新增 | 三个模块入口 + 文案服务连通性 |

后端沿用 XHS-writer 的 Express API（`/api/xhs/*`）与 MySQL `broadband` 库，
订单模块继续走它自己的 Supabase —— **两边数据源没有合并，也不需要合并**。

---

## 本地开发

```bash
# 前端（工作台外壳 + 订单静态页）
cd apps/web && npm install && npx vite          # http://localhost:5173/dashboard/

# 后端（可选；不想起数据库就把 vite 代理打到线上）
cd apps/server && npm install && node src/index.js
```

把 dev server 指到线上后端，就不用本地装 MySQL：

```bash
cd apps/web
VITE_API_PROXY_TARGET=http://47.252.19.224 npx vite
```

线上后端开了鉴权，浏览器首次访问会弹令牌框，填 `API_TOKEN` 的值即可。

### 测试与构建

```bash
cd apps/web    && npm test && npx tsc --noEmit && npx vite build   # 96 项
cd apps/server && npm test                                          # 173 项
```

> `lightningcss` 的可选原生依赖在 `npm ci` 下装不上，Tailwind 4 一到构建就报
> `Cannot find module '../lightningcss.linux-x64-gnu.node'`。CI 里那条
> `npm install lightningcss-linux-x64-gnu@1.32.0 --no-save` 就是治这个的，
> 本地遇到同样报错时补一次即可。

---

## 为什么订单模块是 iframe，而不是重写成 React

订单页是 2300 多行、靠全局函数和内联 `onclick` 驱动的成熟代码。它的每一条
行为都是踩过坑之后写定的 —— 编辑按 id 而不是数组下标保存、图表不吃自己那一维
的筛选、日期一律走 `parseYmd()` 避开 UTC 差一天、配色过出色盲校验。

重写只会用一批新 bug 换掉已经验证过的逻辑，而这次的要求是**行为完全一致**。
所以订单模块逐字平移（与原仓库逐字节相同，只有一处必要修复，见下），
由 `apps/web/src/pages/Orders.tsx` 用 iframe 承载，路径跟着构建前缀走：

```
/dashboard/orders/index.html
```

iframe 占满头部栏以外的整屏，滚动只发生在订单页内部 —— 它的表头吸顶和
`.table-wrap` 的 `max-height:calc(100vh - 200px)` 本来就是按「整页只有一个
滚动容器」设计的，viewport 即 iframe 高度，这些规则原样成立。

### 平移时唯一改动的代码

`public/orders/app.js` 的 `sha256b64()`：原来直接用 `crypto.subtle`，
而它**只在安全上下文（HTTPS / localhost）里存在**。工作台部署在
`http://47.252.19.224/`，那种环境下 `crypto.subtle` 是 `undefined`，
订单登录会直接抛错、密码永远进不去。现在补了一份纯 JS SHA-256 做回落，
两条路径的结果逐字节一致，由 `test/orders-static.test.ts` 拿 Node crypto
对拍校验（含 0 / 55 / 56 / 64 / 1000 字节这些边界分组）。

---

## 部署

### 前端 → ECS `/dashboard/`

`deploy-web.yml`：跑测试门禁 → `vite build` → 打包上传 →
解到 `/var/www/xhs-dashboard.new` → 换名（失败保留 `.old` 可回滚）→
`curl` 验证 → 失败自动开 issue。

订单模块的静态文件在 `public/orders/` 下，随 `dist` 一起走，**不需要单独部署**。

### 后端 → ECS `broadband-api`

`deploy-server.yml` 只上传 `src/xhs-writer.js` 和 `ecosystem.config.js`，
不上传 `src/index.js` —— 线上入口文件以服务器现状为准，它同时挂着别的模块。
PM2 零停机 reload。

### nginx（一次性人工操作）

仓库里不会自动改 nginx。把 `deploy/nginx/xhs-dashboard.conf` 里那段
`location /dashboard/` 粘进现有站点的 server 块，然后
`sudo nginx -t && sudo systemctl reload nginx`。

**`try_files` 的顺序不能反**：订单页是真文件，必须先按文件命中；
如果被 SPA 回退兜成 `index.html`，就会 iframe 套一层外壳，无限递归。

### 部署后自检

```
http://47.252.19.224/dashboard/                    # 工作台外壳
http://47.252.19.224/dashboard/orders/index.html   # 必须 200，否则订单页白屏
http://47.252.19.224/api/xhs/health                # 文案服务
```

`health-check.yml` 每 10 分钟探这四件事（含上面三条 + landing），
异常时开 `health-alert` issue，恢复后自动关闭。
订单页单独探一条是因为：外壳 200 不代表它在 —— 漏拷 `public/orders`
或前缀不匹配时，外壳照常打开，只有点进「销售订单」才看到空白。

---

## 需要配置的密钥

GitHub → Settings → Secrets and variables → Actions：

| Secret | 用途 |
|---|---|
| `ECS_HOST` / `ECS_USER` / `ECS_SSH_KEY` | 前后端部署 |

后端运行时环境变量见 `apps/server/.env.example`（`API_TOKEN`、MySQL、
`XHS_AI_*`、`XHS_VISION_*`、`XHS_UPLOAD_*`）。CD 从不上传 `.env`，
所以线上生效值看 `GET /api/xhs/health`，要改型号走
`apps/server/ecosystem.config.js` 的 `env`（PM2 注入会压过 `.env`）。

---

## 销售订单：数据库配置（不做这步等于没设防）

订单页是纯静态的，源码任何人都看得到。**只有页面密码挡不住人** ——
懂技术的人可以跳过页面，直接拿源码里的 publishable key 去读写数据库。
真正的防线在数据库那一侧，需要在 Supabase 后台做两件事，
做完之前页面顶部会一直显示橙色提醒：

1. **Authentication → Users → Add user**：
   Email `team@sales-order.local`，密码与页面登录密码一致，
   **必须勾 Auto Confirm User**。
2. **SQL Editor** 里执行 [`supabase/security.sql`](supabase/security.sql)
   全文（可重复执行，不动已有数据）。

验证：无痕窗口打开
`https://<项目>.supabase.co/rest/v1/orders?select=*&apikey=<publishable key>`，
配置成功应返回空数组或 401，而不是订单数据。

### 改密码

密码存在两处，必须同时改：

```bash
node tools/hash-password.js 新密码
```

1. 输出的 `PASSWORD_HASH` 替换 `apps/web/public/orders/app.js` 里的同名常量；
2. Supabase → Users 把 `team@sales-order.local` 的密码改成同一个。

Supabase 要求至少 6 位，建议用长密码 —— 源码里只有哈希，但 6 位纯数字
程序很快能猜完。

---

## 目录结构

```
XHS_Dashboard/
├── apps/
│   ├── web/                       # 工作台前端（React 19 + Tailwind 4 + Vite 8，base=/dashboard/）
│   │   ├── src/
│   │   │   ├── App.tsx            # 外壳：一条导航 + 订单页的 flush 布局
│   │   │   ├── pages/
│   │   │   │   ├── Dashboard.tsx  # 首页：模块入口 + 文案服务连通性
│   │   │   │   ├── Writer.tsx     # ← XHS-writer
│   │   │   │   ├── Library.tsx    # ← XHS-writer
│   │   │   │   └── Orders.tsx     # 订单模块宿主（iframe）
│   │   │   ├── lib/               # api / templates / image / theme / similarity / insights
│   │   │   └── index.css          # Design System（双主题 tokens，组件禁写裸色值）
│   │   ├── public/orders/         # ← Sales-order 整站（index.html/app.css/app.js/sw.js/manifest/icons）
│   │   └── test/                  # 纯函数单测 + 平移完整性检查
│   └── server/                    # ← XHS-writer 后端（Express 5 + MySQL）
├── landing/                       # SEO 落地页（CTA 已指向 /dashboard/）
├── supabase/security.sql          # 订单库 RLS 策略
├── tools/hash-password.js         # 生成订单页密码哈希
├── deploy/nginx/                  # nginx 片段（需人工应用一次）
└── .github/workflows/             # deploy-web / deploy-server / test / health-check
```

---

## 改代码前值得知道的几件事

- **配色走 token**。CSS 变量在 `apps/web/src/index.css` 的 `:root` / `.dark`，
  组件里禁写裸色值。主色 `var(--primary)` = `#17306e`。
- **订单模块的样式与外壳样式互不干涉**，因为它在 iframe 里是独立文档 ——
  那套 CSS 全是 `.btn`、`.chip`、`.modal` 这类通用类名，同页共存必撞。
- **`/orders` 路由下不要挂 `TokenGate`**。外壳启动时会同步一次云端模板，
  线上后端开了鉴权就回 401，令牌弹窗会盖在订单登录页上面 —— 两个密码框
  长得一模一样，点确定必然失败。`App.tsx` 里用 `flush` 分流了。
- **工作台首页的状态灯看 `reachable`，不看能力位**。`fetchCapabilities()`
  从不抛错，连不上时返回全 `false` 的回落值；只看字段会显示一排「未开启」，
  把人引向「去配服务器」，而真实原因是后端没起来。
- **日期一律按本地时区解析**（订单模块）。`new Date('2026-09-01')` 会被当成
  UTC，东八区显示差一天；用 `parseYmd()` / `ymd()`。
- **改订单页配色要跑色盲校验**。运营商三色原来在色盲模拟下绿↔黄 ΔE 只有 4.2，
  实际分不开，现在这套是校验过的。
- **提交格式**：`feat:` / `fix:` / `refactor:` / `docs:`，中文描述。
  变更走 PR 合 `main`，由 Actions 部署，不要 SSH 直连服务器改代码。

---

## 上游项目

- 文案仿写：https://github.com/z1992j/XHS-writer （线上 `http://47.252.19.224/writer/`）
- 销售订单：https://github.com/z1992j/Sales-order （线上 `https://z1992j.github.io/Sales-order/`）

两个上游仓库保持原样运行，本仓库是它们的合并版；后续改动以本仓库为准。

## License

仅供学习交流使用。
