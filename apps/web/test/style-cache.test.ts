import { describe, it, expect, beforeEach, vi } from 'vitest';
import { styleApi, type StyleProfile } from '../src/lib/api';

const profile: StyleProfile = {
  开头习惯: ['先抛结论'], 句长节奏: '长短交替', emoji: { 密度: '每段1-2个', 位置: '句尾' },
  自称: '我', 高频标签: ['宽带办理'], 结尾习惯: ['引导评论'], 口头禅: ['说实话'], 避免: ['综上所述'],
};

const mockGet = (body: unknown, status = 200) =>
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));

const mockRebuild = (body: unknown) =>
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));

describe('styleApi — 服务端未建表时的本地兜底', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('服务端有画像时直接用服务端的，不碰本地缓存', async () => {
    mockGet({ profile, sampleCount: 30, minSamples: 20, ready: true, updatedAt: 't', cacheAvailable: true });
    const r = await styleApi.get();
    expect(r.profile).toEqual(profile);
    expect(r.cacheAvailable).toBe(true);
  });

  it('服务端没建表（profile 为空且 cacheAvailable=false）时，用本地缓存补上', async () => {
    localStorage.setItem('xhs_style_profile_cache', JSON.stringify({
      profile, sampleCount: 25, updatedAt: '2026-01-01',
    }));
    mockGet({ profile: null, sampleCount: 52, minSamples: 20, ready: true, updatedAt: null, cacheAvailable: false });
    const r = await styleApi.get();
    expect(r.profile).toEqual(profile);
    expect(r.sampleCount).toBe(25); // 来自本地缓存的篇数，不是服务端当前的素材总数
  });

  it('本地也没有缓存时，如实返回空画像（不会凭空生成一个）', async () => {
    mockGet({ profile: null, sampleCount: 52, minSamples: 20, ready: true, updatedAt: null, cacheAvailable: false });
    const r = await styleApi.get();
    expect(r.profile).toBeNull();
  });

  it('已建表但确实还没分析过（cacheAvailable=true, profile=null）时不会被本地缓存污染', async () => {
    // 换了一台新设备，本地没有缓存，服务端也还没分析过 —— 这种情况下
    // 就该老实显示"未生成"，不该因为逻辑判断错误而报错或显示脏数据
    mockGet({ profile: null, sampleCount: 52, minSamples: 20, ready: true, updatedAt: null, cacheAvailable: true });
    const r = await styleApi.get();
    expect(r.profile).toBeNull();
  });

  it('请求整体失败（网络异常）时，本地缓存仍能撑住基本可用性', async () => {
    localStorage.setItem('xhs_style_profile_cache', JSON.stringify({
      profile, sampleCount: 25, updatedAt: '2026-01-01',
    }));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const r = await styleApi.get();
    expect(r.profile).toEqual(profile);
    expect(r.ready).toBe(true);
  });

  it('请求失败且本地也没有缓存时，原样抛出错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await expect(styleApi.get()).rejects.toThrow();
  });

  it('rebuild 成功后写入本地缓存 —— 这是"分析完就没了"的直接解法', async () => {
    mockRebuild({ profile, sampleCount: 30, cached: false });
    await styleApi.rebuild();
    const cached = JSON.parse(localStorage.getItem('xhs_style_profile_cache')!);
    expect(cached.profile).toEqual(profile);
    expect(cached.sampleCount).toBe(30);
  });

  it('rebuild 返回值把服务端是否真正持久化的信息带出来', async () => {
    mockRebuild({ profile, sampleCount: 30, cached: true });
    const r = await styleApi.rebuild();
    expect(r.cached).toBe(true);
  });

  it('刷新页面后（新的 get 调用）能读到刚分析出的本地缓存', async () => {
    mockRebuild({ profile, sampleCount: 30, cached: false });
    await styleApi.rebuild();

    mockGet({ profile: null, sampleCount: 52, minSamples: 20, ready: true, updatedAt: null, cacheAvailable: false });
    const r = await styleApi.get();
    expect(r.profile).toEqual(profile);
  });
});
