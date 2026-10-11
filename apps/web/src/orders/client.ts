/**
 * Supabase 直连层：鉴权、REST 读写、缓存。
 * 语义照抄旧版 app.js 的 HEADERS/signInToDatabase/refreshDatabaseSession/
 * bootstrap/loadData/saveOrder/deleteOrder/reinsertOrder（约 45~430 行、
 * 1336~1453 行）。真正机密（service_role）不会进前端，这里带的是随静态页
 * 公开的 publishable key。
 */
import {
  SUPABASE_KEY, REST_ORDERS, REST_LOGS, AUTH_TOKEN,
  SESSION_STORE_KEY, DATA_CACHE_KEY, COUNT_SUSPICIOUS_AT, AUTH_EMAIL,
  PASSWORD_SALT, PASSWORD_HASH,
} from './config';
import { verifyPagePassword } from './sha256';
import type { Order, OrderLog, OrderRow, Session, LoadResult } from './types';

/** 每个请求都带的头。apikey 恒为 publishable key；无会话时回落到它。 */
export function authHeaders(session: Session | null): Record<string, string> {
  return {
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + ((session && session.token) || SUPABASE_KEY),
    'Content-Type': 'application/json',
  };
}

/** 把 Supabase 的英文报错翻译成可以照着做的处置办法（四类 + 默认）。 */
export function authErrorHint(msg: string): string {
  const m = (msg || '').toLowerCase();
  if (m.includes('email not confirmed') || m.includes('not confirmed')) {
    return '账号没有确认。到 Authentication → Users 找到该账号，点右侧 ⋯ → Confirm email；' +
           '或删除后重建，务必勾选 Auto Confirm User。';
  }
  if (m.includes('invalid login credentials')) {
    return '邮箱或密码对不上。确认账号邮箱是 ' + AUTH_EMAIL + '，密码是页面登录用的同一个。';
  }
  if (m.includes('email logins are disabled') || m.includes('email provider') || m.includes('signups not allowed')) {
    return '项目没有启用邮箱登录。到 Authentication → Providers → Email，打开 Enable Email provider。';
  }
  if (m.includes('email address') && m.includes('invalid')) {
    return 'Supabase 不接受这个邮箱域名。把 AUTH_EMAIL 换成常规域名（如 team@example.com），' +
           '并用同样的邮箱重建账号。';
  }
  return '到 Authentication → Users 确认账号 ' + AUTH_EMAIL + ' 已存在且已确认。';
}

