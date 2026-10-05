import { describe, it, expect } from 'vitest';
import { similarityScore, describeSimilarity, normalizeForCompare } from '../src/lib/similarity';

describe('normalizeForCompare — 只留有信息量的字符', () => {
  it('剥掉空白和标点', () => {
    expect(normalizeForCompare('你好，世界！ 再见。')).toBe('你好世界再见');
  });

  it('剥掉话题标签', () => {
    expect(normalizeForCompare('正文内容 #宽带办理# #省钱#')).toBe('正文内容');
  });

  it('剥掉链接', () => {
    expect(normalizeForCompare('看这里 https://a.example.com/x 就是它')).toBe('看这里就是它');
  });
});

describe('similarityScore — 0 到 100', () => {
  const original = '这家运营商的宽带套餐真的很划算，一年才五百块，网速稳定，客服响应也快。';

  it('完全相同时接近 100', () => {
    expect(similarityScore(original, original)).toBe(100);
  });

  it('原样复制但只改了标点，仍应判定为高度重合', () => {
    const copied = '这家运营商的宽带套餐真的很划算!一年才五百块!网速稳定!客服响应也快!';
    expect(similarityScore(original, copied)).toBeGreaterThan(80);
  });

  it('彻底改写后分数明显下降', () => {
    const rewritten = '说实话我一开始也怀疑，办完才发现真香。五百出头用一整年，晚上打游戏没卡过。';
    expect(similarityScore(original, rewritten)).toBeLessThan(40);
  });

  it('毫不相干的内容接近 0', () => {
    expect(similarityScore(original, '今天午饭吃的螺蛳粉')).toBeLessThan(15);
  });

  it('任一侧过短时返回 0，不给无意义的高分', () => {
    expect(similarityScore(original, '好')).toBe(0);
    expect(similarityScore('', original)).toBe(0);
  });

  it('分数始终落在 0-100 区间', () => {
    for (const [a, b] of [[original, ''], ['', ''], [original, original], [original, '短']]) {
      const s = similarityScore(a, b);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(100);
    }
  });
});

describe('describeSimilarity — 分档给建议', () => {
  it('30 以下算改写充分', () => {
    expect(describeSimilarity(12).level).toBe('good');
  });

  it('30-50 之间提示还有重合', () => {
    expect(describeSimilarity(30).level).toBe('fair');
    expect(describeSimilarity(49).level).toBe('fair');
  });

  it('50 及以上判定为有重复风险', () => {
    expect(describeSimilarity(50).level).toBe('risky');
    expect(describeSimilarity(95).level).toBe('risky');
  });

  it('每一档都带上可执行的建议文案', () => {
    for (const s of [10, 40, 80]) {
      expect(describeSimilarity(s).hint.length).toBeGreaterThan(0);
      expect(describeSimilarity(s).score).toBe(s);
    }
  });
});
