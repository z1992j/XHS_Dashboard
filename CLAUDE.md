# CLAUDE.md — 红薯运营工作台 Agent 工作规范

## 沟通规范

- 与用户交流、任务总结、PR 描述等所有输出内容一律使用中文（代码、变量名、commit 格式前缀除外）。

## 部署规则（硬约束）

1. **禁止 SSH 直连 ECS 修改代码** — 所有变更必须 commit + push，由 GitHub Actions 自动部署
2. **禁止在代码中硬编码密钥** — .env / API_KEY / SSH_KEY / DB_PASSWORD 不入 git
   （订单模块的 Supabase publishable key 与密码哈希是随静态站公开分发过的
   「发布用」值，属于例外，但 service_role key 和数据库密码永远不能进前端）
3. **分支策略**: 功能分支开发 → PR merge main → 自动部署
4. **提交格式**: `feat: xxx` / `fix: xxx` / `docs: xxx` / `refactor: xxx`
5. **nginx 不由 CD 改动** — `location /dashboard/` 需要人工在服务器上应用一次
   （见 `deploy/nginx/xhs-dashboard.conf`）
6. **验证只看内容，不看状态码** — 线上 nginx 是 catch-all，任意路径（实测
   `/nope-xyz`）都返回 200 + 旧 landing 页；`try_files` 又会把缺失的 .js/.css
   兜成 200 的 index.html。按状态码判成功是上一版「CI 全绿但从没上线」的直接原因。
   任何新增的探活都必须 grep 内容标记（入口页 `红薯运营工作台`、`sw.js`
   `xhs-workbench-`、入口 JS 不得是 HTML）。
7. **deploy-web / deploy-server 需要仓库 secrets** `ECS_HOST`/`ECS_USER`/`ECS_SSH_KEY`。
   当前仓库里是空的 —— 推上去只算「代码入库 + 跑 CI」，不等于上线，别对人说已部署。

## 项目结构

- `apps/web/` — 前端 (React 19 + Tailwind CSS 4 + Vite 8)，`base: './'` + HashRouter，一份 dist 放任意静态路径
- `apps/web/src/orders/` — 销售订单模块（原生重写，纯函数 + store + `ui/` 组件）
- `apps/server/` — 后端 (Express 5)：入口 `src/index.js`，路由模块 `src/xhs-writer.js`，建表 SQL `db/schema.sql`，迁移 `db/migrations/`
- `landing/` — SEO 落地页 (纯 HTML)，CTA 指向 `/dashboard/`
- `supabase/security.sql`、`tools/hash-password.js` — 订单库 RLS 策略与密码哈希工具
- `.github/workflows/` — CI/CD (deploy-web, deploy-server, test, health-check)

## 三个模块的边界

| 路由 | 来源 | 数据源 |
|---|---|---|
| `#/writer` `#/library` | 原 XHS-writer | 本仓库后端 + MySQL `broadband` |
| `#/orders` | 原 Sales-order（已原生重写，不再是 iframe） | Supabase（独立，与上面无关） |

**不要为了「统一」去合并两边数据源或鉴权**。它们是两个互不相干的业务，
共用的是导航外壳，不是数据库。

## 前端开发

```bash
cd apps/web && npm install && npx vite                 # 开发（默认打本地后端）
cd apps/web && VITE_API_PROXY_TARGET=http://47.252.19.224 npx vite   # 直接打线上 API
cd apps/web && npm run typecheck && npx vite build     # 构建验证
```

### Design System
- CSS 变量定义在 `src/index.css`，不要内联硬编码颜色
- 主色: `var(--primary)` = `#17306e`
- 组件类: white-card, btn-primary, btn-outlined, tag-chip, input-glow
- 移动端: bottom-sheet-overlay/backdrop/content
- 外壳布局：`.app-main` 居中限宽；`#/orders` 走 `.app-main-flush`（去掉 max-width），
  订单页自己就是一个完整文档级布局，滚动按常规 body 走
- 订单模块样式在 `src/orders/orders.css`，全部类名带 `orders-` 前缀。
  **新增类必须继续加前缀**：旧版那套 `.btn`/`.chip`/`.modal` 通用名现在和外层
  Tailwind 同处一个文档，不加前缀必撞色。