/** 用密码向 Supabase 换取数据库 JWT；拿不到返回 { session: null, error }。 */
export async function signInToDatabase(password: string): Promise<{ session: Session | null; error: string }> {  try {
    const res = await fetch(AUTH_TOKEN + '?grant_type=password', {
      method: 'POST',
      headers: { 'apikey': SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: AUTH_EMAIL, password }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok || !d.access_token) {
      // 记下确切原因，否则失败时无从排查
      const error = d.error_description || d.msg || d.error ||
                    d.message || ('HTTP ' + res.status);
      return { session: null, error: typeof error === 'string' ? error : 'HTTP ' + res.status };
    }
    return {
      session: {
        token: d.access_token,
        refresh: d.refresh_token || '',
        // 提前 60 秒过期，给网络留余量，别把请求打进 401
        expiresAt: Date.now() + ((d.expires_in || 3600) - 60) * 1000,
      },
      error: '',
    };
  } catch (e) {
    return { session: null, error: '无法连接 Supabase：' + (e instanceof Error ? e.message : String(e)) };
  }
}

/* ---------------- 会话存取 ----------------
 * remember=true 存 localStorage（跨开关机），否则 sessionStorage（关标签即清）。
 * 存一侧前把另一侧清掉，否则会出现「退出后仍带着旧令牌」的怪状态。
 * 存的是 {ok, db} 包装结构：ok=false 表示上次登录没换到数据库令牌，
 * 属于残缺状态，restore 时要识别出来要求重新输密码。
 */

function readStoredSession(): { data: unknown; store: Storage } | null {
  for (const store of [localStorage, sessionStorage]) {
    try {
      const raw = store.getItem(SESSION_STORE_KEY);
      if (raw) return { data: JSON.parse(raw), store };
    } catch { /* 隐私模式或存储被禁用 */ }
  }
  return null;
}

function writeStoredSession(session: Session | null, remember: boolean): void {
  const store = remember ? localStorage : sessionStorage;
  const other = remember ? sessionStorage : localStorage;
  try { other.removeItem(SESSION_STORE_KEY); } catch { /* 忽略 */ }
  try { store.setItem(SESSION_STORE_KEY, JSON.stringify({ ok: session != null, db: session })); } catch { /* 配额满放弃 */ }
}

function clearStoredSession(): void {
  for (const store of [localStorage, sessionStorage]) {
    try { store.removeItem(SESSION_STORE_KEY); } catch { /* 忽略 */ }
  }
}

/** 残缺会话（缺令牌）要在 restore 时识别为「需要重新输密码」。 */
function asSession(v: unknown): Session | null {
  if (!v || typeof v !== 'object') return null;
  const s = v as Partial<Session>;
  return typeof s.token === 'string' && !!s.token && typeof s.expiresAt === 'number' ? (s as Session) : null;
}

// 内存里的当前会话：请求头从这取令牌；storage 只是它的持久化形态
let currentSession: Session | null = null;

/** 纯函数：用 refresh token 续期；失败返回 null（调用方清会话、重走密码）。 */
export async function refreshSession(s: Session): Promise<Session | null> {
  if (!s || !s.refresh) return null;
  try {
    const res = await fetch(AUTH_TOKEN + '?grant_type=refresh_token', {
      method: 'POST',
      headers: { 'apikey': SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: s.refresh }),
    });
    if (!res.ok) return null;
    const d = await res.json();
    if (!d.access_token) return null;
    return {
      token: d.access_token,
      refresh: d.refresh_token || s.refresh,
      expiresAt: Date.now() + ((d.expires_in || 3600) - 60) * 1000,
    };
  } catch {
    return null;
  }
}

/** 会话单例：登录态的读写都在这里，UI 不直接碰 localStorage。 */
export const orderSession = {
  /** 恢复会话。返回 null 表示没有会话 / 已失效 / 残缺（都需要重新输密码）。 */
  restore(): Session | null {
    currentSession = null;
    const stored = readStoredSession();
    if (!stored) return null;
    const d = stored.data as { ok?: boolean; db?: unknown } | null;
    if (!d || !d.ok) return null;
    const db = asSession(d.db);
    // 上次登录没换到数据库令牌（多半是当时账号还没配好）。缓存这个残缺
    // 状态没有意义，重新要一次密码，好再试一遍换取令牌。
    if (!db) return null;
    if (Date.now() >= db.expiresAt) return null;
    currentSession = db;
    return db;
  },
  hasStored(): boolean {
    return readStoredSession() !== null;
  },
  /**
   * 登录：页面闸门在前、换令牌在后，两步顺序照抄旧版 submitLogin。
   * 第一步只比对哈希、不发任何请求 —— 闸门与数据库账号是两件事，
   * 错密码时界面给「密码错误」而不是 GoTrue 的报错文案。
   */
  async login(pw: string, remember: boolean): Promise<{ ok: boolean; error: string }> {
    const password = pw.trim();
    if (!password) return { ok: false, error: '请输入密码' };
    try {
      if (!(await verifyPagePassword(password, PASSWORD_SALT, PASSWORD_HASH))) {
        return { ok: false, error: '密码错误' };
      }
      const { session, error } = await signInToDatabase(password);
      if (!session) return { ok: false, error };
      writeStoredSession(session, remember);
      currentSession = session;
      return { ok: true, error: '' };
    } catch (e) {
      return { ok: false, error: '登录失败：' + (e instanceof Error ? e.message : String(e)) };
    }
  },
  /**
   * 内存会话过期时续期。成功后把新会话写回它原来所在的 storage，
   * 否则下次打开页面拿到的还是旧令牌，又要重新输一遍密码。
   */
  async refresh(): Promise<Session | null> {
    const cur = currentSession;
    if (!cur) return null;
    const next = await refreshSession(cur);
    if (!next) return null;
    currentSession = next;
    const stored = readStoredSession();
    if (stored) writeStoredSession(next, stored.store === localStorage);
    return next;
  },
  logout(): void {
    clearStoredSession();
    currentSession = null;
  },
  /** 当前内存会话（可能为 null）。请求头与 bootstrap 判断都从这取。 */
  current(): Session | null {
    return currentSession;
  },
};

