import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  authHeaders,
  authErrorHint,
  orderSession,
  loadOrders,
  insertOrders,
  patchOrder,
  deleteOrder,
  fetchLogs,
  toRow,
  fromRow,
  cacheOrders,
  readCachedOrders,
  clearCachedOrders,
} from '../src/orders/client';
import { SUPABASE_KEY, SESSION_STORE_KEY, DATA_CACHE_KEY, REST_ORDERS, REST_LOGS } from '../src/orders/config';
import { mkOrder } from './order-fixture';
import type { Session, Order } from '../src/orders/types';

// 页面闸门只认 config.PASSWORD_HASH（= sha256b64(PASSWORD_SALT + 明文)）。
// config 在模块求值时就把 env 读进常量，stub 必须发生在它 import 之前 ——
// vi.hoisted 会把这段提升到所有 import 之前执行。测的是「env 覆盖哈希」
// 这条真实配置路径；test1234 的明文不进源码，这正是闸门的设计意图。
vi.hoisted(() => {
  vi.stubEnv('VITE_ORDER_PASSWORD_HASH', 'yc79tGOd2fkc2nZr+/7/gSKu+rumMxBsPnAv+oKWmro=');
});

// login 相关用例用 test1234 当闸门密码（哈希见上），其余用例不受影响
const GATE_PW = 'test1234';

// Response 的 body 只能读一次，用工厂函数保证每个用例拿到新 Response
const respond = (body: unknown, init?: ResponseInit) => () =>
  new Response(JSON.stringify(body), init);
// 204 不能带 body，Response 构造器会直接抛
const respondNoBody = (status: number) => () => new Response(null, { status });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const session = (): Session => ({
  token: 'jwt-token-1',
  refresh: 'refresh-1',
  expiresAt: Date.now() + 3600_000,
});

const okRows = (orders: Order[]) => {
  const raw = orders.map((o) => ({
    id: o.id, apply_date: o.applyDate, payback_date: o.paybackDate,
    name: o.name, phone: o.phone, province: o.province, city: o.city,
    carrier: o.carrier, package: o.package, duration: o.duration,
    install_fee: o.installFee, package_fee: o.packageFee, commission: o.commission,
    commission_rate: o.commissionRate, id_card: o.idCard, address: o.address,
    sales_person: o.salesPerson, created_at: o.createdAt, updated_at: o.updatedAt,
  }));
  return respond(raw, {
    status: 200,
    headers: { 'Content-Range': '0-' + (raw.length - 1) + '/' + raw.length },
  });
};

describe('authHeaders', () => {
  it('有会话时 Bearer 带令牌，apikey 恒为 publishable key', () => {
    const h = authHeaders(session());
    expect(h['apikey']).toBe(SUPABASE_KEY);
    expect(h['Authorization']).toBe('Bearer jwt-token-1');
    expect(h['Content-Type']).toBe('application/json');
  });

  it('无会话时回落到 publishable key', () => {
    expect(authHeaders(null)['Authorization']).toBe('Bearer ' + SUPABASE_KEY);
  });
});

describe('authErrorHint', () => {
  it('四类报错各自给出处置办法', () => {
    expect(authErrorHint('Email not confirmed')).toContain('Confirm email');
    expect(authErrorHint('Invalid login credentials')).toContain('邮箱或密码对不上');
    expect(authErrorHint('Email logins are disabled')).toContain('Enable Email provider');
    expect(authErrorHint('Email address invalid')).toContain('换成常规域名');
  });

  it('未知报错落到默认提示', () => {
    expect(authErrorHint('something else')).toContain('确认账号');
  });
});

