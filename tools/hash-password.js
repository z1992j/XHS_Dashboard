#!/usr/bin/env node
/*
 * 生成页面密码哈希（工作台 · 销售订单模块）。
 *
 *   node tools/hash-password.js 新密码
 *
 * 输出的那一行直接替换 apps/web/src/orders/config.ts 里的 PASSWORD_HASH 默认值，
 * 或者写进 apps/web/.env.local 的 VITE_ORDER_PASSWORD_HASH（后者优先，源码不用改）。
 *
 * 然后到 Supabase → Authentication → Users，把 AUTH_EMAIL 那个账号的密码改成
 * 同一个明文 —— 页面闸门校的是哈希，换 token 用的是明文，两边必须对得上。
 *
 * 盐改了要一起改：SALT 必须与 config.ts 的 PASSWORD_SALT 一致，否则老密码全废。
 */
const crypto = require('crypto');

const SALT = process.env.VITE_ORDER_PASSWORD_SALT || 'sales-order-auth-v1';
const password = process.argv[2];

if (!password) {
  console.error('用法: node tools/hash-password.js <新密码>');
  process.exit(1);
}
// Supabase GoTrue 的硬要求，短于 6 位连 token 都换不到。
if (password.length < 6) {
  console.error('密码至少 6 位（Supabase 的最低要求）。');
  process.exit(1);
}

const hash = crypto.createHash('sha256').update(SALT + password, 'utf8').digest('base64');

console.log('\n// apps/web/src/orders/config.ts');
console.log(`export const PASSWORD_HASH = '${hash}';`);
console.log('\n// 或 apps/web/.env.local（不必改源码）');
console.log(`VITE_ORDER_PASSWORD_HASH=${hash}`);
console.log('\n别忘了把 Supabase 账号的密码同步改成同一个明文。\n');