/* ---------------- 行映射 ----------------
 * 前端 camelCase，落库 snake_case，只在 client 层做一次映射。
 * 数值字段一律 Number(x)||0：历史数据里数值列可能是 NULL/空串。
 */

/** Order -> 可写入的行。写入时不含 id / created_at / updated_at（库生成）。 */
export function toRow(o: Partial<Order>): OrderRow {
  return {
    apply_date:      o.applyDate || null,
    payback_date:    o.paybackDate || null,
    name:            o.name || '',
    phone:           o.phone || '',
    province:        o.province || '',
    city:            o.city || '',
    carrier:         o.carrier || '',
    package:         o.package || '',
    duration:        o.duration || '',
    install_fee:     Number(o.installFee)     || 0,
    package_fee:     Number(o.packageFee)     || 0,
    commission:      Number(o.commission)     || 0,
    commission_rate: Number(o.commissionRate) || 0,
    id_card:         o.idCard  || '',
    address:         o.address || '',
    sales_person:    o.salesPerson || '',
  };
}

/** 数据库行 -> Order。id/created_at/updated_at 由库生成，读出来带上。 */
export function fromRow(r: Record<string, unknown>): Order {
  return {
    id:             r.id as number,
    applyDate:      (r.apply_date as string) || '',
    paybackDate:    (r.payback_date as string) || '',
    name:           (r.name as string) || '',
    phone:          (r.phone as string) || '',
    province:       (r.province as string) || '',
    city:           (r.city as string) || '',
    carrier:        (r.carrier as string) || '',
    package:        (r.package as string) || '',
    duration:       (r.duration as string) || '',
    installFee:     Number(r.install_fee)     || 0,
    packageFee:     Number(r.package_fee)     || 0,
    commission:     Number(r.commission)      || 0,
    commissionRate: Number(r.commission_rate) || 0,
    idCard:         (r.id_card as string) || '',
    address:        (r.address as string) || '',
    salesPerson:    (r.sales_person as string) || '',
    createdAt:      (r.created_at as string) || '',
    updatedAt:      (r.updated_at as string) || '',
  };
}

/* ---------------- 本地缓存 ---------------- */

export function cacheOrders(rows: OrderRow[]): void {
  try {
    localStorage.setItem(DATA_CACHE_KEY, JSON.stringify({ at: Date.now(), rows }));
  } catch { /* 超出配额时放弃缓存即可，不影响主流程 */ }
}

