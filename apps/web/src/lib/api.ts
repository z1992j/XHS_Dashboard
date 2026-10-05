import { VISION_BODY_SAFE_LIMIT } from './image';

export interface Material {
  id: number;
  title: string;
  content: string;
  tags: string[];
  imageData?: string;
  imageUrl?: string;
  images?: string[];
  hasImage?: boolean;
  prompt: string;
  createdAt: string;
}

/** Every image attached to a material, cover first, with no duplicates. */
export function galleryOf(m: Pick<Material, 'images' | 'imageUrl' | 'imageData'>): string[] {
  const list = [...(m.images || [])];
  const cover = m.imageUrl || m.imageData;
  if (cover && !list.includes(cover)) list.unshift(cover);
  return list;
}

/**
 * 按码点截断。
 *
 * String.prototype.slice 按 UTF-16 码元切，一个 emoji 占两个码元 ——
 * 切在中间会留下孤立代理项，JSON.stringify 编成 \udXXX 后，
 * 严格的 JSON 解析器（上游就是）会直接 400。小红书文案里 emoji 极多。
 */
export function truncate(text: string | null | undefined, max: number): string {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const points = [...s];
  return points.length <= max ? s : points.slice(0, max).join('');
}

export interface GeneratedNote {
  title: string;
  content: string;
  tags: string[];
}

// --- Auth token management ---
// The backend only enforces a token when API_TOKEN is set in its environment.
// The client always sends one if the user has stored it, so turning protection
// on server-side needs no frontend deploy.
const TOKEN_KEY = 'xhs_api_token';

export const AUTH_REQUIRED_EVENT = 'xhs:auth-required';

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

export function setToken(token: string) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch { /* private mode — the token simply will not persist */ }
}

export function clearToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch { /* nothing to clean up */ }
}

