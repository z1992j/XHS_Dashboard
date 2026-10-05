import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  getCustomTemplates, saveCustomTemplate, updateCustomTemplate,
  deleteCustomTemplate, getAllTemplates, syncTemplates, PRESET_TEMPLATES,
} from '../src/lib/templates';

const base = { name: '测试模板', icon: '🧪', description: '一句话', systemPrompt: '你是一个测试' };

describe('模板本地缓存', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    // 写操作会后台推服务端；这里只关心本地行为，把网络挡掉
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  });

  it('新建后能读回，并带上 isCustom', () => {
    const t = saveCustomTemplate(base);
    expect(t.isCustom).toBe(true);
    expect(getCustomTemplates()).toHaveLength(1);
  });

  it('getAllTemplates 把预设排在自定义前面', () => {
    saveCustomTemplate(base);
    const all = getAllTemplates();
    expect(all.slice(0, PRESET_TEMPLATES.length).map(t => t.id))
      .toEqual(PRESET_TEMPLATES.map(t => t.id));
    expect(all).toHaveLength(PRESET_TEMPLATES.length + 1);
  });

  it('更新只改目标模板', () => {
    const a = saveCustomTemplate(base);
    updateCustomTemplate(a.id, { name: '改过了' });
    expect(getCustomTemplates()[0].name).toBe('改过了');
    expect(getCustomTemplates()[0].systemPrompt).toBe(base.systemPrompt);
  });

  it('更新不存在的 id 不抛错也不新增', () => {
    saveCustomTemplate(base);
    expect(() => updateCustomTemplate('custom_nope', { name: 'x' })).not.toThrow();
    expect(getCustomTemplates()).toHaveLength(1);
  });

  it('删除后本地不再有它', () => {
    const a = saveCustomTemplate(base);
    deleteCustomTemplate(a.id);
    expect(getCustomTemplates()).toHaveLength(0);
  });

  it('缓存损坏时返回空数组而不是崩掉', () => {
    localStorage.setItem('xhs_custom_templates', '{坏 JSON');
    expect(getCustomTemplates()).toEqual([]);
  });
});

describe('syncTemplates — 本地与云端合并', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });
  afterEach(() => vi.restoreAllMocks());

  const mockList = (available: boolean, data: unknown[]) =>
    vi.stubGlobal('fetch', vi.fn(async (url: string, opts?: RequestInit) => {
      if (opts?.method === 'PUT' || opts?.method === 'DELETE') {
        return new Response('{"ok":true}', { status: 200 });
      }
      if (String(url).includes('/templates')) {
        return new Response(JSON.stringify({ available, data }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }));

  it('服务端没建表时不动本地缓存', async () => {
    mockList(false, []);
    saveCustomTemplate(base);
    const r = await syncTemplates();
    expect(r.synced).toBe(false);
    expect(getCustomTemplates()).toHaveLength(1);
  });

  it('拉下只有服务端有的模板', async () => {
    mockList(true, [{
      id: 'custom_1', name: '云端的', icon: '☁️', description: '', systemPrompt: 'p', isCustom: true,
    }]);
    const r = await syncTemplates();
    expect(r.synced).toBe(true);
    expect(getCustomTemplates().map(t => t.id)).toEqual(['custom_1']);
  });

  it('只有本地有的会被推上去并保留 —— 首次启用同步时的迁移路径', async () => {
    mockList(true, []);
    const local = saveCustomTemplate(base);
    await syncTemplates();
    expect(getCustomTemplates().map(t => t.id)).toContain(local.id);
  });

  it('同一个 id 两边都有时以服务端为准', async () => {
    const local = saveCustomTemplate(base);
    mockList(true, [{
      id: local.id, name: '服务端版本', icon: '☁️', description: '', systemPrompt: 'remote', isCustom: true,
    }]);
    await syncTemplates();
    const merged = getCustomTemplates();
    expect(merged).toHaveLength(1);
    expect(merged[0].name).toBe('服务端版本');
  });

  it('取并集，不做删除传播', async () => {
    const local = saveCustomTemplate(base);
    mockList(true, [{
      id: 'custom_remote', name: '远端', icon: '☁️', description: '', systemPrompt: 'p', isCustom: true,
    }]);
    await syncTemplates();
    const ids = getCustomTemplates().map(t => t.id);
    expect(ids).toContain('custom_remote');
    expect(ids).toContain(local.id);
  });

  it('网络失败时保留本地缓存', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    saveCustomTemplate(base);
    const r = await syncTemplates();
    expect(r.synced).toBe(false);
    expect(getCustomTemplates()).toHaveLength(1);
  });
});