export function readCachedOrders(): { at: number; rows: OrderRow[] } | null {
  try {
    const raw = localStorage.getItem(DATA_CACHE_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as { at?: number; rows?: unknown };
    return d && Array.isArray(d.rows) ? { at: d.at || 0, rows: d.rows as OrderRow[] } : null;
  } catch {
    return null;
  }
}

export function clearCachedOrders(): void {
  try { localStorage.removeItem(DATA_CACHE_KEY); } catch { /* 忽略 */ }
}

/**
 * Content-Range 形如 "0-999/1350"。total > got ⇒ 被截断，返回真实总数；
 * 读不到总数且条数已到可疑量级时，无法证明数据取全了 —— 这种「查不了」
 * 也要说出来，否则守卫本身就是静默失效的。
 */
function parseTotalCount(header: string | null, got: number): { truncatedTotal: number; countUnverified: boolean } {
  const total = parseInt(String(header || '').split('/')[1], 10);
  return {
    countUnverified: !isFinite(total) && got >= COUNT_SUSPICIOUS_AT,
    truncatedTotal: isFinite(total) && total > got ? total : 0,
  };
}

/**
 * 拉全量订单。成功写 localStorage 缓存；失败时若有缓存就返回缓存并置
 * usingCache=true（装到主屏后断网也会走到这里，有缓存以只读方式先顶上，
 * 好过一片空白）；无缓存则把错误抛出去。
 */
export async function loadOrders(): Promise<LoadResult> {
  try {
    // count=exact 让 Supabase 在 Content-Range 里回总行数。接口有默认返回上限，
    // 超出会被静默截断——不比对的话统计和合计会悄悄算少，这是会「算错钱」的。
    const res = await fetch(REST_ORDERS + '?select=*&order=apply_date.desc.nullslast,created_at.desc', {
      headers: Object.assign(authHeaders(orderSession.current()), { 'Prefer': 'count=exact' }),
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error('无访问权限（' + res.status + '），请重新登录或检查 Supabase RLS 配置');
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const raw = (await res.json()) as Record<string, unknown>[];
    const rows = raw.map(fromRow);
    const { truncatedTotal, countUnverified } = parseTotalCount(res.headers.get('Content-Range'), rows.length);
    // 缓存存数据库原始行，离线恢复后 fromRow 语义不变
    cacheOrders(raw);
    return { rows, truncatedTotal, countUnverified, usingCache: false, cachedAt: 0 };
  } catch (e) {
    const cached = readCachedOrders();
    if (cached) {
      const rows = cached.rows.map(fromRow);
      // 缓存里就这些，无从判断是否截断
      return { rows, truncatedTotal: 0, countUnverified: false, usingCache: true, cachedAt: cached.at };
    }
    throw e instanceof Error ? e : new Error(String(e));
  }
}

/** 新增。**不含 id / created_at / updated_at**：由数据库生成，硬塞会冲突。 */
export async function insertOrder(row: OrderRow): Promise<void> {
  await insertOrders([row]);
}

/** 整批插入（CSV 导入用）：数组一次 POST，要么全进要么全不进，不留半截。 */
export async function insertOrders(rows: OrderRow[]): Promise<void> {
  const res = await fetch(REST_ORDERS, {
    method: 'POST',
    headers: authHeaders(orderSession.current()),
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()));
}

/** 按 id 局部更新（PATCH ?id=eq.<id>）。 */
export async function patchOrder(id: number, row: OrderRow): Promise<void> {
  const res = await fetch(REST_ORDERS + '?id=eq.' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: authHeaders(orderSession.current()),
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()));
}

export async function deleteOrder(id: number): Promise<void> {
  const res = await fetch(REST_ORDERS + '?id=eq.' + encodeURIComponent(id), {
    method: 'DELETE',
    headers: authHeaders(orderSession.current()),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()));
}

/** 把删掉的订单原样插回（撤销删除用）。 */
export async function reinsertOrder(row: OrderRow): Promise<void> {
  await insertOrder(row);
}

/**
 * 订单操作日志。401/404 等非 200 一律 reject 'HTTP <status>'；
 * 200 但 body 不是数组时 resolve []（旧行为：日志表可能刚建，还查不出东西）。
 */
export async function fetchLogs(orderId: number): Promise<OrderLog[]> {
  const res = await fetch(REST_LOGS + '?select=*&order_id=eq.' + encodeURIComponent(orderId) +
    '&order=created_at.desc', { headers: authHeaders(orderSession.current()) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const d = (await res.json()) as unknown;
  if (!Array.isArray(d)) return [];
  return d.map((r) => {
    const row = r as Record<string, unknown>;
    return {
      id: row.id as number,
      orderId: (row.order_id as number) || 0,
      action: (row.action as string) || '',
      operator: (row.operator as string) || (row.actor as string) || '',
      field: (row.field as string) || '',
      oldValue: (row.old_value as string) || '',
      newValue: (row.new_value as string) || '',
      createdAt: (row.created_at as string) || '',
    };
  });
}
