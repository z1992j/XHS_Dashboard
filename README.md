# 🍠 红薯运营工作台

> 文案仿写 · 素材库 · 销售订单，三个模块装在一个 React 应用里：一条导航、一次登录、一个部署产物。

<p align="center">
  <img src="apps/web/public/logo.svg" alt="红薯运营工作台" width="110" height="110" />
</p>

<p align="center">
  <a href="https://github.com/z1992j/XHS_Dashboard/actions/workflows/test.yml"><img src="https://github.com/z1992j/XHS_Dashboard/actions/workflows/test.yml/badge.svg" alt="CI Tests" /></a>
  <a href="https://github.com/z1992j/XHS_Dashboard/actions/workflows/deploy-web.yml"><img src="https://github.com/z1992j/XHS_Dashboard/actions/workflows/deploy-web.yml/badge.svg" alt="Deploy Frontend" /></a>
  <a href="https://github.com/z1992j/XHS_Dashboard/actions/workflows/health-check.yml"><img src="https://github.com/z1992j/XHS_Dashboard/actions/workflows/health-check.yml/badge.svg" alt="Health Check" /></a>
</p>

---

## 这是什么

| 模块 | 路由 | 实现 | 数据源 |
|---|---|---|---|
| 文案仿写 | `#/writer` | React 页面（来自 XHS-writer） | 本仓库 Express + MySQL `broadband` |
| 素材库 | `#/library` | React 页面（来自 XHS-writer） | 同上 |
| 销售订单 | `#/orders` | **原生 React 重写**（语义逐条对齐 Sales-order） | Supabase（PostgREST + GoTrue） |
| 工作台首页 | `#/` | 模块入口 + 文案服务连通性 | — |

两个数据源**没有合并，也不打算合并**：仿写/素材走自己的 MySQL 后端，订单直连
Supabase。共用的是导航外壳和一个构建产物，不是数据库。

> 订单模块曾经是 iframe 内嵌的静态页。那一版从来没有真的上线过 —— 线上 nginx
> 有 catch-all，任何路径都返回 200 的旧落地页，按状态码判成功的部署一路「全绿」。
> 现在改成原生页面，`/dashboard/orders/` 这条子路径、iframe 宿主和对应的
> nginx 约定一起删掉了。

---

## 本地开发

```bash
# 前端
cd apps/web && npm install && npx vite            # http://localhost:5173/

# 后端（可选：不想起 MySQL 就把 vite 代理打到线上）
cd apps/server && npm install && node src/index.js
```

```bash
cd apps/web && VITE_API_PROXY_TARGET=http://47.252.19.224 npx vite
```

线上后端开了鉴权，浏览器首次访问会弹令牌框，填 `API_TOKEN` 的值即可。

订单模块的默认配置（Supabase 地址、publishable key、密码哈希）写死在
`apps/web/src/orders/config.ts` 里，都是随静态站公开分发过的「发布用」值，
换项目时用 `apps/web/.env.local` 覆盖，键名见 `.env.example`。

### 测试与构建

```bash
cd apps/web    && npm run typecheck && npm test && npx vite build
cd apps/server && npm test
```

> `lightningcss` 的可选原生依赖在 `npm ci` 下装不上，Tailwind 4 一到构建就报
> `Cannot find module '../lightningcss.linux-x64-gnu.node'`。CI 里那条
> `npm install lightningcss-linux-x64-gnu@1.32.0 --no-save` 就是治这个的，
> 本地遇到同样报错时补一次即可。

---

## 订单模块的实现结构

`apps/web/src/orders/`，纯函数与 I/O 分得很开，每条都配了单测：

