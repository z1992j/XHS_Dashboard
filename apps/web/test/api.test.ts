import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getToken, setToken, clearToken, authHeaders, validateToken, galleryOf, visionApi, fetchCapabilities } from '../src/lib/api';

describe('api — token 存取', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('setToken 写入后 getToken 能读回', () => {
    setToken('abc-123');
    expect(getToken()).toBe('abc-123');
  });

  it('未设置时返回空串', () => {
    expect(getToken()).toBe('');
  });

  it('clearToken 清空令牌', () => {
    setToken('abc-123');
    clearToken();
    expect(getToken()).toBe('');
  });

  it('有令牌时 authHeaders 带 Bearer', () => {
    setToken('tok');
    expect(authHeaders()).toEqual({ Authorization: 'Bearer tok' });
  });

  it('无令牌时 authHeaders 为空对象', () => {
    expect(authHeaders()).toEqual({});
  });
});

describe('validateToken — 走 /verify 探针', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('后端 200 时返回 true', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
    expect(await validateToken('any')).toBe(true);
  });

  it('令牌错误（401）时返回 false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}), { status: 401 })));
    expect(await validateToken('bad')).toBe(false);
  });

  it('后端 5xx 时返回 false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}), { status: 502 })));
    expect(await validateToken('any')).toBe(false);
  });

  it('网络异常时返回 false（不抛错）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    expect(await validateToken('any')).toBe(false);
  });

  it('把令牌放进 Authorization 头', async () => {
    const spy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', spy);
    await validateToken('secret');
    expect(spy).toHaveBeenCalledWith('/api/xhs/verify', {
      headers: { Authorization: 'Bearer secret' },
    });
  });
});

describe('galleryOf — 封面永远排在第一张', () => {
  it('封面不在 images 里时补到最前面', () => {
    expect(galleryOf({ imageUrl: '/a.jpg', images: ['/b.jpg'] })).toEqual(['/a.jpg', '/b.jpg']);
  });

  it('封面已在 images 里时不重复', () => {
    expect(galleryOf({ imageUrl: '/a.jpg', images: ['/a.jpg', '/b.jpg'] })).toEqual(['/a.jpg', '/b.jpg']);
  });

  it('只有单图时返回单元素数组', () => {
    expect(galleryOf({ imageUrl: '/a.jpg' })).toEqual(['/a.jpg']);
  });

  it('完全没有图时返回空数组', () => {
    expect(galleryOf({})).toEqual([]);
  });
});

describe('apiJson — /ai/vision 心跳保活后，200 也要认响应体里的 error', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('响应体带 error 时即使状态码是 200 也要抛错（心跳已经提前提交了 200）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: '读图超时，请重试或换一张更小的图片' } }), { status: 200 })
    ));
    await expect(visionApi.read(['data:image/jpeg;base64,xx'])).rejects.toThrow('读图超时');
  });

  it('响应体带 error.detail/model 时把上游原话拼进错误信息', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({
        error: { message: '读图服务暂时不可用', detail: 'upstream 502', model: 'deepseek-v4-flash-vision-exp' },
      }), { status: 200 })
    ));
    await expect(visionApi.read(['data:image/jpeg;base64,xx'])).rejects.toThrow(/upstream 502/);
  });

  it('正常状态码 + 无 error 字段时照常返回数据，不受这条放宽影响', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ facts: [], hasText: false, imagesRead: 1 }), { status: 200 })
    ));
    const r = await visionApi.read(['data:image/jpeg;base64,xx']);
    expect(r.imagesRead).toBe(1);
  });
});

describe('fetchCapabilities — 把线上真正在跑的文案模型报出来', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('服务器 .env 钉死型号时标记 pinned —— 推代码改不动它，得让人看见', () => {
    // CD 从不上传 .env，钉死的 XHS_AI_MODEL 会一直覆盖代码默认值；
    // 界面上不摆出来，用户只会以为"代码推了就升级了"
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      textModel: 'deepseek-v4-flash', textModelPinned: true,
    }), { status: 200 })));
    return fetchCapabilities().then(c => {
      expect(c.textModel).toBe('deepseek-v4-flash');
      expect(c.textModelPinned).toBe(true);
    });
  });

  it('没钉死时 pinned 为 false —— 用的是代码默认值，会自动跟随厂商升级', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      textModel: 'deepseek-chat', textModelPinned: false,
    }), { status: 200 })));
    const c = await fetchCapabilities();
    expect(c.textModelPinned).toBe(false);
  });

  it('health 拿不到时回落值也带上这两个字段，不会是 undefined', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const c = await fetchCapabilities();
    expect(c.textModel).toBe('');
    expect(c.textModelPinned).toBe(false);
  });

  // 工作台首页靠这一位区分「后端没起来」和「起来了但功能没开」。
  // 回落值所有开关都是 false，没有 reachable 的话两者长得一模一样。
  it('reachable：连通为 true，离线与非 2xx 为 false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      textModel: 'deepseek-chat', vision: true,
    }), { status: 200 })));
    expect((await fetchCapabilities()).reachable).toBe(true);

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect((await fetchCapabilities()).reachable).toBe(false);

    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 502 })));
    expect((await fetchCapabilities()).reachable).toBe(false);
  });
});
