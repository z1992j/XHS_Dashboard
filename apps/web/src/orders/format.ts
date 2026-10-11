/**
 * 展示格式化工具。React 里字符串节点天然按纯文本渲染，这里只负责「数字
 * 长什么样」，不再承担旧版 esc() 的转义职责。
 */

/** 金额：'¥' + 千分位。null/undefined/NaN 一律按 0。 */
export function money(n: number | null | undefined): string {
  return '¥' + Number(n || 0).toLocaleString();
}

/** 0~1 的小数比例 -> 整数百分比字符串，如 0.5 -> '50%'。 */
export function ratePct(rate: number): string {
  return Math.round((Number(rate) || 0) * 100) + '%';
}

/** 运营商徽标类名：广电等未预置的运营商统一落电信色。 */
export function carrierBadge(c: string): string {
  if (c === '联通') return 'badge-unicom';
  if (c === '移动') return 'badge-mobile';
  return 'badge-telecom';
}

/**
 * HTML 转义，给极少数必须拼 HTML 字符串的场景（如 title 属性模板）备用。
 * React 渲染文本节点用不上它，但导出工具函数留一条安全的路。
 */
const ESC_MAP: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

export function escapeHtml(s: string | null | undefined): string {
  if (!s) return '';
  return String(s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);
}