export function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Check a token against the server without touching the DB or the AI provider. */
export async function validateToken(token?: string): Promise<boolean> {
  const candidate = token ?? getToken();
  try {
    const res = await fetch('/api/xhs/verify', {
      headers: candidate ? { Authorization: `Bearer ${candidate}` } : {},
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

export interface ServerCapabilities {
  authRequired: boolean;
  gallery: boolean;
  vision: boolean;
  styleProfile: boolean;
  styleMinSamples: number;
  templateSync: boolean;
  visionModel: string | null;
  visionProvider: string;
  visionUsingDefault: boolean;
  textModel: string;
  /** 服务器 .env 里钉死了 XHS_AI_MODEL —— 推代码改不动它，只能人工改 */
  textModelPinned: boolean;
  /**
   * /health 是否真的答了。
   *
   * 没有这一位，「连不上」和「连上了但功能都没开」在界面上是同一张脸 ——
   * 回落值把所有开关都置 false，工作台首页据此会报出一排"未开启"，
   * 而真实原因是后端没起来。探活这件事本身要能被看见。
   */
  reachable: boolean;
}

/**
 * 服务端能力位。前端据此决定显示哪些入口 ——
 * 没配视觉模型时「从图片生成」整体不出现，而不是点了才报错。
 */
export async function fetchCapabilities(): Promise<ServerCapabilities> {
  const fallback: ServerCapabilities = {
    authRequired: false, gallery: false, vision: false, styleProfile: false,
    styleMinSamples: 20, templateSync: false,
    visionModel: null, visionProvider: '', visionUsingDefault: false,
    textModel: '', textModelPinned: false,
    reachable: false,
  };
  try {
    const res = await fetch('/api/xhs/health');
    if (!res.ok) return fallback;
    const d = await res.json();
    return {
      authRequired: !!d?.authRequired,
      gallery: !!d?.gallery,
      vision: !!d?.vision,
      styleProfile: !!d?.styleProfile,
      styleMinSamples: Number(d?.styleMinSamples) || 20,
      templateSync: !!d?.templateSync,
      visionModel: d?.visionModel ?? null,
      visionProvider: String(d?.visionProvider || ''),
      visionUsingDefault: !!d?.visionUsingDefault,
      textModel: String(d?.textModel || ''),
      textModelPinned: !!d?.textModelPinned,
      reachable: true,
    };
  } catch {
    return fallback;
  }
}

// --- Unified fetch with auth + error handling ---
let lastAiQuota: { limit: number; remaining: number } | null = null;
let lastVisionQuota: { limit: number; remaining: number } | null = null;

export function getAiQuota() {
  return lastAiQuota;
}

/** 读图配额和文案配额是两个桶，界面要分开显示。 */
export function getVisionQuota() {
  return lastVisionQuota;
}

async function apiFetch(url: string, options?: RequestInit): Promise<Response> {
  const headers: Record<string, string> = {
    ...(options?.headers as Record<string, string>),
    ...authHeaders(),
  };

  let res: Response;
  try {
    res = await fetch(url, { ...options, headers });
  } catch {
    // fetch 抛异常时拿不到状态码，但请求体过大是最常见的原因：
    // 反向代理（nginx 默认 client_max_body_size 只有 1MB）会直接断连，
    // 浏览器只看到一个网络错误。笼统说「检查网络」会把人引向错误方向。
    const bodySize = typeof options?.body === 'string' ? options.body.length : 0;
    if (bodySize > VISION_BODY_SAFE_LIMIT) {
      throw new Error(
        `请求体过大（约 ${Math.round(bodySize / 1024)}KB），被服务器或反向代理拒绝。` +
        '请减少图片数量或换更小的图片。'
      );
    }
    throw new Error('网络连接失败，请检查网络');
  }

  if (res.status === 401) {
    clearToken();
    // Ask the shell to collect a token rather than reloading, which would loop
    // forever when the server has auth on and the browser has no token.
    window.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT));
    throw new Error('需要访问令牌，请在弹窗中填写');
  }

  const limit = res.headers.get('X-RateLimit-Limit');
  const remaining = res.headers.get('X-RateLimit-Remaining');
  if (limit !== null && remaining !== null) {
    lastAiQuota = { limit: Number(limit), remaining: Number(remaining) };
  }

  const vLimit = res.headers.get('X-Vision-Limit');
  const vRemaining = res.headers.get('X-Vision-Remaining');
  if (vLimit !== null && vRemaining !== null) {
    lastVisionQuota = { limit: Number(vLimit), remaining: Number(vRemaining) };
  }

  return res;
}

async function apiJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await apiFetch(url, options);
  const data = await res.json().catch(() => {
    throw new Error(`请求失败 (${res.status})`);
  });
  // /ai/vision 为了防止反向代理的空闲超时提前断连，慢操作开始前就把状态码
  // 提交成了 200（之后靠周期性心跳保活），成功与否只能看响应体里有没有
  // error 字段，不能再单看 res.ok。这里放宽判断对其它接口没有影响——它们的
  // 错误响应从来都是状态码和 error 字段一起给的，res.ok 已经是 false。
  const hasBodyError = !!data && typeof data === 'object' && data.error != null;
  if (!res.ok || hasBodyError) {
    const msg = typeof data?.error === 'string' ? data.error : data?.error?.message || `请求失败 (${res.status})`;
    // 上游自己的解释（若有）拼在后面 —— 自建工具里看报错的人就是持有 key 的人，
    // 藏起来只会让排障多绕几圈。
    const detail = typeof data?.error === 'object' ? data.error?.detail : '';
    const model = typeof data?.error === 'object' ? data.error?.model : '';
    const suffix = [detail, model ? `模型：${model}` : ''].filter(Boolean).join('　·　');
    throw new Error(suffix ? `${msg}\n\n上游返回：${suffix}` : msg);
  }
  return data as T;
}

export interface MaterialListResult {
  data: Material[];
  total: number;
  page: number;
  pageSize: number;
}

export interface MaterialPayload {
  title: string;
  content: string;
  tags: string[];
  imageData?: string;
  images?: string[];
  prompt: string;
}

export interface TagCount {
  name: string;
  count: number;
}

export const materialsApi = {
  list: (query?: string): Promise<MaterialListResult> =>
    apiJson<MaterialListResult>(`/api/xhs/materials${query ? '?' + query : ''}`),

  get: (id: number): Promise<Material> =>
    apiJson(`/api/xhs/materials/${id}`),

  /** All tags across the library, not just the ones on the loaded page. */
  tags: (): Promise<{ data: TagCount[] }> =>
    apiJson('/api/xhs/materials/tags'),

  create: (data: MaterialPayload): Promise<{ id: number }> =>
    apiJson('/api/xhs/materials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),

  update: (id: number, data: MaterialPayload): Promise<{ ok: boolean }> =>
    apiJson(`/api/xhs/materials/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),

  delete: (id: number): Promise<void> =>
    apiJson(`/api/xhs/materials/${id}`, { method: 'DELETE' }).then(() => undefined),

  batchDelete: (ids: number[]): Promise<{ deleted: number }> =>
    apiJson('/api/xhs/materials/batch-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    }),

  extractNote: (url: string): Promise<{ title: string; content: string; tags: string[]; images?: string[] }> =>
    apiJson('/api/xhs/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    }),
};

// --- 自定义模板云端副本 ---
export interface RemoteTemplate {
  id: string;
  name: string;
  icon: string;
  description: string;
  systemPrompt: string;
  isCustom: true;
  updatedAt: string;
}

export const templatesApi = {
  list: (): Promise<{ data: RemoteTemplate[]; available: boolean }> =>
    apiJson('/api/xhs/templates'),

  /** 按 id upsert：前端生成的 id 直接用，两边不需要做映射。 */
  upsert: (t: { id: string; name: string; icon: string; description: string; systemPrompt: string }): Promise<{ ok: boolean }> =>
    apiJson(`/api/xhs/templates/${encodeURIComponent(t.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(t),
    }),

  remove: (id: string): Promise<{ ok: boolean }> =>
    apiJson(`/api/xhs/templates/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};

/* 上传文件回收的客户端封装（uploads-orphans / uploads-sweep）删掉了：
   它唯一的调用方是设置页，设置页在 #48 已删。服务端两个路由仍然保留 ——
   用 curl 可以手动触发，XHS_UPLOAD_SWEEP=1 的每日自动清理也照常跑。 */

// --- 看图成文 ---
export interface VisionFact {
  key: string;
  value: string;
  confidence: 'high' | 'low';
}

export interface VisionResult {
  scene: string;
  hasText: boolean;
  facts: VisionFact[];
  warnings: string[];
  imagesRead?: number;
  quotaRemaining?: number;
  quotaLimit?: number;
}

export interface StyleProfile {
  开头习惯: string[];
  句长节奏: string;
  emoji: { 密度: string; 位置: string };
  自称: string;
  高频标签: string[];
  结尾习惯: string[];
  口头禅: string[];
  避免: string[];
}

export interface StyleProfileState {
  profile: StyleProfile | null;
  updatedAt: string | null;
  sampleCount: number;
  minSamples: number;
  ready: boolean;
  cacheAvailable: boolean;
}

export interface StyleExample {
  id: number;
  title: string;
  content: string;
  tags: string[];
  score: number;
}

export const visionApi = {
  /**
   * 读图取事实。每项只能是 data URL 或 /api/xhs/uploads/ 路径。
   * 多张图会合并成一次调用 —— 套餐信息常常跨几张，模型同时看到才能对账，
   * 而且按张计费的情况下提示词和回复只付一次。
   */
  read: (images: string[]): Promise<VisionResult> =>
    apiJson('/api/xhs/ai/vision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images }),
    }),
};

// 风格画像的本地兜底缓存。
//
// 服务端只有在执行过 migrations/002 后才会持久化画像；没执行时
// POST /style/profile 仍会算出结果返回给你，但 schemaFlags.hasStyleTable
// 为 false，那次 INSERT 直接被跳过 —— 刷新页面后画像就"凭空消失"了，
// 用户看到的是「每次分析完都没保存」。
//
// 和自定义模板同样的思路：localStorage 当渲染缓存，服务端当持久副本，
// 服务端没建表时退化为纯本地存储，功能依旧可用。
const STYLE_CACHE_KEY = 'xhs_style_profile_cache';

interface StyleCache {
  profile: StyleProfile;
  sampleCount: number;
  updatedAt: string;
}

function readStyleCache(): StyleCache | null {
  try {
    const raw = localStorage.getItem(STYLE_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeStyleCache(profile: StyleProfile, sampleCount: number) {
  try {
    localStorage.setItem(STYLE_CACHE_KEY, JSON.stringify({
      profile, sampleCount, updatedAt: new Date().toISOString(),
    } satisfies StyleCache));
  } catch { /* 存不下就算了，最多下次要重新点一次分析 */ }
}

export const styleApi = {
  get: async (): Promise<StyleProfileState> => {
    try {
      const server = await apiJson<StyleProfileState>('/api/xhs/style/profile');
      // 服务端有画像就以它为准；没有且这台服务器本来就存不住（未建表）时，
      // 用本地缓存兜底，而不是让用户以为画像丢了。
      if (!server.profile && !server.cacheAvailable) {
        const cached = readStyleCache();
        if (cached) {
          return { ...server, profile: cached.profile, sampleCount: cached.sampleCount, updatedAt: cached.updatedAt };
        }
      }
      return server;
    } catch (e) {
      // 请求本身失败时（网络抖动等），本地缓存至少能让「我的风格」开关正常出现，
      // 而不是整个消失不见。
      const cached = readStyleCache();
      if (cached) {
        return {
          profile: cached.profile, sampleCount: cached.sampleCount, updatedAt: cached.updatedAt,
          minSamples: 20, ready: true, cacheAvailable: false,
        };
      }
      throw e;
    }
  },

  /** 不带参数 = 重新蒸馏；带 profile = 手工覆盖。 */
  rebuild: async (profile?: StyleProfile): Promise<{ profile: StyleProfile; sampleCount?: number; cached: boolean }> => {
    const result = await apiJson<{ profile: StyleProfile; sampleCount?: number; cached?: boolean }>(
      '/api/xhs/style/profile',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(profile ? { profile } : {}),
      }
    );
    // 不管服务端建没建表都先落一份本地缓存 —— 这样即使 migrations/002
    // 没执行，刷新页面也能看到刚分析出来的画像，不用重新跑一次蒸馏。
    writeStyleCache(result.profile, result.sampleCount ?? 0);
    return { ...result, cached: !!result.cached };
  },

  examples: (keywords: string[], limit = 3): Promise<{ data: StyleExample[]; matched: boolean }> =>
    apiJson(`/api/xhs/style/examples?keywords=${encodeURIComponent(keywords.join(','))}&limit=${limit}`),
};

export interface HistoryItem {
  id: number;
  prompt: string;
  sourceUrl?: string;
  results?: GeneratedNote[];
  createdAt: string;
}

export const historyApi = {
  list: (): Promise<HistoryItem[]> =>
    apiJson('/api/xhs/history'),

  get: (id: number): Promise<HistoryItem> =>
    apiJson(`/api/xhs/history/${id}`),

  create: (data: { prompt: string; results: GeneratedNote[]; sourceUrl?: string }): Promise<{ id: number }> =>
    apiJson('/api/xhs/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),

  delete: (id: number): Promise<{ ok: boolean }> =>
    apiJson(`/api/xhs/history/${id}`, { method: 'DELETE' }),

  clear: (): Promise<{ deleted: number }> =>
    apiJson('/api/xhs/history', { method: 'DELETE' }),
};

const DEFAULT_SYSTEM_PROMPT =
  '你是一个小红书爆款文案仿写专家。你的核心能力是：接收一篇原始小红书帖子，在保留所有关键事实信息（运营商名称、带宽规格、费用金额、套餐内容、优惠条件等）的前提下，改写文字表达方式，增加emoji提升可读性，确保内容不被平台识别为抄袭或重复。你必须精准识别并保留原文中的所有话题标签（#开头的标签）。';

export async function rewriteNote(
  prompt: string,
  imageDesc?: string,
  systemPrompt?: string,
  styleProfile?: StyleProfile | null,
): Promise<GeneratedNote> {
  // 「我的风格」对原文仿写同样适用 —— 之前只接在看图成文那条路上，
  // 用户在仿写页开了开关却毫无效果。
  const styleBlock = profileToPrompt(styleProfile ?? null);
  const userPrompt = systemPrompt
    ? `把下面这篇小红书帖子用你自己的话重新写一遍。

原文：
${prompt}
${imageDesc ? `\n配图说明：${imageDesc}` : ''}

${styleBlock ? styleBlock + '\n' : ''}
硬性要求（违反会被系统拒绝）：
- 原文里的所有事实信息必须保留：运营商名称、带宽规格、费用金额、套餐明细、优惠条件、联系方式，一个不漏
- title≤20字（含emoji）、content≤1000字、tags≤10个
- 标题不要带#号
- content里不要放话题标签，标签只放tags数组
- 原文的#标签原样保留到tags里，没标签就根据内容生成3-5个

写法要求（决定文案质量）：
- 标题：抓眼球但像人写的，可以用数字+结论、反常识、省钱提示，加1-2个emoji
- 正文：像你真的用过/办过，在跟朋友聊天分享。产品信息自然穿插在你的经历和感受里，不要列清单式堆砌
- 开头直接切入（一句话抓住注意力），不要铺垫背景
- 中间把干货说清楚，但用聊天的语气不是说明书
- 结尾随性一点，不要"综上所述"式总结
- emoji点缀在该出现的地方就好，不要每行开头都放emoji当小标题
- 句子长短交替：长句说完信息，短句给节奏感
- 关键：写出来要让人觉得是真人发的帖子，不是AI生成的

严格按JSON输出（只输出JSON）：
{
  "title": "仿写标题",
  "content": "仿写正文",
  "tags": ["标签1", "标签2"]
}`
    : `请帮我仿写以下小红书帖子。

原文：
${prompt}
${imageDesc ? `\n配图说明：${imageDesc}` : ''}

${styleBlock ? styleBlock + '\n' : ''}
仿写要求：
1. 标题：参考原文标题的核心卖点，用小红书爆款句式重新表达（数字+痛点 / 反常识+悬念 / 省钱+结论），可加1-2个emoji，**严格控制在20字以内（含emoji）**，标题中不要使用#号
2. 正文：
   - 必须保留原文中的所有关键事实信息（运营商、带宽、费用金额、套餐明细、优惠条件、联系方式等），不得遗漏或篡改
   - 文字表达稍作修改，换一种说法表达相同意思
   - 增加emoji表情做结构化排版，提升可阅读性
   - 口语化真实感，痛点开头→套餐干货中段→互动结尾
   - **正文总字数严格控制在1000字以内**，信息密度要高，避免废话
   - 目标：避免被平台识别为抄袭重复内容
3. 话题标签：必须完整提取原文中所有 # 开头的标签，原样保留不要修改标签内容，如果原文没有标签则根据内容生成3-5个相关标签。**标签总数不超过10个**。注意：tags数组中的标签不要带#号前缀，只写标签文字
4. 重要：正文content中不要包含话题标签（#xxx），标签只放在tags数组中，避免重复显示
5. 字数硬限制：title≤20字、content≤1000字、tags≤10个，超出会被系统截断，请严格遵守

严格按以下JSON格式输出（只输出JSON，不要其他文字）：
{
  "title": "仿写后的标题",
  "content": "仿写后的正文",
  "tags": ["原文标签1", "原文标签2", "..."]
}`;

  const data = await apiJson<{ choices?: { message: { content: string } }[]; error?: { message: string } }>('/api/xhs/ai/rewrite', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: systemPrompt || DEFAULT_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.8,
    }),
  });

  if (data.error) throw new Error(data.error.message || 'AI 服务异常');

  const raw = data.choices?.[0]?.message?.content;
  if (!raw) throw new Error('AI 未返回内容，请重试');

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('AI 返回的内容无法解析为 JSON');

  let result: GeneratedNote;
  try {
    result = JSON.parse(jsonMatch[0]) as GeneratedNote;
  } catch {
    throw new Error('AI 返回的内容无法解析为 JSON');
  }
  if (!result || typeof result.title !== 'string' || typeof result.content !== 'string') {
    throw new Error('AI 返回的内容缺少标题或正文');
  }

  result.title = result.title.replace(/#/g, '').trim();
  if ([...result.title].length > 20) result.title = [...result.title].slice(0, 20).join('');
  result.content = result.content.replace(/\s*(?:#[^\s#]+[\s]*)+$/g, '').trim();
  if ([...result.content].length > 1000) result.content = [...result.content].slice(0, 1000).join('');
  result.tags = [...new Set((Array.isArray(result.tags) ? result.tags : [])
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.replace(/^#/, '').trim())
    .filter(Boolean))].slice(0, 10);

  return result;
}

/** 把风格画像压成一段提示词。空画像返回空串，调用方据此退回预设模板。 */
export function profileToPrompt(profile: StyleProfile | null): string {
  if (!profile) return '';
  const lines: string[] = [];
  if (profile.自称) lines.push(`- 自称用「${profile.自称}」`);
  if (profile.句长节奏) lines.push(`- 句长节奏：${profile.句长节奏}`);
  if (profile.开头习惯?.length) lines.push(`- 开头习惯：${profile.开头习惯.join('；')}`);
  if (profile.结尾习惯?.length) lines.push(`- 结尾习惯：${profile.结尾习惯.join('；')}`);
  if (profile.emoji?.密度 || profile.emoji?.位置) {
    lines.push(`- emoji：${[profile.emoji.密度, profile.emoji.位置].filter(Boolean).join('，')}`);
  }
  if (profile.口头禅?.length) lines.push(`- 常用口头禅：${profile.口头禅.join('、')}`);
  if (profile.避免?.length) lines.push(`- 绝对不要用：${profile.避免.join('、')}`);
  if (!lines.length) return '';
  return `【你的写作风格（学自你已发布的文案）】\n${lines.join('\n')}`;
}

/**
 * 由确认过的事实生成文案。
 *
 * 与 rewriteNote 的关键区别：这里没有"原文"可以参照，事实是唯一的信息来源。
 * 所以提示词里最重的一条是**不许新增任何事实** —— 模型很容易顺手补一个
 * "限时优惠"或把 59 写成 58，而这些数字用户是要发出去给客户看的。
 */
export async function composeFromFacts(input: {
  facts: VisionFact[];
  scene: string;
  styleProfile?: StyleProfile | null;
  examples?: StyleExample[];
  systemPrompt?: string;
}): Promise<GeneratedNote> {
  const { facts, scene, styleProfile, examples = [], systemPrompt } = input;

  const factLines = facts.length
    ? facts.map(f => `- ${f.key}：${f.value}`).join('\n')
    : '（这张图没有读到具体的产品信息）';

  const styleBlock = profileToPrompt(styleProfile ?? null);

  const exampleBlock = examples.length
    ? `\n【你以前写过的同类文案（学语气和结构，不要照抄内容）】\n` +
      examples.map((e, i) => `示例${i + 1} 标题：${e.title}\n示例${i + 1} 正文：${truncate(e.content, 400)}`).join('\n\n')
    : '';

  const userPrompt = `根据下面这张图片的信息，写一篇小红书笔记。

【图片场景】
${scene || '（无描述）'}

【图中确认的事实 — 这是唯一的信息来源】
${factLines}
${styleBlock ? '\n' + styleBlock : ''}${exampleBlock}

【铁律 — 违反即为废稿】
- 只能使用上面列出的事实。**不许新增任何数字、价格、优惠、期限、承诺或联系方式。**
- 上面没写的，就是没有。不要"合理补充"，不要写"仅限本月""名额有限"这类图里没有的话。
- 出现的每一个数字都必须和上面完全一致，一个字符都不能差。
- 如果事实太少写不成一篇完整笔记，就写短一点，不要靠编造凑字数。

【写法】
- 标题≤20字（含emoji），抓眼球但像真人写的，不带#号
- 正文≤1000字，口语化，像跟朋友聊天，把事实自然穿插进来而不是列清单
- content 里不要放话题标签，标签只放 tags 数组
- 话题标签：生成 10 个（不要少于 10 个），从运营商、套餐类型、地区、适用人群、使用场景、
  同义/近似说法这几个角度扩展着写，让每个标签都能搭上图里的套餐信息，不要为了凑数堆砌无关词
- 写出来要像真人发的帖子，不是AI生成的

严格按JSON输出（只输出JSON）：
{
  "title": "标题",
  "content": "正文",
  "tags": ["标签1", "标签2"]
}`;

  const data = await apiJson<{ choices?: { message: { content: string } }[]; error?: { message: string } }>(
    '/api/xhs/ai/rewrite',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: systemPrompt || DEFAULT_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.8,
      }),
    }
  );

  if (data.error) throw new Error(data.error.message || 'AI 服务异常');
  const raw = data.choices?.[0]?.message?.content;
  if (!raw) throw new Error('AI 未返回内容，请重试');

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('AI 返回的内容无法解析为 JSON');

  let result: GeneratedNote;
  try {
    result = JSON.parse(jsonMatch[0]) as GeneratedNote;
  } catch {
    throw new Error('AI 返回的内容无法解析为 JSON');
  }
  if (!result || typeof result.title !== 'string' || typeof result.content !== 'string') {
    throw new Error('AI 返回的内容缺少标题或正文');
  }

  result.title = result.title.replace(/#/g, '').trim();
  if ([...result.title].length > 20) result.title = [...result.title].slice(0, 20).join('');
  result.content = result.content.replace(/\s*(?:#[^\s#]+[\s]*)+$/g, '').trim();
  if ([...result.content].length > 1000) result.content = [...result.content].slice(0, 1000).join('');
  result.tags = [...new Set((Array.isArray(result.tags) ? result.tags : [])
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.replace(/^#/, '').trim())
    .filter(Boolean))].slice(0, 10);

  return result;
}
