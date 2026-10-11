/// <reference types="vite/client" />

/**
 * 订单模块的配置。
 *
 * 默认值沿用 Sales-order 旧版 app.js 顶部的常量（那些值本来就随静态页公开
 * 分发，属于「发布用」的 anon key，不是机密）。这里做成可被 Vite 环境变量
 * 覆盖，是为了换 Supabase 项目时不必改源码。
 *
 * 真正的机密（service_role key、数据库密码）永远不会出现在前端。
 */

const env = import.meta.env as unknown as Record<string, string | undefined>;

export const SUPABASE_URL =
  env.VITE_SUPABASE_URL || 'https://cgieubqhafwwprwzerty.supabase.co';
export const SUPABASE_KEY =
  env.VITE_SUPABASE_ANON_KEY || 'sb_publishable_EDGkPqT_UPcwDD_n3ozuHA_mw_EL0hY';

export const REST_ORDERS = `${SUPABASE_URL}/rest/v1/orders`;
export const REST_LOGS = `${SUPABASE_URL}/rest/v1/order_logs`;
export const AUTH_TOKEN = `${SUPABASE_URL}/auth/v1/token`;

/** 页面密码闸门：base64(SHA-256(盐 + 明文))，源码里没有明文。 */
export const PASSWORD_SALT = env.VITE_ORDER_PASSWORD_SALT || 'sales-order-auth-v1';
export const PASSWORD_HASH =
  env.VITE_ORDER_PASSWORD_HASH || 'x5tI6XfoxrZBKGPbvWaN7FGK2gG8oc6/5d/AdTjd648=';

/** Supabase 侧的共享登录账号，密码与页面密码同一个明文。 */
export const AUTH_EMAIL = env.VITE_ORDER_AUTH_EMAIL || 'team@sales-order.local';

/**
 * 单人使用：新建订单一律记在这个名下。
 * 「我的 / 其他归属」两个视图按它切分；字段仍写库，历史数据与导出格式兼容。
 */
export const SALES_PERSON = env.VITE_ORDER_SALES_PERSON || '大卫';

export const SESSION_STORE_KEY = 'xhsWorkbench.orderSession';
export const DATA_CACHE_KEY = 'xhsWorkbench.orderData';
export const TREND_METRIC_KEY = 'xhsWorkbench.trendMetric';

/**
 * 接口单次返回的常见上限。读不到总数、而条数已经到这个量级时，
 * 无法证明数据取全了 —— 这种「查不了」也要在界面上说出来。
 */
export const COUNT_SUSPICIOUS_AT = 1000;

/** 续约提醒的前后窗口（天）：快到期的要联系，刚过期的还来得及挽回。 */
export const RENEW_WINDOW = 30;
export const RENEW_PREVIEW = 5;
