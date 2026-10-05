import { describe, it, expect } from 'vitest';
import { noteToPlainText } from '../src/lib/clipboard';

describe('noteToPlainText — 纯文本拼接', () => {
  it('标题、正文、标签使用两个换行分隔', () => {
    const text = noteToPlainText({
      title: '测试标题',
      content: '第一行\n第二行',
      tags: ['a', 'b'],
    });
    expect(text).toBe('测试标题\n\n第一行\n第二行\n\n#a #b');
  });

  it('无标签时尾部标签行为空', () => {
    const text = noteToPlainText({
      title: 'T',
      content: 'C',
      tags: [],
    });
    expect(text).toBe('T\n\nC\n\n');
  });

  it('tags 为 undefined 时不抛错', () => {
    const text = noteToPlainText({ title: 'T', content: 'C' });
    expect(text).toBe('T\n\nC\n\n');
  });
});
