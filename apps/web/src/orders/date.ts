/**
 * 日期工具 —— 全部按本地时区。
 *
 * 为什么不用 toISOString()/new Date('YYYY-MM-DD')：
 * - toISOString() 输出 UTC，东八区晚上 8 点之后「今天」会变成明天；
 * - 形如 '2026-09-01' 的字符串交给 Date 解析按 UTC 处理，东八区会差一天。
 * 旧版 app.js 里就写着这条注释，这是踩过的坑，两条路都得挡住。
 */

const pad = (n: number) => String(n).padStart(2, '0');

/** 本地日期 -> 'YYYY-MM-DD'。 */
export function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayStr(): string {
  return ymd(new Date());
}

/** 'YYYY-MM-DD' -> 本地零点的 Date；格式不合返回 null。 */
export function parseYmd(str: string | null | undefined): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str || '');
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

/** 'YYYY-MM' -> 该月首日；不合返回 null。 */
export function parseYm(str: string | null | undefined): Date | null {
  const m = /^(\d{4})-(\d{2})$/.exec(str || '');
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, 1) : null;
}

const DAY_MS = 86400000;

/** 两个本地日期相差的天数（b - a），按整天算，不受时分影响。 */
export function diffDays(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

/** 今天零点，账龄/到期都以此为基准。 */
export function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * 加 n 个月，并把日夹紧到目标月的最后一天。
 * 直接 new Date(y, m+1, 31) 会溢出到 3 月初：1 月 31 日 + 1 月应是 2 月 28/29 日。
 */
export function addMonthsClamped(d: Date, n: number): Date {
  const y = d.getFullYear();
  const m = d.getMonth() + n;
  const lastDay = new Date(y, m + 1, 0).getDate();
  return new Date(y, m, Math.min(d.getDate(), lastDay));
}

/** 上一个自然月的 'YYYY-MM'。 */
export function lastMonthYm(ref: Date = new Date()): string {
  const d = new Date(ref.getFullYear(), ref.getMonth() - 1, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

/** 当前自然月的 'YYYY-MM'。 */
export function currentYm(ref: Date = new Date()): string {
  return `${ref.getFullYear()}-${pad(ref.getMonth() + 1)}`;
}

/** 本地时间戳展示，用于「最后更新」「缓存于」。 */
export function formatDateTime(ts: number | string): string {
  const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toLocaleString('zh-CN');
}