| 文件 | 职责 |
|---|---|
| `types.ts` | `Order` 字段与旧版 `toRow/fromRow` 逐一对齐（数据库列名是 snake_case） |
| `config.ts` | Supabase / 密码闸门 / localStorage 键名，可被 `VITE_*` 覆盖 |
| `sha256.ts` | 页面密码闸门：WebCrypto + 纯 JS 回落，两条路径逐字节一致 |
| `date.ts` | 本地时区日期工具，含 `addMonthsClamped` |
| `client.ts` | PostgREST 读写 + GoTrue 换 token，带 `Prefer: count=exact` 截断守卫 |
| `filter.ts` | 筛选/排序，含「点某一维时该维自身不参与筛选」的例外规则 |
| `stats.ts` | 统计卡片、组合/城市/运营商分组、到期续约候选 |
| `format.ts` | 金额、运营商徽章等展示层格式化 |
| `csv.ts` | 导出 CSV、解析 CSV、构建导入计划（按姓名+手机号去重） |
| `smartInput.ts` | 粘贴一段文字识别成订单，含校验与城市/省份兜底提取 |
| `store.ts` | `useOrders()`：把上面这些接起来的唯一有状态层 |
| `orders.css` | 独立一套 `.orders-*` 类名，变量取自 `index.css` 的 `:root` |
| `ui/` | 工具栏、卡片、趋势图、表格、表单、弹窗等纯展示组件 |

行为对齐清单（旧版踩过坑写死的，改之前先看测试）：编辑按订单 id 而不是数组下标；
月份筛选走 `applyDate` 前缀且允许 `2026` 整年；回款胶囊 paid/unpaid/over30/over60；
账龄中位数用「回款天数」而不是平均；续约窗口 ±30 天且按手机号最新一单压制重复提醒；
离线时回退 localStorage 缓存并明确标出缓存时间；读不到总数而条数已到 1000 量级时
标记「无法确认是否取全」；日期一律本地时区，不用 `toISOString()`。

---

## 部署

### 需要配置的密钥

GitHub → Settings → Secrets and variables → Actions：

| Secret | 用途 | 现状 |
|---|---|---|
| `ECS_HOST` / `ECS_USER` / `ECS_SSH_KEY` | 前后端部署 | **未配置**，没配则 `deploy-web/deploy-server` 必然失败 |

后端运行时环境变量见 `apps/server/.env.example`。CD 从不上传 `.env`，线上生效值看
`GET /api/xhs/health`；要改参数走 `apps/server/ecosystem.config.js` 的 `env`
（PM2 注入会压过 `.env`）。

### 前端 → ECS `/dashboard/`

`deploy-web.yml`：测试门禁 → `vite build`（`base: './'`，产物不绑路径）→ 打包上传 →
解到 `/var/www/xhs-dashboard.new` → 换名（保留 `.old` 可回滚）→ **按内容验证** →
失败自动回滚并开 issue。

验证为什么不看状态码：线上 nginx 是 catch-all，`/nope-xyz` 也返回 200 和旧落地页。
所以部署最后一步要求入口页里出现「红薯运营工作台」、`sw.js` 里出现
`xhs-workbench-`、入口页引用的那个 hashed JS 取回来**不是** HTML
（`try_files` 会把缺失文件兜成 200 的 index.html，这是白屏却全绿的第二个来源）。
`test.yml` 在构建层面卡同样的前提：`dist/index.html` 必须是相对路径引用，
PWA 资产必须进 `dist`。

### 后端 → ECS `broadband-api`

`deploy-server.yml` 只上传 `src/xhs-writer.js` 和 `ecosystem.config.js`，
不上传 `src/index.js` —— 线上入口文件以服务器现状为准，它同时挂着别的模块。
PM2 零停机 reload。

### nginx（一次性人工操作）

仓库不会自动改 nginx。把 `deploy/nginx/xhs-dashboard.conf` 里那段
`location /dashboard/` 粘进现有站点的 server 块，然后
`sudo nginx -t && sudo systemctl reload nginx`。
配好后按该文件第 4 步的内容标记验证，不要 `curl -I` 看 200。

### 上线后自检

```bash
curl -s http://47.252.19.224/dashboard/ | grep -c 红薯运营工作台   # 必须是 1
curl -s http://47.252.19.224/dashboard/sw.js | grep -c xhs-workbench-
curl -s http://47.252.19.224/api/xhs/health
```

