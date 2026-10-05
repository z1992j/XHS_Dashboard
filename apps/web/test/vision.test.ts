import { describe, it, expect, vi, beforeEach } from 'vitest';
import { profileToPrompt, composeFromFacts, type StyleProfile } from '../src/lib/api';

const full: StyleProfile = {
  开头习惯: ['先抛结论再解释'],
  句长节奏: '长短交替，平均 18 字',
  emoji: { 密度: '每段 1-2 个', 位置: '句尾' },
  自称: '我',
  高频标签: ['宽带办理', '上海'],
  结尾习惯: ['引导评论区提问'],
  口头禅: ['说实话', '反正'],
  避免: ['综上所述', '首先其次'],
};

describe('profileToPrompt — 风格画像转提示词', () => {
  it('没有画像时返回空串，调用方据此退回预设模板', () => {
    expect(profileToPrompt(null)).toBe('');
  });

  it('所有字段都为空时也返回空串，不产出一段没内容的提示', () => {
    const empty: StyleProfile = {
      开头习惯: [], 句长节奏: '', emoji: { 密度: '', 位置: '' }, 自称: '',
      高频标签: [], 结尾习惯: [], 口头禅: [], 避免: [],
    };
    expect(profileToPrompt(empty)).toBe('');
  });

  it('把各项特征都带进提示词', () => {
    const out = profileToPrompt(full);
    expect(out).toContain('我');
    expect(out).toContain('长短交替');
    expect(out).toContain('先抛结论再解释');
    expect(out).toContain('说实话');
  });

  it('「避免」项要明确写成禁止，而不是可选建议', () => {
    const out = profileToPrompt(full);
    expect(out).toContain('绝对不要用');
    expect(out).toContain('综上所述');
  });

  it('只填了部分字段时不会输出空行标签', () => {
    const partial = { ...full, 口头禅: [], 避免: [], 开头习惯: [] };
    const out = profileToPrompt(partial);
    expect(out).not.toContain('口头禅');
    expect(out).not.toContain('绝对不要用');
    expect(out).toContain('句长节奏');
  });

  it('高频标签不进提示词 —— 标签由内容决定，不该硬套', () => {
    // 画像里记录高频标签是为了让人看，生成时硬塞会让每篇标签都一样
    expect(profileToPrompt(full)).not.toContain('宽带办理');
  });
});

describe('composeFromFacts — 看图成文的标签数量', () => {
  const facts = [
    { key: '运营商', value: '中国移动', confidence: 'high' as const },
    { key: '带宽', value: '300M', confidence: 'high' as const },
    { key: '月费', value: '79元', confidence: 'high' as const },
  ];

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('提示词要求生成 10 个标签，不再是之前偏少的 3-8 个', () => {
    // 之前这条提示词写的是「3-8 个」，比仿写流程的上限 10 个更保守，
    // 导致看图成文出来的笔记标签总是没打满，和素材库里其它写法不一致
    let sentPrompt = '';
    vi.stubGlobal('fetch', vi.fn(async (_url, opts) => {
      const body = JSON.parse(String(opts.body));
      sentPrompt = body.messages[1].content;
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ title: 't', content: 'c', tags: [] }) } }],
      }), { status: 200 });
    }));
    return composeFromFacts({ facts, scene: '资费表截图' }).then(() => {
      expect(sentPrompt).toMatch(/10\s*个/);
      expect(sentPrompt).not.toContain('3-8 个');
    });
  });

  it('模型老实给了 10 个标签时，全部保留不被过度裁剪', async () => {
    const tenTags = Array.from({ length: 10 }, (_, i) => `标签${i + 1}`);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ title: 't', content: 'c', tags: tenTags }) } }],
    }), { status: 200 })));
    const result = await composeFromFacts({ facts, scene: '资费表截图' });
    expect(result.tags).toHaveLength(10);
  });
});
