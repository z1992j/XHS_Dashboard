# CLAUDE.md — 小红书运营工作台 Agent 工作规范

## 沟通规范

- 与用户交流、任务总结、PR 描述等所有输出内容一律使用中文（代码、变量名、commit 格式前缀除外）。

## 部署规则（硬约束）

1. **禁止 SSH 直连 ECS 修改代码** — 所有变更必须 commit + push，由 GitHub Actions 自动部署
2. **禁止在代码中硬编码密钥** — .env / API_KEY / SSH_KEY / DB_PASSWORD 不入 git
3. **分支策略**: dev 分支开发 → PR merge main → 自动部署
4. **提交格式**: `feat: xxx` / `fix: xxx` / `docs: xxx` / `refactor: xxx`
5. **nginx 不由 CD 改动** — 新增 location 需要人工在服务器上应用一次
   （见 `deploy/nginx/xhs-dashboard.conf`）

## 项目结构

- `apps/web/` — 前端 (React 19 + Tailwind CSS 4 + Vite 8)，`base: '/dashboard/'`
- `apps/web/public/orders/` — 销售订单模块（原 Sales-order 静态站，逐字平移）
- `apps/server/` — 后端 (Express 5)：入口 `src/index.js`，路由模块 `src/xhs-writer.js`，建表 SQL `db/schema.sql`，迁移 `db/migrations/`
- `landing/` — SEO 落地页 (纯 HTML)，CTA 指向 `/dashboard/`
- `supabase/security.sql`、`tools/hash-password.js` — 订单模块的数据库策略与密码哈希工具
- `.github/workflows/` — CI/CD (deploy-web, deploy-server, test, health-check)

## 三个模块的边界

| 路由 | 来源 | 数据源 |
|---|---|---|
| `#/writer` `#/library` | 原 XHS-writer | 本仓库后端 + MySQL `broadband` |
| `#/orders` → `/dashboard/orders/` | 原 Sales-order | Supabase（独立，与上面无关） |

**不要为了「统一」去合并两边数据源或鉴权**。它们是两个互不相干的业务，
共用的是导航外壳，不是数据库。

## 前端开发

```bash
cd apps/web && npm install && npx vite                 # 开发（默认打本地后端）
cd apps/web && VITE_API_PROXY_TARGET=http://47.252.19.224 npx vite   # 直接打线上 API
cd apps/web && npx vite build                          # 构建验证
```

### Design System
- CSS 变量定义在 `src/index.css`，不要内联硬编码颜色
- 主色: `var(--primary)` = `#17306e`
- 组件类: white-card, btn-primary, btn-outlined, tag-chip, input-glow
- 移动端: bottom-sheet-overlay/backdrop/content
- 外壳布局：`.app-main` 居中限宽；`#/orders` 走 `.app-main-flush` +
  `.app-shell-flush`（占满整屏，滚动只发生在 iframe 内部）

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

## 销售订单模块（public/orders/）

改这里之前先读 `apps/web/public/orders/app.js` 顶部的注释，那几条都是踩过坑写下的：

- 它是普通脚本，不是 ES module —— 页面里的内联 `onclick` 依赖全局函数
- 日期一律走 `parseYmd()` / `ymd()`，`new Date('2026-09-01')` 会被当成 UTC
- 编辑按 id 保存，不按数组下标
- 拼进 HTML 属性要用 `escAttr()`，`esc()` 不转义引号
- 合计行 colspan 必须跟当前可见列数一致
- 改配色要跑色盲校验
- **`sha256b64()` 有纯 JS 回落**：`crypto.subtle` 只在安全上下文存在，
  工作台走 `http://IP/` 部署时它是 undefined，没有回落订单就登不进去。
  改动必须保持两条路径逐字节一致（`test/orders-static.test.ts` 会拿 Node crypto 对拍）
- 发布后 HTML 与 JS 必须同版本，Service Worker 用「网络优先 + 协商校验」，不要改回缓存优先

## 测试

```bash
cd apps/web    && npm test        # 96 项（含订单模块平移完整性检查）
cd apps/web    && npx tsc --noEmit
cd apps/server && npm test        # 173 项
```

`test/orders-static.test.ts` 是平移的门禁：文件齐不齐、路径是不是相对的、
app.js 能不能解析、SHA-256 回落对不对。动订单模块前先让它绿。

## 数据库

MySQL 8.0 Docker 容器，database: broadband
- `xhs_materials` — 素材表
- `xhs_rewrite_history` — 仿写历史表
- `xhs_templates` / `xhs_style_profile` — 见 db/migrations/

订单模块的表在 Supabase（`orders` / `order_logs`），RLS 策略见 `supabase/security.sql`。
