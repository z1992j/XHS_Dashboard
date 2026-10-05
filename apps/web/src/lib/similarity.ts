/**
 * 与原文的相似度评分。
 *
 * 产品的核心承诺是「降低与原文的相似度，避免被判定为重复内容」，
 * 但此前从未把这件事量化给用户看过。这里用字符二元组（bigram）的
 * Dice 系数给出一个 0–100 的分数：中文没有天然词边界，二元组比分词
 * 更稳，也不需要引入任何依赖。
 *
 * 分数越低说明改写得越彻底。
 */

/** 去掉空白、标点、话题标签，只留下有信息量的字符。 */
export function normalizeForCompare(text: string): string {
  return (text || '')
    .replace(/#[^#\s]+#?/g, ' ')            // 话题标签不参与比对
    .replace(/https?:\/\/\S+/g, ' ')        // 链接同理
    .replace(/[\s　]+/g, '')            // 空白（含全角空格）
    .replace(/[，。！？、；：""''（）《》…—·,.!?;:"'()<>[\]{}~`|/\\@#$%^&*_+=-]/g, '')
    .toLowerCase();
}

function bigrams(text: string): Map<string, number> {
  const out = new Map<string, number>();
  const chars = [...text];
  for (let i = 0; i < chars.length - 1; i++) {
    const g = chars[i] + chars[i + 1];
    out.set(g, (out.get(g) || 0) + 1);
  }
  return out;
}

/**
 * 返回 0–100 的相似度。100 表示完全相同，0 表示没有任何二元组重合。
 * 任一侧内容过短（不足 2 个有效字符）时返回 0，避免给出无意义的高分。
 */
export function similarityScore(original: string, rewritten: string): number {
  const a = normalizeForCompare(original);
  const b = normalizeForCompare(rewritten);
  if ([...a].length < 2 || [...b].length < 2) return 0;

  const ga = bigrams(a);
  const gb = bigrams(b);

  let overlap = 0;
  let totalA = 0;
  let totalB = 0;
  for (const n of ga.values()) totalA += n;
  for (const n of gb.values()) totalB += n;
  for (const [g, n] of ga) {
    const m = gb.get(g);
    if (m) overlap += Math.min(n, m);
  }
  if (totalA + totalB === 0) return 0;

  return Math.round((2 * overlap * 100) / (totalA + totalB));
}

export type SimilarityLevel = 'good' | 'fair' | 'risky';

export interface SimilarityVerdict {
  score: number;
  level: SimilarityLevel;
  label: string;
  hint: string;
}

/**
 * 把分数翻译成用户能直接决策的一句话。
 * 阈值参考平台查重的普遍经验：三成以下基本安全，过半需要重写。
 */
export function describeSimilarity(score: number): SimilarityVerdict {
  if (score < 30) {
    return {
      score,
      level: 'good',
      label: '改写充分',
      hint: '与原文重合度低，可以直接发布',
    };
  }
  if (score < 50) {
    return {
      score,
      level: 'fair',
      label: '仍有重合',
      hint: '建议再改几句表达，或换一个模板重新生成',
    };
  }
  return {
    score,
    level: 'risky',
    label: '重合偏高',
    hint: '与原文过于接近，有被判定为重复内容的风险',
  };
}