## 后端开发

- 入口: `apps/server/src/index.js`（express app / mysql pool / trust proxy / 优雅退出）
- 路由: `apps/server/src/xhs-writer.js`（setupXhsWriter(app, pool) 挂载全部 /api/xhs/*）
- CONFIG 对象集中管理常量，不要散落魔法数字
- 结构化 JSON 日志: `log(level, msg, meta)`
- 所有 fs 操作用异步 `fs.promises`
- 错误响应统一 `{ error: { message } }` 结构，详细错误只写日志
- 注意：生产服务器为共享的 broadband-api，其入口文件以服务器现状为准（CD 不上传 src/index.js）

## API 鉴权

所有 `/api/xhs/*` 路由(除 /health)需要 Bearer Token，Token 通过环境变量 `API_TOKEN` 配置。

`TokenGate` 只在用得到文案 API 的路由上挂载。`#/orders` 不挂 —— 外壳启动时
会同步一次云端模板，线上后端开了鉴权就回 401，令牌弹窗会盖在订单登录页上面，
两个密码框长得一模一样，点确定必然失败。

## 销售订单模块（src/orders/）

这是原生重写，不是平移，所以**行为必须继续与 `z1992j/Sales-order` 的 `app.js` 一致**。
改之前先读对应模块的注释和 `test/`，几条最容易踩的：

- 字段名沿用旧版：`applyDate / paybackDate / installFee / packageFee /
  commissionRate(0–1 小数) / idCard / salesPerson`；数据库列是 snake_case。
  没有 bandwidth、monthlyFee、expiryDate 这些字段（到期是算出来的）。
- 日期一律 `date.ts` 的本地时区实现。`new Date('2026-09-01')` 会被当 UTC、
  `toISOString()` 在东八区差一天 —— 旧版全靠本地字符串，别「顺手现代化」。
- 编辑/删除按订单 **id**，不是数组下标或视图位置。
- 筛选有「自维例外」：点组合卡时省份/城市/运营商/套餐各自不参与本维筛选
  （`selectOrders(orders, filters, except)`），月份例外还包括 `2026` 这种整年前缀。
- 卡片/图表/表格共用同一份筛选结果；趋势图和续约按自然月口径（不吃月份筛选），
  否则筛到 8 月时「本月订单」会变 0。
- 读列表带 `Prefer: count=exact`，Content-Range 拿不到总数而条数已到
  `COUNT_SUSPICIOUS_AT`(1000) 时必须把「无法确认是否取全」说出来。
- 离线回退 localStorage 缓存并显示缓存时间；该状态下写操作会失败，界面要讲清。
- **`sha256.ts` 的 K 表不能手抄**。现值由整数立方根精确推导并经 Node crypto
  差分验证（`''`/`abc`/55/56/63/64/65 字节/CJK/盐+密码）。手抄错过一次：
  `K[5]` 正确是 `0x59f111f1`，误写成 `0x59f11f18`，症状是哈希对不上、密码永远登不进。
- **`crypto.subtle` 只在安全上下文存在**，工作台走 `http://47.252.19.224/` 时它是
  undefined，纯 JS 回落必须保留，两条路径逐字节一致。
- 发布后 HTML 与 JS 必须同版本：`public/sw.js` 用「网络优先 + no-cache 协商校验」，
  不要改回缓存优先；`.supabase.co` 与 `/api/` 一律不缓存。

## 测试

```bash
cd apps/web    && npm run typecheck && npm test
cd apps/server && npm test
```

`tsc --noEmit` 是 strict 门禁（订单模块的类型面就是 UI 与逻辑的接缝，放开等于
把契约写坏而没人报警）。新增纯函数模块时配单测，尤其 `filter`/`stats`/`csv`/
`smartInput` —— 它们承载上面那些语义，UI 测试覆盖不到。

## 数据库

MySQL 8.0 Docker 容器，database: broadband
- `xhs_materials` — 素材表
- `xhs_rewrite_history` — 仿写历史表
- `xhs_templates` / `xhs_style_profile` — 见 db/migrations/

订单模块的表在 Supabase（`orders` / `order_logs`），RLS 策略见 `supabase/security.sql`。
