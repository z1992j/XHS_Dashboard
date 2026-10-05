import { describe, it, expect } from 'vitest';
import {
  findDuplicatePairs, tagDistribution, buildInsights,
  MAX_PAIR_SCAN, PAIR_REPORT_THRESHOLD,
} from '../src/lib/insights';
import type { Material } from '../src/lib/api';

const mk = (id: number, title: string, content: string, tags: string[] = []): Material => ({
  id, title, content, tags, prompt: '', createdAt: '2026-09-01T00:00:00Z',
});

describe('findDuplicatePairs — 把重复检查从单篇抬到整个库', () => {
  it('几乎一样的两篇会被揪出来，并按分数降序', () => {
    const near = '广州移动宽带300M每月79元包含20G全国流量送来电显示';
    const list = [
      mk(1, 'A', near),
      mk(2, 'B', near + '另外还送一张副卡'),
      mk(3, 'C', '今天去公园散步天气很好拍了几张照片风景不错心情舒畅'),
    ];
    const pairs = findDuplicatePairs(list);
    expect(pairs.length).toBeGreaterThan(0);
    const ids = [pairs[0].a.id, pairs[0].b.id].sort();
    expect(ids).toEqual([1, 2]);
    expect(pairs[0].score).toBeGreaterThanOrEqual(PAIR_REPORT_THRESHOLD);
  });

  it('毫不相干的内容不进结果 —— 低于阈值的噪音没有意义', () => {
    const list = [
      mk(1, 'A', '广州移动宽带三百兆每月七十九元包含全国流量'),
      mk(2, 'B', '今天去公园散步天气很好拍了几张照片风景不错'),
    ];
    expect(findDuplicatePairs(list)).toHaveLength(0);
  });

  it('比的是正文不是标题 —— 标题套路化，撞标题不代表内容重复', () => {
    const list = [
      mk(1, '广州宽带办理攻略', '今天去公园散步天气很好拍了几张照片风景不错心情舒畅'),
      mk(2, '广州宽带办理攻略', '楼下新开的火锅店味道一般但是服务态度很好价格也实惠'),
    ];
    expect(findDuplicatePairs(list)).toHaveLength(0);
  });

  it('只返回前 N 对，避免把整页刷满', () => {
    const same = '广州移动宽带300M每月79元包含20G全国流量送来电显示功能';
    const list = Array.from({ length: 8 }, (_, i) => mk(i + 1, `T${i}`, same));
    expect(findDuplicatePairs(list, 3)).toHaveLength(3);
  });

  it('超过上限时只比最近的 N 篇 —— 上千篇的 O(n²) 会卡死主线程', () => {
    const same = '广州移动宽带300M每月79元包含20G全国流量送来电显示功能';
    const list = Array.from({ length: MAX_PAIR_SCAN + 50 }, (_, i) => mk(i + 1, `T${i}`, same));
    // 超出扫描范围的那些 id 不应出现在结果里
    for (const p of findDuplicatePairs(list)) {
      expect(p.a.id).toBeLessThanOrEqual(MAX_PAIR_SCAN);
      expect(p.b.id).toBeLessThanOrEqual(MAX_PAIR_SCAN);
    }
    expect(buildInsights(list).scanned).toBe(MAX_PAIR_SCAN);
  });

  it('空库不报错', () => {
    expect(findDuplicatePairs([])).toEqual([]);
  });
});

describe('tagDistribution — 下一篇该打什么标签', () => {
  it('按出现篇数降序', () => {
    const list = [
      mk(1, 'A', 'x', ['宽带', '广州']),
      mk(2, 'B', 'y', ['宽带', '移动']),
      mk(3, 'C', 'z', ['宽带']),
    ];
    const tags = tagDistribution(list);
    expect(tags[0].name).toBe('宽带');
    expect(tags[0].count).toBe(3);
  });

  it('同一篇里重复的标签只算一次 —— 否则一篇就能把某个标签刷上榜', () => {
    const list = [mk(1, 'A', 'x', ['宽带', '宽带', '宽带'])];
    expect(tagDistribution(list)[0].count).toBe(1);
  });

  it('percent 以最高频标签为基准，最高的那条是满格', () => {
    // 用总数当分母会让所有条都挤在左边一小截，失去比较意义
    const list = [
      mk(1, 'A', 'x', ['宽带', '广州']),
      mk(2, 'B', 'y', ['宽带']),
    ];
    const tags = tagDistribution(list);
    expect(tags[0].percent).toBe(100);
    expect(tags[1].percent).toBe(50);
  });

  it('忽略空白标签', () => {
    const list = [mk(1, 'A', 'x', ['宽带', '  ', ''])];
    expect(tagDistribution(list)).toHaveLength(1);
  });

  it('没有标签时返回空数组，不返回 NaN 占比', () => {
    expect(tagDistribution([mk(1, 'A', 'x')])).toEqual([]);
  });
});

describe('buildInsights — 汇总', () => {
  it('riskyPairCount 只数「重合偏高」那一档，不把中等重合也算成待处理', () => {
    const same = '广州移动宽带300M每月79元包含20G全国流量送来电显示功能';
    const r = buildInsights([mk(1, 'A', same), mk(2, 'B', same)]);
    expect(r.total).toBe(2);
    expect(r.riskyPairCount).toBe(1);
    expect(r.pairs[0].level).toBe('risky');
  });

  it('空库给出全零结果而不是抛错', () => {
    const r = buildInsights([]);
    expect(r).toMatchObject({ total: 0, riskyPairCount: 0, pairs: [], tags: [], scanned: 0 });
  });
});