`health-check.yml` 每 10 分钟探这四件事（工作台入口内容 + 入口 JS + sw.js + API +
landing），异常时开 `health-alert` issue（同类告警合并到一条），恢复后自动关闭。

---

## 销售订单：数据库配置（不做这步等于没设防）

订单模块的源码任何人都看得到，**只有页面密码挡不住人** —— 懂技术的人可以跳过
页面，直接拿源码里的 publishable key 去读写数据库。真正的防线在数据库那一侧，
需要在 Supabase 后台做两件事，做完之前页面顶部会一直显示橙色提醒：

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

1. 输出的 `PASSWORD_HASH` 替换 `apps/web/src/orders/config.ts` 里的同名常量
   （或写进 `apps/web/.env.local` 的 `VITE_ORDER_PASSWORD_HASH`，不用改源码）；
2. Supabase → Users 把 `team@sales-order.local` 的密码改成同一个明文。

Supabase 要求至少 6 位，建议用长密码 —— 源码里只有哈希，但 6 位纯数字程序很快能猜完。

---

## 目录结构

```
XHS_Dashboard/
├── apps/
│   ├── web/                       # 工作台前端（React 19 + Tailwind 4 + Vite 8，base='./'）
│   │   ├── src/
│   │   │   ├── App.tsx            # 外壳：一条导航；订单页走 flush 布局且不挂 TokenGate
│   │   │   ├── pages/             # Dashboard / Writer / Library / Orders
│   │   │   ├── lib/               # api / templates / image / theme / similarity / insights
│   │   │   ├── orders/            # 订单模块（见上表）
│   │   │   └── index.css          # Design System（双主题 tokens，组件禁写裸色值）
│   │   ├── public/                # sw.js / manifest.webmanifest / 图标（PWA 资产）
│   │   └── test/                  # 纯函数单测 + 订单组件测试
│   └── server/                    # ← XHS-writer 后端（Express 5 + MySQL）
├── landing/                       # SEO 落地页（CTA 指向 /dashboard/）
├── supabase/security.sql          # 订单库 RLS 策略
├── tools/hash-password.js         # 生成订单页密码哈希
├── deploy/nginx/                  # nginx 片段（需人工应用一次）
└── .github/workflows/             # deploy-web / deploy-server / test / health-check
```

---

## 改代码前值得知道的几件事

- **配色走 token**。CSS 变量在 `apps/web/src/index.css` 的 `:root` / `.dark`，
  组件里禁写裸色值。主色 `var(--primary)` = `#17306e`。
- **订单模块的样式必须继续用 `.orders-*` 前缀**。旧版那套 `.btn`、`.chip`、`.modal`
  通用类名进了同一个文档就会和外壳的 Tailwind 样式互撞，这是原生化的第一个坑。
- **`/orders` 路由下不要挂 `TokenGate`**。外壳启动时会同步一次云端模板，线上后端
  开了鉴权就回 401，令牌弹窗会盖在订单登录页上面 —— 两个密码框长得一模一样，
  点确定必然失败。`App.tsx` 里用 `flush` 分流了。
- **`base` 保持 `'./'`**。绝对 base 会把这份 dist 绑死在 `/dashboard/`，换路径时
  表现为白屏而不是报错；`test.yml` 在构建产物层面卡这条。
- **SHA-256 的两条路径要逐字节一致，且 K 表不能手抄**。`crypto.subtle` 只在安全
  上下文存在，工作台走 `http://IP/` 时它是 undefined，所以必须有纯 JS 回落。
  现表的常量是用整数立方根精确推导 + Node crypto 差分验证得到的（历史上手抄错过
  `K[5]`，写成 `0x59f11f18`，正确的是 `0x59f111f1`，表现为哈希对不上、密码永远登不进）。
- **工作台首页的状态灯看 `reachable`，不看能力位**。`fetchCapabilities()` 从不抛错，
  连不上时返回全 `false` 的回落值；只看字段会显示一排「未开启」，把人引向
  「去配服务器」，而真实原因是后端没起来。
- **改订单配色要跑色盲校验**。运营商三色原来在色盲模拟下绿↔黄 ΔE 只有 4.2，
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