describe('orderSession', () => {
  it('login 空密码：请输入密码，不发任何请求', async () => {
    const r = await orderSession.login('   ', true);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('请输入密码');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('login 页面闸门密码错误：密码错误，不发任何请求', async () => {
    const r = await orderSession.login('wrong-password', true);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('密码错误');
    // 闸门没过就不能碰 GoTrue —— 这是两阶段设计的全部意义
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('login 成功：闸门通过后换令牌，remember=true 落 localStorage 并清掉另一侧', async () => {
    fetchMock.mockImplementation(respond({
      access_token: 'jwt-new', refresh_token: 'refresh-new', expires_in: 3600,
    }, { status: 200 }));
    const r = await orderSession.login(GATE_PW, true);
    expect(r.ok).toBe(true);
    expect(JSON.parse(localStorage.getItem(SESSION_STORE_KEY)!).db.token).toBe('jwt-new');
    expect(sessionStorage.getItem(SESSION_STORE_KEY)).toBeNull();
    expect(orderSession.current()?.token).toBe('jwt-new');
    // 提前 60 秒过期
    expect(orderSession.current()!.expiresAt).toBeLessThan(Date.now() + 3600_000);
    // 闸门过了才发请求，且请求体带的是同一个明文（换 token 用）
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).password).toBe(GATE_PW);
  });

  it('login 成功：remember=false 落 sessionStorage', async () => {
    fetchMock.mockImplementation(respond({ access_token: 'jwt-s', expires_in: 600 }, { status: 200 }));
    await orderSession.login(GATE_PW, false);
    expect(sessionStorage.getItem(SESSION_STORE_KEY)).not.toBeNull();
    expect(localStorage.getItem(SESSION_STORE_KEY)).toBeNull();
  });

  it('login 闸门过了但 GoTrue 拒绝：沿用 signInToDatabase 的 error 文案', async () => {
    fetchMock.mockImplementation(respond({ msg: 'Invalid login credentials' }, { status: 400 }));
    const r = await orderSession.login(GATE_PW, true);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('Invalid login credentials');
    // 失败不会替换内存会话（本文件前面的用例已登录）
    expect(orderSession.current()?.token).toBe('jwt-s');
  });

  it('login 异常：被 login 兜住，不把异常抛给 store（signInToDatabase 已带连接失败文案）', async () => {
    fetchMock.mockImplementation(() => { throw new Error('network gone'); });
    const r = await orderSession.login(GATE_PW, true);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('无法连接 Supabase：network gone');
  });

  it('restore：有效会话恢复；过期返回 null；残缺（缺令牌）返回 null', () => {
    const good = { ok: true, db: { token: 't', refresh: 'r', expiresAt: Date.now() + 60000 } };
    localStorage.setItem(SESSION_STORE_KEY, JSON.stringify(good));
    expect(orderSession.restore()?.token).toBe('t');

    const expired = { ok: true, db: { token: 't', refresh: 'r', expiresAt: Date.now() - 1 } };
    localStorage.setItem(SESSION_STORE_KEY, JSON.stringify(expired));
    expect(orderSession.restore()).toBeNull();

    const broken = { ok: true, db: { token: '', expiresAt: Date.now() + 60000 } };
    localStorage.setItem(SESSION_STORE_KEY, JSON.stringify(broken));
    expect(orderSession.restore()).toBeNull();

    localStorage.setItem(SESSION_STORE_KEY, JSON.stringify({ ok: false, db: null }));
    expect(orderSession.restore()).toBeNull();

    // hasStored 只看「存过没有」，残缺也报 true（boot 阶段好提示重输密码）
    expect(orderSession.hasStored()).toBe(true);
  });

  it('refresh：成功续期并把新令牌写回原 storage', async () => {
    // 通过 login 注入 currentSession（restore 只认 storage）；refresh_token 必须有，否则续期直接放弃
    fetchMock.mockImplementation(respond({ access_token: 'jwt-x', refresh_token: 'refresh-x', expires_in: 3600 }, { status: 200 }));
    await orderSession.login(GATE_PW, false);
    fetchMock.mockImplementation(respond({ access_token: 'jwt-y', refresh_token: 'refresh-y', expires_in: 3600 }, { status: 200 }));
    const next = await orderSession.refresh();
    expect(next?.token).toBe('jwt-y');
    expect(JSON.parse(sessionStorage.getItem(SESSION_STORE_KEY)!).db.token).toBe('jwt-y');
  });

  it('refresh：失败返回 null', async () => {
    fetchMock.mockImplementation(respond({ access_token: 'jwt-x', refresh_token: 'refresh-x', expires_in: 3600 }, { status: 200 }));
    await orderSession.login(GATE_PW, false);
    fetchMock.mockImplementation(() => { throw new Error('network down'); });
    expect(await orderSession.refresh()).toBeNull();
  });

  it('logout：清空两侧存储与内存会话', async () => {
    fetchMock.mockImplementation(respond({ access_token: 'jwt-x', expires_in: 3600 }, { status: 200 }));
    await orderSession.login(GATE_PW, true);
    orderSession.logout();
    expect(orderSession.current()).toBeNull();
    expect(localStorage.getItem(SESSION_STORE_KEY)).toBeNull();
  });
});

describe('loadOrders', () => {
  it('成功：行映射 + Content-Range 总数，写缓存', async () => {
    const orders = [mkOrder({ id: 1 }), mkOrder({ id: 2 })];
    fetchMock.mockImplementation(okRows(orders));
    const r = await loadOrders();
    expect(r.usingCache).toBe(false);
    expect(r.truncatedTotal).toBe(0);
    expect(r.countUnverified).toBe(false);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0].name).toBe('张三');
    expect(JSON.parse(localStorage.getItem(DATA_CACHE_KEY)!).rows).toHaveLength(2);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(REST_ORDERS + '?select=*&order=apply_date.desc.nullslast,created_at.desc');
    expect(init.headers['Prefer']).toBe('count=exact');
  });

  it('Content-Range 显示 1350 条但只回了 1000 条 → truncatedTotal', async () => {
    const raw = Array.from({ length: 1000 }, (_, i) => ({
      id: i + 1, name: 'x' + i, phone: '139000000' + String(i).padStart(2, '0'),
    }));
    fetchMock.mockImplementation(() => new Response(JSON.stringify(raw), {
      status: 200,
      headers: { 'Content-Range': '0-999/1350' },
    }));
    const r = await loadOrders();
    expect(r.truncatedTotal).toBe(1350);
    expect(r.countUnverified).toBe(false);
    expect(r.rows).toHaveLength(1000);
  });

  it('读不到总数且条数 ≥ 1000 → countUnverified=true', async () => {
    const raw = Array.from({ length: 1000 }, (_, i) => ({ id: i + 1, name: 'x' }));
    fetchMock.mockImplementation(() => new Response(JSON.stringify(raw), { status: 200 }));
    const r = await loadOrders();
    expect(r.countUnverified).toBe(true);
    expect(r.truncatedTotal).toBe(0);
  });

  it('401 → 抛权限提示文案', async () => {
    fetchMock.mockImplementation(respond({}, { status: 401 }));
    await expect(loadOrders()).rejects.toThrow('无访问权限（401）');
  });

  it('403 → 同样的权限提示', async () => {
    fetchMock.mockImplementation(respond({}, { status: 403 }));
    await expect(loadOrders()).rejects.toThrow('无访问权限（403）');
  });

  it('其他 HTTP 错误 → HTTP <status>', async () => {
    fetchMock.mockImplementation(respond({}, { status: 500 }));
    await expect(loadOrders()).rejects.toThrow('HTTP 500');
  });

  it('失败但有缓存 → 返回缓存并置 usingCache', async () => {
    // 缓存里存的是数据库原始行（含 id）
    cacheOrders([toRow(mkOrder({ id: 9 }))].map((r) => ({ ...r, id: 9 })));
    fetchMock.mockImplementation(respond({}, { status: 500 }));
    const r = await loadOrders();
    expect(r.usingCache).toBe(true);
    expect(r.cachedAt).toBeGreaterThan(0);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].id).toBe(9);
  });

  it('失败且无缓存 → 抛出原始错误', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new TypeError('network down')));
    await expect(loadOrders()).rejects.toThrow('network down');
  });
});

