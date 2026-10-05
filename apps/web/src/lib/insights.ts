/**
 * 素材库洞察。
 *
 * 产品的核心承诺是「避免被平台判定为重复内容」，但此前只在**单篇生成时**
 * 拿结果跟原文比过一次。素材库整体从来没人看过 —— 库里可能早就躺着两篇
 * 高度雷同的旧文案，而那同样会触发同账号重复限流。这里把视角从「这一篇」
 * 抬到「整个库」。
 *
 * 全部是纯函数，不碰 DOM、不发请求，便于按行为测试。
 */
import { similarityScore, describeSimilarity, type SimilarityLevel } from './similarity';
import type { Material } from './api';

/**
 * 两两比对是 O(n²)。29 篇是 406 次，可以忽略；但素材会一直涨，
 * 上千篇就是 50 万次比对，足以把主线程卡住几秒。
 * 超过这个数就只比最近的 N 篇 —— 老素材之间的重合早就没有发布价值了。
 */
export const MAX_PAIR_SCAN = 120;

/** 只报告达到「仍有重合」及以上的配对，低于这条线的噪音没有意义。 */
export const PAIR_REPORT_THRESHOLD = 30;

export interface DuplicatePair {
  a: { id: number; title: string };
  b: { id: number; title: string };
  score: number;
  level: SimilarityLevel;
  label: string;
}

/**
 * 找出库内内容最接近的若干对素材。
 *
 * 比的是正文，不含标题 —— 标题短、套路化，两篇不相干的笔记也常常撞标题，
 * 拿它算重合会把误报刷满。
 */
export function findDuplicatePairs(materials: Material[], limit = 5): DuplicatePair[] {
  const scope = materials.slice(0, MAX_PAIR_SCAN);
  const pairs: DuplicatePair[] = [];

  for (let i = 0; i < scope.length; i++) {
    for (let j = i + 1; j < scope.length; j++) {
      const score = similarityScore(scope[i].content, scope[j].content);
      if (score < PAIR_REPORT_THRESHOLD) continue;
      const verdict = describeSimilarity(score);
      pairs.push({
        a: { id: scope[i].id, title: scope[i].title },
        b: { id: scope[j].id, title: scope[j].title },
        score,
        level: verdict.level,
        label: verdict.label,
      });
    }
  }

  return pairs.sort((x, y) => y.score - x.score).slice(0, limit);
}

export interface TagStat {
  name: string;
  count: number;
  /** 占比 0–100，用于条形图长度 */
  percent: number;
}

/**
 * 标签使用频次，按次数降序。
 *
 * 用途很直接：下一篇该打什么标签，看这个比凭记忆准。
 * percent 以**最高频标签**为基准而不是总数 —— 条形图要的是相对长度，
 * 用总数当分母会让所有条都挤在左边一小截。
 */
export function tagDistribution(materials: Material[], limit = 8): TagStat[] {
  const counts = new Map<string, number>();
  for (const m of materials) {
    const tags = Array.isArray(m.tags) ? m.tags : [];
    // 同一篇里重复出现的标签只算一次，否则一篇文案就能把某个标签刷上榜
    for (const t of new Set(tags.map(x => String(x).trim()).filter(Boolean))) {
      counts.set(t, (counts.get(t) || 0) + 1);
    }
  }

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  const max = sorted.length ? sorted[0][1] : 0;
  return sorted.map(([name, count]) => ({
    name,
    count,
    percent: max ? Math.round((count / max) * 100) : 0,
  }));
}

export interface LibraryInsights {
  total: number;
  /** 达到「重合偏高」的配对数 —— 这是真正需要处理的数量 */
  riskyPairCount: number;
  pairs: DuplicatePair[];
  tags: TagStat[];
  /** 参与两两比对的实际篇数，超过上限时用于如实说明「只比了最近 N 篇」 */
  scanned: number;
}

export function buildInsights(materials: Material[]): LibraryInsights {
  const pairs = findDuplicatePairs(materials);
  return {
    total: materials.length,
    riskyPairCount: pairs.filter(p => p.level === 'risky').length,
    pairs,
    tags: tagDistribution(materials),
    scanned: Math.min(materials.length, MAX_PAIR_SCAN),
  };
}