describe('写操作', () => {
  it('insertOrders：POST 数组体，非 2xx 抛错', async () => {
    fetchMock.mockImplementation(respond([], { status: 201 }));
    const row = toRow(mkOrder({ id: 1 }));
    await insertOrders([row]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(REST_ORDERS);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual([row]);
    // 写入行不含库生成字段
    expect(row).not.toHaveProperty('id');
    expect(row).not.toHaveProperty('created_at');

    fetchMock.mockImplementation(respond({ message: 'duplicate' }, { status: 409 }));
    await expect(insertOrders([row])).rejects.toThrow('HTTP 409');
  });

  it('patchOrder：PATCH ?id=eq.<id>', async () => {
    fetchMock.mockImplementation(respondNoBody(204));
    await patchOrder(42, toRow(mkOrder()));
    const [url, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('PATCH');
    expect(url).toBe(REST_ORDERS + '?id=eq.42');
  });

  it('deleteOrder：DELETE ?id=eq.<id>', async () => {
    fetchMock.mockImplementation(respondNoBody(204));
    await deleteOrder(7);
    const [url, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('DELETE');
    expect(url).toBe(REST_ORDERS + '?id=eq.7');
  });
});

describe('fetchLogs', () => {
  it('映射 snake_case 字段，actor 兜底 operator', async () => {
    fetchMock.mockImplementation(respond([
      { id: 1, order_id: 5, action: 'update', field: 'commission',
        old_value: '100', new_value: '300', actor: '大卫', created_at: '2026-10-11T00:00:00Z' },
      { id: 2, order_id: 5, action: 'insert', operator: '管理员' },
    ], { status: 200 }));
    const logs = await fetchLogs(5);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toEqual({
      id: 1, orderId: 5, action: 'update', operator: '大卫', field: 'commission',
      oldValue: '100', newValue: '300', createdAt: '2026-10-11T00:00:00Z',
    });
    expect(logs[1].operator).toBe('管理员');
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain(REST_LOGS + '?select=*&order_id=eq.5');
    expect(url).toContain('order=created_at.desc');
  });

  it('200 但 body 不是数组 → 空数组', async () => {
    fetchMock.mockImplementation(respond({ error: 'no table' }, { status: 200 }));
    expect(await fetchLogs(1)).toEqual([]);
  });

  it('非 200 → HTTP <status>', async () => {
    fetchMock.mockImplementation(respond({}, { status: 404 }));
    await expect(fetchLogs(1)).rejects.toThrow('HTTP 404');
  });
});

describe('toRow / fromRow', () => {
  it('camelCase ↔ snake_case 往返', () => {
    const o = mkOrder({ paybackDate: '2026-09-15', idCard: '11010119900307451X' });
    const row = toRow(o);
    expect(row.apply_date).toBe(o.applyDate);
    expect(row.commission_rate).toBe(o.commissionRate);
    expect(row.sales_person).toBe('大卫');
    expect(row).not.toHaveProperty('id');
    const back = fromRow({ ...row, id: 3, created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-02T00:00:00Z' });
    expect(back.id).toBe(3);
    expect(back.name).toBe(o.name);
    expect(back.phone).toBe(o.phone);
    expect(back.commissionRate).toBe(o.commissionRate);
    expect(back.createdAt).toBe('2026-09-01T00:00:00Z');
  });

  it('数值列 NULL / 空串兜底 0；字符串列空值兜底空串', () => {
    const o = fromRow({
      id: 1, install_fee: null, package_fee: '', commission: null, commission_rate: null,
    });
    expect(o.installFee).toBe(0);
    expect(o.packageFee).toBe(0);
    expect(o.commission).toBe(0);
    expect(o.commissionRate).toBe(0);
    expect(o.name).toBe('');
    expect(o.applyDate).toBe('');
  });
});

describe('订单缓存', () => {
  it('写入后能读回，清除后读不到', () => {
    const rows = [toRow(mkOrder({ id: 1 }))];
    cacheOrders(rows);
    const cached = readCachedOrders();
    expect(cached?.rows).toEqual(rows);
    expect(cached!.at).toBeGreaterThan(0);
    clearCachedOrders();
    expect(readCachedOrders()).toBeNull();
    expect(localStorage.getItem(DATA_CACHE_KEY)).toBeNull();
  });

  it('缓存内容损坏 → 返回 null', () => {
    localStorage.setItem(DATA_CACHE_KEY, '{not json');
    expect(readCachedOrders()).toBeNull();
    localStorage.setItem(DATA_CACHE_KEY, JSON.stringify({ at: 1, rows: 'nope' }));
    expect(readCachedOrders()).toBeNull();
  });
});
