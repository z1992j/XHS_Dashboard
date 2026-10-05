const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

// Optional middleware — won't crash if not yet installed
let compression = null;
let helmet = null;
try { compression = require('compression'); } catch {}
try { helmet = require('helmet'); } catch {}

// ====== Configuration ======
const CONFIG = {
  uploadDir: process.env.XHS_UPLOAD_DIR || '/var/www/xhs-writer/uploads',
  aiRateMax: 10,
  aiRateWindow: 60000,       // 1 minute
  aiRateCleanup: 600000,     // 10 minutes
  writeRateMax: 60,          // mutations per window, per token/IP
  bodyLimit: '2mb',
  batchDeleteMax: 100,
  aiTimeout: 60000,          // 60s timeout for AI upstream
  imageMaxSize: 10 * 1024 * 1024, // 10MB image download limit
  imageConcurrency: 4,       // parallel image downloads
  maxGalleryImages: 9,       // XHS caps a note at 9 images
  xhsMaxHops: 5,             // 短链 → 笔记页 → (登录墙) 实测最多两跳，留足余量
  xhsLinkTimeout: 15000,     // 解析短链的每一跳
  xhsPageTimeout: 20000,     // 请求笔记页的每一跳
  defaultPageSize: 20,
  maxPageSize: 100,
  schemaRecheck: 300000,     // re-probe optional columns every 5 min until found
  visionRateMax: 5,          // vision calls per window — pricier than text, so a tighter bucket
  visionTimeout: 90000,      // reading an image takes longer than generating text
  // 反向代理的读超时通常是几十秒（nginx 默认 60s），比 visionTimeout 短。
  // 在等上游模型回复期间如果连接上一直没有字节流出，代理会当成空闲连接断掉，
  // 浏览器只能看到一个无从下手的网络错误。这个间隔要明显短于常见代理超时。
  visionHeartbeatMs: 15000,
  visionMaxBytes: 4 * 1024 * 1024, // upper bound on the image handed to the provider
  visionMaxImages: 4,        // per call — plan details often span a couple of shots,
                             // but every extra image is billed, so this is not the gallery's 9
  styleMinSamples: 20,       // below this a style profile would just mimic a handful of notes
  styleMaxSamples: 60,       // how many notes the distiller reads at most
  // Hard ceiling on the distillation prompt. /ai/rewrite already caps every
  // message at 20000 chars and works; the distiller used to build an unbounded
  // corpus that reached ~39000 chars and got rejected upstream — which surfaced
  // to the user as the useless "AI 服务暂时不可用".
  styleMaxChars: 12000,
  styleExcerptChars: 300,    // enough to hear someone's voice; more is waste
  styleExampleCount: 3,      // exemplars attached to one generation
};

// ====== Version fingerprint ======
// deploy-server.yml 每次部署会把 GITHUB_SHA 写入 ../VERSION，供监测系统
// 比对线上代码与仓库最新提交，及时发现部署滞后（版本漂移）。
function readVersionFile(filePath) {
  const file = filePath || process.env.XHS_VERSION_FILE || path.join(__dirname, '..', 'VERSION');
  try {
    return fsSync.readFileSync(file, 'utf8').trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

const ENDPOINTS = {
  dashscope: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
  deepseek: 'https://api.deepseek.com/chat/completions',
  openai: 'https://api.openai.com/v1/chat/completions',
};

// Turn an upstream HTTP status into something the operator can act on.
//
// Every upstream failure used to collapse into "AI 服务暂时不可用", with the real
// reason only in the server log. For a self-hosted tool the person seeing that
// message is the same person who owns the API key — telling them "unavailable"
// when the truth is "out of balance" or "prompt too long" just wastes their time.
// The status code is included so a bug report can name it; the upstream body is
// still never echoed back.
// Pull the provider's own explanation out of an error body.
//
// CLAUDE.md says detailed errors go to the log only, and for anything a visitor
// sees that still holds. But this tool is self-hosted: the person staring at
// "AI 服务拒绝了这次请求（400）" owns the API key, and hiding the provider's
// sentence from them turned one bug into three rounds of guessing. So the
// provider's message comes back too — scrubbed of anything key-shaped, capped,
// and never the raw body.
function extractUpstreamDetail(bodyText) {
  if (!bodyText) return '';
  let msg = '';
  try {
    const parsed = JSON.parse(bodyText);
    msg = parsed?.error?.message || parsed?.message || '';
  } catch {
    msg = '';
  }
  if (!msg) msg = String(bodyText).replace(/\s+/g, ' ').trim();
  return msg
    // Never echo anything that looks like a credential back to the browser.
    .replace(/\b(sk|xai|gsk)-[A-Za-z0-9_-]{8,}/gi, '<redacted>')
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '<redacted>')
    .slice(0, 300)
    // 自己也别把半个 emoji 回传给浏览器
    .replace(LONE_SURROGATE, '');
}

/**
 * 转义 LIKE 模式里的通配符。
 *
 * 搜索词是直接拼进 `%...%` 的，用户输入的 % 和 _ 会被当成通配符 ——
 * 搜一个 % 就能匹配整库，搜 "3_0" 会连 "300" 一起命中。参数化只防了
 * 注入，防不住这个。反斜杠必须第一个换，否则会把后面新加的转义符再转一遍。
 */
function escapeLikePattern(text) {
  return String(text ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}

function upstreamErrorMessage(status, what = 'AI 服务') {
  if (status === 400) return `${what}拒绝了这次请求（400），通常是内容过长或参数不被该模型接受`;
  if (status === 401) return `${what} API Key 无效或已失效（401），请检查服务端配置`;
  if (status === 403) return `${what} API Key 没有调用该模型的权限（403）`;
  if (status === 402) return `${what}账户余额不足（402），请充值后重试`;
  if (status === 404) return `${what}找不到该模型（404），请检查模型名是否正确`;
  if (status === 413) return `${what}判定请求体过大（413），请减少素材量后重试`;
  if (status === 429) return `${what}触发了上游限流（429），请稍后重试`;
  if (status >= 500) return `${what}上游异常（${status}），请稍后重试`;
  return `${what}调用失败（${status}）`;
}

// ====== Text model (copywriting) ======
function textConfig() {
  return {
    provider: process.env.XHS_AI_PROVIDER || 'deepseek',
    key: process.env.XHS_AI_KEY || '',
    model: process.env.XHS_AI_MODEL || 'deepseek-chat',
  };
}

// ====== Vision model (reading images) ======
// Deliberately provider-agnostic: every endpoint above speaks the same
// OpenAI-compatible chat-completions dialect, and the vision message format
// (content as an array of text/image_url parts) is shared across all of them.
// So whichever key gets filled in later works with no code change.
//
// The whole feature stays invisible until XHS_VISION_KEY is set — falling back
// to the text key would silently send images to a model that cannot read them.
// The MODEL is the switch, not the key.
//
// Whether images can be read is a property of the model, and which models are
// multimodal changes on the providers' schedule, not ours — so nothing here
// hardcodes a guess about who can see. Naming a model is the opt-in; when the
// vision provider/key are left blank they fall back to the copywriting config,
// so pointing at a multimodal model from the same provider needs one line and
// no second API key.
// A model name is not a credential, so it belongs in code, not in a .env file
// the deploy pipeline never ships. Requiring one there meant "push the code and
// the feature works" was false for this feature alone — you had to SSH in.
//
// These are per-provider, never cross-provider: pointing a DeepSeek key at
// Qwen's model would be a guaranteed failure, but pointing a DeepSeek key at
// DeepSeek's own vision model is the same account and the same endpoint.
//
// 每个 provider 给的是一条候选链，不是单个型号。原因是 DeepSeek 在
// 2026-09-10 发布了原生多模态的 V4.1 Flash，并公告把 V4 Pro 的请求整体
// 路由过去——稳定别名 deepseek-chat 因此会自动吃到这次升级；而
// deepseek-v4-flash-vision-exp 是 V4.1 Flash 之前的实验性过渡分支
// （名字里的 -exp 就是这个意思），正式版发布后随时可能下线。
// 一旦下线，读图会以"模型不存在"的形式静默失败，而这个功能刚刚才可用。
//
// 所以：首选仍然是当前实测可用的型号，上游一旦回"不认识这个模型"，
// 自动降级到稳定别名重试一次，跨过这次型号更替不需要任何人工介入。
//
// 刻意不写死 deepseek-v4.1-flash-expires-on-0910 这类内测 ID —— 它按名字
// 就在 09-10 当天过期，写进代码等于埋一颗定时炸弹。要指定具体型号，
// 用 XHS_VISION_MODEL 环境变量，随时可改且不用改代码。
const DEFAULT_VISION_MODELS = {
  deepseek: ['deepseek-v4-flash-vision-exp', 'deepseek-chat'],
  dashscope: ['qwen-vl-max'],
  openai: ['gpt-4o'],
};

// Opt out without editing code: XHS_VISION_MODEL=off
const VISION_OFF = new Set(['off', 'none', 'false', 'disabled', '0']);

function visionConfig() {
  const provider = process.env.XHS_VISION_PROVIDER || process.env.XHS_AI_PROVIDER || 'deepseek';
  const explicit = (process.env.XHS_VISION_MODEL || '').trim();
  const disabled = VISION_OFF.has(explicit.toLowerCase());
  // 显式指定就只用这一个 —— 人写死了型号就是要它，不该背着人再去试别的。
  // 没指定才走候选链，让默认值自己扛过型号更替。
  const models = disabled ? [] : (explicit ? [explicit] : (DEFAULT_VISION_MODELS[provider] || []));
  return {
    provider,
    key: process.env.XHS_VISION_KEY || process.env.XHS_AI_KEY || '',
    // model 是首选型号，健康检查和报错提示都显示它；models 是完整候选链。
    model: models[0] || '',
    models,
    disabled,
    // True when nothing was configured and the provider's default kicked in —
    // the UI says so, because a default is a guess about the account's access.
    usingDefault: !disabled && !explicit && !!DEFAULT_VISION_MODELS[provider],
  };
}

function visionEnabled() {
  const cfg = visionConfig();
  return !!(cfg.model && cfg.key && ENDPOINTS[cfg.provider]);
}

// Domain whitelist for image downloads (SSRF prevention).
// Suffix-exact match: allows the domain itself and any subdomain,
// rejects lookalikes such as "sns-img.evil.com" or "fakexhscdn.com".
const IMAGE_DOMAIN_WHITELIST = [
  'xiaohongshu.com',
  'xhscdn.com',
];

function isAllowedImageDomain(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return IMAGE_DOMAIN_WHITELIST.some(d => hostname === d || hostname.endsWith('.' + d));
  } catch {
    return false;
  }
}

// Domains the note extractor is allowed to fetch.
// The check MUST parse the URL and compare the hostname: a substring test on the
// whole URL lets `http://169.254.169.254/?ref=xiaohongshu.com` through and turns
// this endpoint into an SSRF probe against the private network.
const NOTE_DOMAIN_WHITELIST = [
  'xiaohongshu.com',
  'xhslink.com',
  'xhslink.cn',
];

function isAllowedNoteUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const hostname = parsed.hostname.toLowerCase();
  return NOTE_DOMAIN_WHITELIST.some(d => hostname === d || hostname.endsWith('.' + d));
}

function isShortLinkUrl(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return ['xhslink.com', 'xhslink.cn'].some(d => hostname === d || hostname.endsWith('.' + d));
  } catch {
    return false;
  }
}

// ====== Text truncation that does not corrupt emoji ======
//
// String.prototype.slice cuts by UTF-16 code units. An emoji is two of them, so
// slicing can land between the halves of a surrogate pair and leave a lone
// surrogate. JSON.stringify then emits it as \udXXX, which Node parses back
// happily but a strict parser rejects — DeepSeek answered exactly that:
//
//   Failed to parse the request body as JSON: messages[1].content:
//   unexpected end of hex escape at line 1 column 9654
//
// XHS copy is full of emoji (our own prompts ask for them), so every truncation
// of user text is a chance to break the request. Cut by code point instead.
function truncate(text, max) {
  const s = String(text ?? '');
  // Fast path: fewer code units than the cap means fewer code points too.
  if (s.length <= max) return s;
  const points = [...s];
  return points.length <= max ? s : points.slice(0, max).join('');
}

// Belt and braces for the request boundary: strip any unpaired surrogate that
// reached us from somewhere else — an older row truncated by the previous code,
// a scraped note, a model reply. One bad character used to fail the whole call.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function stripLoneSurrogates(text) {
  const s = String(text ?? '');
  return LONE_SURROGATE.test(s) ? s.replace(LONE_SURROGATE, '') : s;
}

// Sanitise every message before it goes upstream, whatever built it.
function sanitizeMessages(messages) {
  return messages.map(m => ({
    ...m,
    content: typeof m.content === 'string'
      ? stripLoneSurrogates(m.content)
      : Array.isArray(m.content)
        ? m.content.map(part => (part && typeof part.text === 'string'
          ? { ...part, text: stripLoneSurrogates(part.text) }
          : part))
        : m.content,
  }));
}

// ====== Structured Logger ======
function log(level, msg, meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    module: 'xhs-writer',
    msg,
    ...meta,
  };
  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else console.log(line);
}

// ====== 小红书笔记抓取 ======
//
// 2026-10 在 GitHub Actions（海外 runner，与生产机同为境外出口）上逐跳实测过：
//   1. xhslink 短链 302 到 /discovery/item/<id>?…&xsec_token=…，任何 UA 都一样
//   2. 这个分享页对【手机 UA】直接 200，SSR 里有完整笔记（state.noteData.data.noteData）
//   3. 对【电脑 UA】，不论 /explore/ 还是 /discovery/item/、xsec_source 填 app_share
//      还是 pc_share，一律 302 到 /login —— 匿名的电脑端已经看不到笔记了
//
// 旧实现解析短链用手机 UA，取正文却改写成 /explore/ 再换电脑 UA，正好撞上登录墙：
// 拿到的是登录页的 state，标题正文全空，于是报「笔记不存在或已被删除」。笔记其实在。
//
// 所以现在一律先用手机 UA 请求 /discovery/item/ 分享页。电脑端 /explore/ 只作兜底，
// 留着是为了小红书哪天放开时不用改代码。
const XHS_MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const XHS_DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** 笔记直链 → { noteId, query }；短链、非笔记页、非白名单域一律返回 null。 */
function parseNoteUrl(url) {
  if (!isAllowedNoteUrl(url) || isShortLinkUrl(url)) return null;
  const u = new URL(url);
  const m = u.pathname.match(/^\/(?:explore|discovery\/item)\/([a-f0-9]{24})\/?$/);
  return m ? { noteId: m[1], query: u.searchParams } : null;
}

function xhsPathIs(url, test) {
  try { return test(new URL(url).pathname); } catch { return false; }
}
const isXhsLoginUrl = (url) => xhsPathIs(url, p => p === '/login' || p.startsWith('/login/') || p.startsWith('/website-login'));
const isXhsGoneUrl = (url) => xhsPathIs(url, p => p === '/404' || p.startsWith('/404/'));

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

/**
 * 早期的 /o/ 短链不重定向，直接返回一页 HTML，noteId 和 token 嵌在脚本里。
 * 两种写法都见过：xsec_token 与 xsecToken；斜杠还可能被转义成 \u002F。
 */
function noteRefFromHtml(html) {
  const clean = String(html || '').replace(/\\u002F/gi, '/');
  const id = (clean.match(/noteId["'\s:=\\]+([a-f0-9]{24})/) || [])[1];
  if (!id) return null;
  const token = (clean.match(/xsec_?[tT]oken["'\s:=\\]+([A-Za-z0-9+/=_%-]+)/) || [])[1];
  const query = new URLSearchParams();
  if (token) {
    query.set('xsec_token', safeDecode(token));
    query.set('xsec_source', 'app_share');
  }
  return { noteId: id, query };
}

/**
 * 链接 → { noteId, query }。短链手动逐跳跟踪：
 * - 每一跳都过白名单。fetch 自动跟随时，中间跳在复检之前就已经请求出去了 ——
 *   只检查最终地址，拦不住「白名单域上的开放重定向 → 内网地址」这条路。
 * - 一拿到笔记地址就停，不跟进去：后面那一跳可能就是登录墙，token 会丢在半路。
 */
async function resolveNoteRef(url, fetchImpl = fetch) {
  const direct = parseNoteUrl(url);
  if (direct) return direct;
  if (!isShortLinkUrl(url)) return null;

  let current = url;
  for (let hop = 0; hop < CONFIG.xhsMaxHops; hop++) {
    const res = await fetchImpl(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(CONFIG.xhsLinkTimeout),
      headers: { 'User-Agent': XHS_MOBILE_UA },
    });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      const next = new URL(location, current).toString();
      if (!isAllowedNoteUrl(next)) {
        log('warn', 'Short link redirected off-whitelist', { from: current, to: next });
        throw new Error('短链接重定向到非预期域名');
      }
      const ref = parseNoteUrl(next);
      if (ref) return ref;
      current = next;
      continue;
    }
    if (!res.ok) return null;
    return noteRefFromHtml(await res.text());
  }
  return null;
}

/**
 * 按顺序尝试的抓取方案。手机分享页沿用分享链接带来的全部参数 ——
 * 实测原样参数与只留 xsec_token 都能打开，原样是最接近 App 行为的那个。
 */
function noteFetchPlan(ref) {
  const mobileQuery = new URLSearchParams(ref.query).toString();
  const desktopQuery = new URLSearchParams();
  const token = ref.query.get('xsec_token');
  if (token) {
    desktopQuery.set('xsec_token', token);
    desktopQuery.set('xsec_source', ref.query.get('xsec_source') || 'pc_share');
  }
  const qs = (q) => (q ? `?${q}` : '');
  return [
    { label: 'mobile-share', ua: XHS_MOBILE_UA, url: `https://www.xiaohongshu.com/discovery/item/${ref.noteId}${qs(mobileQuery)}` },
    { label: 'desktop-explore', ua: XHS_DESKTOP_UA, url: `https://www.xiaohongshu.com/explore/${ref.noteId}${qs(desktopQuery.toString())}` },
  ];
}

/**
 * 逐跳请求一个笔记页。跳到登录页或 404 就地停下并说明原因 ——
 * 不去请求登录页本身：它也有一份 __INITIAL_STATE__，正是它把旧实现骗过去的。
 */
async function fetchXhsPage(url, ua, fetchImpl = fetch) {
  let current = url;
  for (let hop = 0; hop <= CONFIG.xhsMaxHops; hop++) {
    if (!isAllowedNoteUrl(current)) {
      log('warn', 'Note page redirected off-whitelist', { url: current });
      throw new Error('短链接重定向到非预期域名');
    }
    if (isXhsLoginUrl(current)) return { kind: 'login' };
    if (isXhsGoneUrl(current)) return { kind: 'gone' };
    const res = await fetchImpl(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(CONFIG.xhsPageTimeout),
      headers: {
        'User-Agent': ua,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current).toString();
      continue;
    }
    return { kind: 'page', status: res.status, html: await res.text() };
  }
  return { kind: 'error', error: 'too many redirects' };
}

/** 页面里的 __INITIAL_STATE__ → 对象。它是 JS 字面量而不是 JSON：值里会出现 undefined。 */
function parseInitialState(html) {
  const m = String(html || '').match(/__INITIAL_STATE__\s*=\s*(\{.+?\})\s*<\/script>/s);
  if (!m) return null;
  try {
    return JSON.parse(m[1].replace(/([:[,])undefined(?=[,}\]])/g, '$1null'));
  } catch {
    return null;
  }
}

/**
 * 从 state 里取出【这一篇】笔记。按 noteId 核对 ——
 * 手机分享页同一份 state 里还挂着 relatedNotes、userOtherNotesData，
 * 十几篇别人的笔记都有 title 和 desc，取错一篇比取不到更糟。
 */
function pickNoteFromState(state, noteId) {
  if (!state || typeof state !== 'object') return null;
  const candidates = [
    state.noteData?.data?.noteData,              // 手机分享页 /discovery/item/
    state.note?.noteDetailMap?.[noteId]?.note,   // 电脑端 /explore/
  ];
  for (const note of candidates) {
    if (!note || typeof note !== 'object') continue;
    if (note.noteId && noteId && note.noteId !== noteId) continue;
    if (note.title || note.desc) return note;
  }
  return null;
}

/** 一张图挑哪个地址：电脑端的 WB_DFT、手机页的 H5_DTL 都是正文大图，H5_PRV 是缩略图垫底。 */
function pickImageUrl(img) {
  if (!img || typeof img !== 'object') return '';
  const info = Array.isArray(img.infoList) ? img.infoList : [];
  const scene = (name) => info.find(i => i && i.imageScene === name)?.url;
  return scene('WB_DFT') || scene('H5_DTL') || img.urlDefault || img.url || scene('H5_PRV') || '';
}

const TOPIC_TAG_RE = /#([^#[\]\n]+?)(?:\[话题\])?#/g;
const TRAILING_TOPICS_RE = /\s*(?:#[^#]+?(?:\[话题\])?#\s*)+$/;
// 作者常写「标签：#A# #B#」—— 话题剥掉之后，前面那个「标签：」会孤零零留在正文末尾
const TRAILING_TAG_LABEL_RE = /(?:^|\n)[^\S\n]*(?:标签|话题|tags?)[^\S\n]*[:：][^\S\n]*$/i;

/** 笔记对象 → 仿写要用的四样东西。 */
function noteContentFromState(note) {
  const title = String(note.title || '').replace(/\s*-\s*小红书\s*$/, '').trim();
  const desc = String(note.desc || '');

  // 话题先按正文里出现的顺序，再用 tagList 补齐 —— 正文末尾的话题有时被截断，tagList 是全的
  const tags = [];
  const seen = new Set();
  const addTag = (raw) => {
    const t = String(raw || '').trim();
    if (t && t.length < 30 && !seen.has(t)) { seen.add(t); tags.push(t); }
  };
  for (const m of desc.matchAll(TOPIC_TAG_RE)) addTag(m[1]);
  for (const t of Array.isArray(note.tagList) ? note.tagList : []) addTag(t && t.name);

  const imageUrls = (Array.isArray(note.imageList) ? note.imageList : [])
    .map(pickImageUrl)
    .filter(Boolean)
    .slice(0, CONFIG.maxGalleryImages);

  const content = desc.replace(TRAILING_TOPICS_RE, '').replace(TRAILING_TAG_LABEL_RE, '').trim();
  return { title, content, tags, imageUrls };
}

/**
 * 位置 at 落在哪个 {...} 里，就把那个对象原文切出来。按括号配对、跳过字符串内容。
 * 只能正着扫：倒着扫分不清一个引号是字符串的开头还是结尾。
 */
function enclosingObjectAt(s, at) {
  const opens = [];
  let target = -1;
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (i === at) target = opens[opens.length - 1] ?? -1;
    if (c === '"') inString = true;
    else if (c === '{') opens.push(i);
    else if (c === '}') {
      const open = opens.pop();
      if (target !== -1 && open === target) return s.slice(open, i + 1);
    }
  }
  return '';
}

/**
 * 结构化解析失败时的兜底：只在【包住这个 noteId 的那个对象】里找 title / desc。
 * 不能全文抓第一个 "desc"，也不能取 noteId 前后一段窗口 ——
 * 相关推荐里别人的笔记就挨在旁边，窗口里第一个 title 往往就是别人的。
 */
function legacyNoteFromHtml(html, noteId) {
  const m = String(html || '').match(/__INITIAL_STATE__\s*=\s*(\{.+?\})\s*<\/script>/s);
  if (!m || !noteId) return null;
  const s = m[1];
  const at = s.indexOf(`"noteId":"${noteId}"`);
  if (at === -1) return null;
  const obj = enclosingObjectAt(s, at);
  if (!obj) return null;

  // 整份 state 解析不了，不代表这一个对象也解析不了 —— 能解析就直接读字段
  try {
    const note = JSON.parse(obj.replace(/([:[,])undefined(?=[,}\]])/g, '$1null'));
    if (note && (note.title || note.desc)) return noteContentFromState(note);
  } catch { /* 退到按字段正则 */ }

  const unquote = (x) => { try { return JSON.parse(`"${x}"`); } catch { return ''; } };
  const title = unquote((obj.match(/"title":"((?:[^"\\]|\\.)*)"/) || [])[1] || '');
  const desc = unquote((obj.match(/"desc":"((?:[^"\\]|\\.)*)"/) || [])[1] || '');
  return title || desc ? noteContentFromState({ title, desc }) : null;
}

/**
 * 链接 → 笔记。成功返回 { ok: true, noteId, via, title, content, tags, imageUrls }；
 * 失败返回 { ok: false, reason }，reason 用来给用户一句说得清的原因。
 * 每次尝试的结果都记日志 —— 小红书改版时，第一手线索就在 pm2 logs 里。
 */
async function extractNote(url, fetchImpl = fetch) {
  const ref = await resolveNoteRef(url, fetchImpl);
  if (!ref) return { ok: false, reason: 'unresolved' };

  const attempts = [];
  for (const step of noteFetchPlan(ref)) {
    let page;
    try {
      page = await fetchXhsPage(step.url, step.ua, fetchImpl);
    } catch (err) {
      if (err.message.includes('非预期域名')) throw err;
      attempts.push({ via: step.label, kind: 'error', error: err.message });
      continue;
    }
    if (page.kind !== 'page') {
      attempts.push({ via: step.label, kind: page.kind });
      continue;
    }
    const state = parseInitialState(page.html);
    const note = pickNoteFromState(state, ref.noteId);
    const parsed = note ? noteContentFromState(note) : legacyNoteFromHtml(page.html, ref.noteId);
    attempts.push({ via: step.label, kind: 'page', status: page.status, hasState: !!state, found: !!parsed });
    if (parsed && (parsed.title || parsed.content)) {
      log('info', 'Note extracted', { noteId: ref.noteId, via: step.label, images: parsed.imageUrls.length, attempts });
      return { ok: true, noteId: ref.noteId, via: step.label, ...parsed };
    }
  }

  const hasToken = ref.query.has('xsec_token');
  log('warn', 'Note extraction failed', { noteId: ref.noteId, hasToken, attempts });
  // 先看有没有 token：实测不带 token 的直链，小红书一律跳 /404 —— 笔记其实在，
  // 这时报「不存在」是冤枉人，该说的是「去 App 里重新复制链接」
  const kinds = attempts.map(a => a.kind);
  let reason = 'empty';
  if (!hasToken) reason = 'no_token';
  else if (kinds.includes('gone')) reason = 'gone';
  else if (kinds.length && kinds.every(k => k === 'login')) reason = 'login';
  return { ok: false, reason, attempts };
}

const EXTRACT_FAILURE_MESSAGES = {
  unresolved: '短链接解析失败，可能已过期，请在小红书 App 里重新「分享 → 复制链接」',
  gone: '笔记不存在或已被删除',
  no_token: '链接缺少 xsec_token 参数。请在小红书 App 里点「分享 → 复制链接」，把整段分享内容粘贴进来',
  login: '小红书要求登录才能查看这篇笔记，暂时无法自动提取，可以手动复制正文粘贴进来',
  empty: '未能提取到笔记内容，链接可能已失效',
};

// ====== AI rate limiting (fixed window per API token) ======
// Keyed by the Bearer token (hashed) rather than IP: behind a reverse proxy all
// clients share the proxy IP, and per-IP quotas would let users starve each other.
const aiRateLimits = new Map();

function rateLimitKey(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '') || String(req.query.token || '');
  if (token) return 'tk:' + crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
  return 'ip:' + (req.ip || req.connection?.remoteAddress || 'unknown');
}

function aiRateLimit(req, res, next) {
  const key = rateLimitKey(req);
  const now = Date.now();
  let bucket = aiRateLimits.get(key);
  if (!bucket) {
    bucket = { tokens: CONFIG.aiRateMax, lastRefill: now };
    aiRateLimits.set(key, bucket);
  }
  const elapsed = now - bucket.lastRefill;
  if (elapsed >= CONFIG.aiRateWindow) {
    bucket.tokens = CONFIG.aiRateMax;
    bucket.lastRefill = now;
  }
  res.set('Access-Control-Expose-Headers', 'X-RateLimit-Limit, X-RateLimit-Remaining');
  if (bucket.tokens <= 0) {
    const retryIn = Math.ceil((CONFIG.aiRateWindow - elapsed) / 1000);
    res.set('X-RateLimit-Limit', String(CONFIG.aiRateMax));
    res.set('X-RateLimit-Remaining', '0');
    return res.status(429).json({
      error: { message: `AI 请求已达上限（每分钟 ${CONFIG.aiRateMax} 次），请 ${retryIn} 秒后重试` },
    });
  }
  bucket.tokens--;
  next();
}

const aiRateCleanupTimer = setInterval(() => {
  const cutoff = Date.now() - CONFIG.aiRateCleanup;
  for (const [key, bucket] of aiRateLimits) {
    if (bucket.lastRefill < cutoff) aiRateLimits.delete(key);
  }
  for (const [key, bucket] of writeRateLimits) {
    if (bucket.lastRefill < cutoff) writeRateLimits.delete(key);
  }
  // 读图的桶原来漏在这里之外：不开鉴权时按 IP 建桶，进程不重启就只增不减
  for (const [key, bucket] of visionRateLimits) {
    if (bucket.lastRefill < cutoff) visionRateLimits.delete(key);
  }
}, CONFIG.aiRateCleanup);
aiRateCleanupTimer.unref();

// Remaining AI quota for the caller, without consuming any.
function aiQuotaRemaining(req) {
  const bucket = aiRateLimits.get(rateLimitKey(req));
  if (!bucket) return CONFIG.aiRateMax;
  if (Date.now() - bucket.lastRefill >= CONFIG.aiRateWindow) return CONFIG.aiRateMax;
  return Math.max(0, bucket.tokens);
}

// ====== Write rate limiting ======
// Mutations are cheap but not free, and with auth disabled anyone can call them.
// A separate, roomier bucket keeps a runaway client from filling the disk or the
// table without getting in the way of normal editing.
const writeRateLimits = new Map();

function writeRateLimit(req, res, next) {
  const key = rateLimitKey(req);
  const now = Date.now();
  let bucket = writeRateLimits.get(key);
  if (!bucket) {
    bucket = { tokens: CONFIG.writeRateMax, lastRefill: now };
    writeRateLimits.set(key, bucket);
  }
  if (now - bucket.lastRefill >= CONFIG.aiRateWindow) {
    bucket.tokens = CONFIG.writeRateMax;
    bucket.lastRefill = now;
  }
  if (bucket.tokens <= 0) {
    return res.status(429).json({ error: { message: '操作过于频繁，请稍后重试' } });
  }
  bucket.tokens--;
  next();
}

// ====== Vision rate limiting ======
// Reading an image costs several times what generating text does, so it gets its
// own, much smaller bucket rather than sharing the copywriting quota.
const visionRateLimits = new Map();

function visionRateLimit(req, res, next) {
  const key = rateLimitKey(req);
  const now = Date.now();
  let bucket = visionRateLimits.get(key);
  if (!bucket) {
    bucket = { tokens: CONFIG.visionRateMax, lastRefill: now };
    visionRateLimits.set(key, bucket);
  }
  const elapsed = now - bucket.lastRefill;
  if (elapsed >= CONFIG.aiRateWindow) {
    bucket.tokens = CONFIG.visionRateMax;
    bucket.lastRefill = now;
  }
  res.set('Access-Control-Expose-Headers', 'X-Vision-Limit, X-Vision-Remaining');
  res.set('X-Vision-Limit', String(CONFIG.visionRateMax));
  if (bucket.tokens <= 0) {
    const retryIn = Math.ceil((CONFIG.aiRateWindow - elapsed) / 1000);
    res.set('X-Vision-Remaining', '0');
    return res.status(429).json({
      error: { message: `读图请求已达上限（每分钟 ${CONFIG.visionRateMax} 次），请 ${retryIn} 秒后重试` },
    });
  }
  bucket.tokens--;
  res.set('X-Vision-Remaining', String(bucket.tokens));
  next();
}

function visionQuotaRemaining(req) {
  const bucket = visionRateLimits.get(rateLimitKey(req));
  if (!bucket) return CONFIG.visionRateMax;
  if (Date.now() - bucket.lastRefill >= CONFIG.aiRateWindow) return CONFIG.visionRateMax;
  return Math.max(0, bucket.tokens);
}

// ====== Optional bearer auth ======
// Auth is opt-in: it engages only when API_TOKEN is set in the environment.
// Leaving it unset preserves the current open-access behaviour, so deploying
// this file cannot lock anyone out of a running instance; setting the variable
// and restarting turns protection on with no further code change.
function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireAuth(req, res, next) {
  const expected = process.env.API_TOKEN || '';
  if (!expected) return next();
  const provided = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (provided && timingSafeEqual(provided, expected)) return next();
  return res.status(401).json({ error: { message: '访问令牌无效或已过期' } });
}

// ====== Optional schema features ======
// The deploy pipeline ships only src/xhs-writer.js — it never runs migrations.
// So the gallery column is probed at runtime and every query adapts: on a database
// that has not run db/migrations/001_add_images.sql yet, the server keeps working
// with a single cover image instead of crashing on an unknown column.
//
// probeSchema() also *attempts* these same statements itself (see below) so that
// a fresh production database self-heals without anyone ever having to run the
// .sql files by hand — the deploy pipeline can't do it, and the failure mode if
// nobody remembers is silent, permanent local-only degradation.

// 与 db/migrations/002_add_style_profile.sql 逐字一致。
const MIGRATION_STYLE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS xhs_style_profile (
    id TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '单行表，恒为 1',
    profile JSON NOT NULL COMMENT '风格特征，人可读可编辑',
    sample_count INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '蒸馏时读了多少篇；手工覆盖时为 0',
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

// 与 db/migrations/003_add_templates.sql 逐字一致。
const MIGRATION_TEMPLATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS xhs_templates (
    id VARCHAR(64) NOT NULL COMMENT '与前端一致的 custom_<timestamp>',
    name VARCHAR(60) NOT NULL,
    icon VARCHAR(8) NULL DEFAULT '📝',
    description VARCHAR(200) NULL,
    system_prompt TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_created_at (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

// 与 db/migrations/001_add_images.sql 逐字一致。
const MIGRATION_IMAGES_COLUMN_SQL = `
  ALTER TABLE xhs_materials
    ADD COLUMN images JSON NULL COMMENT '图集，最多 9 张 /api/xhs/uploads/ 路径' AFTER image_url
`;

const schemaFlags = {
  hasImagesColumn: false,
  hasStyleTable: false,
  hasTemplateTable: false,
  probed: false,
};

async function probeSchema(pool) {
  try {
    const [rows] = await pool.query("SHOW COLUMNS FROM xhs_materials LIKE 'images'");
    schemaFlags.hasImagesColumn = rows.length > 0;
  } catch (err) {
    schemaFlags.hasImagesColumn = false;
    log('warn', 'Schema probe failed, gallery disabled', { error: err.message });
  }
  try {
    const [rows] = await pool.query("SHOW TABLES LIKE 'xhs_style_profile'");
    schemaFlags.hasStyleTable = rows.length > 0;
  } catch (err) {
    schemaFlags.hasStyleTable = false;
    log('warn', 'Style table probe failed, profile caching disabled', { error: err.message });
  }
  try {
    const [rows] = await pool.query("SHOW TABLES LIKE 'xhs_templates'");
    schemaFlags.hasTemplateTable = rows.length > 0;
  } catch (err) {
    schemaFlags.hasTemplateTable = false;
    log('warn', 'Template table probe failed, cloud sync disabled', { error: err.message });
  }

  // 没人手动跑过 db/migrations/*，所以三张表/列长期缺失，功能一直卡在本地
  // 兜底模式。这几条 DDL 和迁移文件逐字一致，全部是"不存在才建"，对已经建好
  // 的库是空操作；数据库账号如果没有建表权限，会在下面被吞掉、退回现在这套
  // 探测+降级的行为——不会导致启动失败，也不会把只读账号的场景搞挂。
  if (!schemaFlags.hasStyleTable) {
    try {
      await pool.query(MIGRATION_STYLE_TABLE_SQL);
      schemaFlags.hasStyleTable = true;
      log('info', 'Auto-migration: created xhs_style_profile');
    } catch (err) {
      log('warn', 'Auto-migration: xhs_style_profile create failed, staying in local-cache mode', { error: err.message });
    }
  }
  if (!schemaFlags.hasTemplateTable) {
    try {
      await pool.query(MIGRATION_TEMPLATE_TABLE_SQL);
      schemaFlags.hasTemplateTable = true;
      log('info', 'Auto-migration: created xhs_templates');
    } catch (err) {
      log('warn', 'Auto-migration: xhs_templates create failed, staying in local-cache mode', { error: err.message });
    }
  }
  if (!schemaFlags.hasImagesColumn) {
    try {
      await pool.query(MIGRATION_IMAGES_COLUMN_SQL);
      schemaFlags.hasImagesColumn = true;
      log('info', 'Auto-migration: added xhs_materials.images');
    } catch (err) {
      // 并发下两个进程可能同时探测到缺列、同时尝试 ALTER，后一个会撞上
      // "Duplicate column" —— 按已存在处理，不算失败。
      if (/duplicate column/i.test(err.message)) {
        schemaFlags.hasImagesColumn = true;
      } else {
        log('warn', 'Auto-migration: images column add failed, staying in single-image mode', { error: err.message });
      }
    }
  }

  schemaFlags.probed = true;
  log('info', 'Schema probe complete', {
    hasImagesColumn: schemaFlags.hasImagesColumn,
    hasStyleTable: schemaFlags.hasStyleTable,
    hasTemplateTable: schemaFlags.hasTemplateTable,
  });
  return schemaFlags.hasImagesColumn && schemaFlags.hasStyleTable && schemaFlags.hasTemplateTable;
}

function parseJsonColumn(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return value;
}

// ====== Image Storage (async) ======
// Extension whitelist — anything else (notably SVG, which can carry scripts) is rejected.
const IMAGE_EXT_WHITELIST = new Set(['jpg', 'jpeg', 'png', 'webp']);

async function saveImageFile(base64Data) {
  const match = base64Data.match(/^data:image\/(\w+);base64,(.+)$/);
  if (!match) return null;
  const rawExt = match[1].toLowerCase();
  if (!IMAGE_EXT_WHITELIST.has(rawExt)) {
    log('warn', 'Image rejected by extension whitelist', { ext: rawExt });
    return null;
  }
  const ext = rawExt === 'jpeg' ? 'jpg' : rawExt;
  const buf = Buffer.from(match[2], 'base64');
  if (buf.length > CONFIG.imageMaxSize) {
    log('warn', 'Image too large, rejected', { size: buf.length });
    return null;
  }
  const fname = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
  await fs.mkdir(CONFIG.uploadDir, { recursive: true });
  await fs.writeFile(path.join(CONFIG.uploadDir, fname), buf);
  return `/api/xhs/uploads/${fname}`;
}

async function downloadImage(imageUrl) {
  try {
    // SSRF prevention: only download from whitelisted XHS CDN domains
    if (!isAllowedImageDomain(imageUrl)) {
      log('warn', 'Image URL blocked by domain whitelist', { url: imageUrl });
      return null;
    }

    const resp = await fetch(imageUrl, {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' },
    });
    if (!resp.ok) return null;

    // 上面那道白名单只拦住了**初始** URL，而 fetch 默认跟随重定向 ——
    // 白名单域上的一个开放重定向就能把这次请求带去内网地址。这里复检最终地址。
    // （笔记页那边已改成逐跳手动跟踪、每跳都过白名单，比这里更严；
    //   图片走 CDN、重定向极少，先保持复检最终地址。）
    if (!isAllowedImageDomain(resp.url || imageUrl)) {
      log('warn', 'Image redirected off-whitelist', { from: imageUrl, to: resp.url });
      return null;
    }

    // Size limit check via content-length header
    const contentLength = parseInt(resp.headers.get('content-length') || '0', 10);
    if (contentLength > CONFIG.imageMaxSize) {
      log('warn', 'Image too large, skipping', { url: imageUrl, size: contentLength });
      return null;
    }

    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > CONFIG.imageMaxSize) return null;

    const contentType = resp.headers.get('content-type') || 'image/jpeg';
    const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
    const fname = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
    await fs.mkdir(CONFIG.uploadDir, { recursive: true });
    await fs.writeFile(path.join(CONFIG.uploadDir, fname), buf);
    return `/api/xhs/uploads/${fname}`;
  } catch (err) {
    log('error', 'Image download failed', { url: imageUrl, error: err.message });
    return null;
  }
}

// Parallel image download with concurrency limit.
// 结果按【输入顺序】返回，不是按谁先下载完 —— 第一张是封面，九宫格的顺序也是作者排过的。
// 之前按完成顺序 push，并发一跑起来封面就可能跑到第三张去。
async function downloadImagesParallel(urls, download = downloadImage) {
  const results = new Array(urls.length).fill(null);
  let next = 0;
  const workers = Array.from({ length: Math.min(CONFIG.imageConcurrency, urls.length) }, async () => {
    while (next < urls.length) {
      const i = next++;
      results[i] = await download(urls[i]);
    }
  });
  await Promise.all(workers);
  return results.filter(Boolean);
}

async function deleteImageFile(imageUrl) {
  if (!imageUrl) return;
  const fname = imageUrl.replace('/api/xhs/uploads/', '');
  // Prevent path traversal
  if (fname.includes('..') || fname.includes('/')) return;
  try {
    await fs.unlink(path.join(CONFIG.uploadDir, fname));
  } catch {}
}

// Resolve an incoming imageData field to a stored image_url value.
// Returns { url, changed }: url is the value to persist, changed is true when it differs from old.
async function resolveImageInput(imageData, oldImageUrl) {
  if (imageData === '') {
    // Explicit removal
    return { url: null, changed: true };
  }
  if (imageData && imageData.startsWith('/api/xhs/uploads/')) {
    return { url: imageData, changed: imageData !== oldImageUrl };
  }
  if (imageData && imageData.startsWith('data:image/')) {
    const saved = await saveImageFile(imageData);
    return { url: saved, changed: true };
  }
  // undefined / null — keep existing
  return { url: oldImageUrl || null, changed: false };
}

// Resolve an incoming `images` array into stored upload paths.
// Accepts already-stored paths and fresh data: URLs, caps the gallery at the
// same 9 images XHS itself allows, and drops anything it cannot store.
async function resolveGalleryInput(images) {
  if (!Array.isArray(images)) return null;
  const out = [];
  for (const entry of images.slice(0, CONFIG.maxGalleryImages)) {
    if (typeof entry !== 'string') continue;
    if (entry.startsWith('/api/xhs/uploads/')) {
      out.push(entry);
    } else if (entry.startsWith('data:image/')) {
      const saved = await saveImageFile(entry);
      if (saved) out.push(saved);
    }
  }
  return out;
}

// Delete upload files that the new gallery no longer references.
async function pruneImages(oldList, keepList) {
  const keep = new Set(keepList || []);
  for (const url of oldList || []) {
    if (url && !keep.has(url)) await deleteImageFile(url);
  }
}

// ====== Orphaned upload sweep ======
// Extraction downloads up to 9 images per note. If the user never saves, those
// files stay on disk forever — the gallery feature made this leak faster, not
// slower. This finds files no material references any more.
//
// Two safeguards, because this deletes the user's files:
//   1. A generous age floor. Client-side drafts hold /api/xhs/uploads/ paths in
//      localStorage, so a file that is unreferenced today may still be shown in
//      a draft someone comes back to. Default 7 days.
//   2. It never runs on its own unless XHS_UPLOAD_SWEEP is switched on. The
//      default is a dry run you have to ask for.
function uploadTtlMs() {
  const days = parseFloat(process.env.XHS_UPLOAD_TTL_DAYS || '7');
  const safe = Number.isFinite(days) && days > 0 ? days : 7;
  return safe * 24 * 60 * 60 * 1000;
}

async function referencedUploadNames(pool) {
  const names = new Set();
  const galleryCol = schemaFlags.hasImagesColumn ? ', images' : '';
  const [rows] = await pool.query('SELECT image_url' + galleryCol + ' FROM xhs_materials');
  for (const row of rows) {
    const all = [row.image_url, ...(Array.isArray(parseJsonColumn(row.images, [])) ? parseJsonColumn(row.images, []) : [])];
    for (const url of all) {
      if (typeof url === 'string' && url.startsWith('/api/xhs/uploads/')) {
        names.add(url.replace('/api/xhs/uploads/', ''));
      }
    }
  }
  return names;
}

async function findOrphanUploads(pool) {
  const referenced = await referencedUploadNames(pool);
  const cutoff = Date.now() - uploadTtlMs();

  let entries;
  try {
    entries = await fs.readdir(CONFIG.uploadDir);
  } catch {
    return { orphans: [], bytes: 0, scanned: 0, referenced: referenced.size };
  }

  const orphans = [];
  let bytes = 0;
  for (const name of entries) {
    if (referenced.has(name)) continue;
    try {
      const stat = await fs.stat(path.join(CONFIG.uploadDir, name));
      if (!stat.isFile()) continue;
      // Too young to be sure nobody is still holding it in a draft.
      if (stat.mtimeMs > cutoff) continue;
      orphans.push({ name, size: stat.size, mtime: new Date(stat.mtimeMs).toISOString() });
      bytes += stat.size;
    } catch { /* vanished mid-scan — nothing to reclaim */ }
  }
  return { orphans, bytes, scanned: entries.length, referenced: referenced.size };
}

async function sweepOrphanUploads(pool) {
  const report = await findOrphanUploads(pool);
  let deleted = 0;
  for (const o of report.orphans) {
    try {
      await fs.unlink(path.join(CONFIG.uploadDir, o.name));
      deleted++;
    } catch { /* already gone */ }
  }
  log('info', 'Upload sweep done', { deleted, bytes: report.bytes, scanned: report.scanned });
  return { ...report, deleted };
}

// ====== Vision: read facts out of an image ======
// The prompt is the safety mechanism for this whole feature. The copy this tool
// produces sells broadband plans, so a hallucinated price is not a cosmetic bug:
// the user posts it and customers turn up expecting a deal that does not exist.
// Hence: extract only, never infer, and label anything uncertain so the UI can
// force a human to confirm it before a single word gets generated.
const VISION_SYSTEM_PROMPT = `你是一个图片信息提取器，不是文案写手。你唯一的任务是读出图片里和运营商套餐资费有关的信息。

【铁律】
1. 只报告图中可见的内容。看不清的、不确定的、图里根本没有的，一律不要写。
2. 数字必须逐字符照抄：金额、带宽、时长、日期、电话。不要推断、不要换算、不要补全、不要"合理猜测"。
3. 宁可少报，不可多报。漏一条只是麻烦，编一条会让用户把错误的价格发出去。
4. 不要写任何营销语言、形容词或建议。你不负责好听，只负责准确。
5. 你只关心运营商和套餐资费本身。图片如果是别的小红书笔记截图，上面常见的小红书号、用户昵称、
   头像、关注/点赞/收藏/评论/转发数、发布时间、IP属地、App 导航栏或按钮图标、水印——这些是
   截图软件或平台自带的界面元素，不是套餐信息的一部分，一律不要当成一条 fact，也不要写进 scene。

【facts 的 key —— 只能从这里面选，不要自己新增】
运营商、带宽、月费、年费、合约期、优惠、赠送、安装费、适用区域、有效期、联系方式、套餐名称。
图中其它文字，只要不属于这些字段就不要写进 facts —— 小红书号、昵称一类账号信息就是典型例子，
永远不属于套餐内容，永远不要提取。图中没有的项就不要出现在数组里。
如果图里没有任何可读文字，facts 返回空数组并把 hasText 设为 false。

【置信度】
每条信息标注 confidence：
- "high"：图中文字清晰可读，你是照抄的
- "low"：模糊、被遮挡、需要推断，或你不完全确定

【输出】
严格输出 JSON，不要输出其他任何文字：
{
  "scene": "一句话客观描述画面内容，不带感情色彩",
  "hasText": true 或 false（图中是否含有可读文字）,
  "facts": [
    { "key": "运营商", "value": "中国移动", "confidence": "high" }
  ],
  "warnings": ["图中含二维码" 之类需要用户注意的情况]
}

【收到多张图时】
这些图属于同一篇笔记（例如一张资费表加一张覆盖区域说明）。
- 合并成一份 facts，同样的信息不要重复列
- 如果不同图里同一项的值对不上（比如两张图的月费不一样），两条都列出来，
  各自标 confidence 为 "low"，并在 warnings 里说明哪一项在图之间不一致
- scene 描述整组图，不是只描述第一张`;

function buildVisionContent(urls) {
  return [
    {
      type: 'text',
      text: urls.length > 1
        ? `请提取这 ${urls.length} 张图片里的信息，它们属于同一篇笔记，请合并。`
        : '请提取这张图片里的信息。',
    },
    ...urls.map(url => ({ type: 'image_url', image_url: { url } })),
  ];
}

// 只有"这个型号不存在/不可用"才值得换下一个候选重试。限流、余额不足、鉴权
// 失败、服务端异常这些换个型号照样失败，重试只会白烧一次调用，还会把真正的
// 原因替换成一条更难懂的报错。
// 404：OpenAI 兼容端点的路径是固定的，能走到这里说明路径没问题，那 404 基本
// 只可能是型号不存在。400：含义太宽（体积、参数、内容都可能），只有报错原文
// 明确提到 model/模型时才当成型号问题。
function isUnknownModelError(status, detail) {
  if (status === 404) return true;
  if (status !== 400) return false;
  return /model|模型/i.test(String(detail || ''));
}

// Several images go into ONE call rather than one call each: plan details often
// span a couple of shots, and the model can reconcile them (and flag where they
// disagree) only if it sees them together. It is also cheaper — providers bill
// per image, but the prompt and reply are paid for once.
async function callVisionModel(dataUrls) {
  const cfg = visionConfig();
  const endpoint = ENDPOINTS[cfg.provider];
  const urls = Array.isArray(dataUrls) ? dataUrls : [dataUrls];

  const content = buildVisionContent(urls);
  const candidates = cfg.models.length ? cfg.models : [cfg.model];

  let lastErr = null;
  for (let i = 0; i < candidates.length; i++) {
    const model = candidates[i];
    const upstream = await fetch(endpoint, {
      method: 'POST',
      signal: AbortSignal.timeout(CONFIG.visionTimeout),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + cfg.key,
      },
      body: JSON.stringify({
        model,
        messages: sanitizeMessages([
          { role: 'system', content: VISION_SYSTEM_PROMPT },
          { role: 'user', content },
        ]),
        temperature: 0,
      }),
    });

    if (upstream.ok) {
      // 降级成功要留痕：说明首选型号已经下线了，运维看日志就知道该更新默认值
      if (i > 0) {
        log('warn', 'Vision fell back to a later candidate model', {
          model, skipped: candidates.slice(0, i),
        });
      }
      return upstream.json();
    }

    const errBody = await upstream.text().catch(() => '');
    const detail = extractUpstreamDetail(errBody);
    log('error', 'Vision upstream returned error', {
      status: upstream.status,
      provider: cfg.provider,
      model,
      body: errBody.slice(0, 500),
    });

    const err = new Error('vision_upstream');
    err.status = upstream.status;
    err.detail = detail;
    err.model = model;
    lastErr = err;

    // 还有后备型号，且失败原因确实是"不认识这个型号"，就换下一个再试一次
    if (i < candidates.length - 1 && isUnknownModelError(upstream.status, detail)) continue;
    throw err;
  }
  throw lastErr;
}

// Pull the JSON object out of a model reply and normalise it into a shape the
// UI can render without further guessing.
function parseVisionResult(raw) {
  if (typeof raw !== 'string') return null;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const facts = Array.isArray(parsed.facts) ? parsed.facts : [];
  return {
    scene: typeof parsed.scene === 'string' ? truncate(parsed.scene, 300) : '',
    hasText: parsed.hasText !== false,
    facts: facts
      .filter(f => f && typeof f.key === 'string' && f.value != null)
      .slice(0, 20)
      .map(f => ({
        key: truncate(f.key, 40),
        value: truncate(f.value, 200),
        // Anything not explicitly marked high is treated as needing a look.
        confidence: f.confidence === 'high' ? 'high' : 'low',
      })),
    warnings: (Array.isArray(parsed.warnings) ? parsed.warnings : [])
      .filter(w => typeof w === 'string')
      .slice(0, 5)
      .map(w => truncate(w, 120)),
  };
}

// Turn an accepted image reference into a data URL for the provider.
// Only two forms are allowed: an inline data URL, or a path inside our own
// uploads directory. Anything else — notably an arbitrary http(s) URL — would
// make this endpoint fetch on an attacker's behalf.
async function resolveVisionImage(image) {
  if (typeof image !== 'string' || !image) return null;

  if (image.startsWith('data:image/')) {
    const match = image.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!match) return null;
    if (!IMAGE_EXT_WHITELIST.has(match[1].toLowerCase())) return null;
    if (Buffer.byteLength(match[2], 'base64') > CONFIG.visionMaxBytes) return null;
    return image;
  }

  if (image.startsWith('/api/xhs/uploads/')) {
    const fname = image.replace('/api/xhs/uploads/', '');
    if (fname.includes('..') || fname.includes('/')) return null;
    const ext = path.extname(fname).replace('.', '').toLowerCase();
    if (!IMAGE_EXT_WHITELIST.has(ext)) return null;
    try {
      const buf = await fs.readFile(path.join(CONFIG.uploadDir, fname));
      if (buf.length > CONFIG.visionMaxBytes) return null;
      const mime = ext === 'jpg' ? 'jpeg' : ext;
      return `data:image/${mime};base64,${buf.toString('base64')}`;
    } catch {
      return null;
    }
  }

  return null;
}

// ====== Style profile ======
const STYLE_SYSTEM_PROMPT = `你是一个文本风格分析师。给你一批某个作者写的小红书文案，你要总结出这个作者的写作风格特征。

要求：
- 只描述这批文案里真实出现的规律，不要写通用的写作建议
- 特征要具体到可以被验证，不要写"语言生动""贴近生活"这类空话
- 高频标签按出现次数排序，只列真实出现过的

严格输出 JSON，不要输出其他文字：
{
  "开头习惯": ["..."],
  "句长节奏": "一句话描述",
  "emoji": { "密度": "...", "位置": "..." },
  "自称": "...",
  "高频标签": ["..."],
  "结尾习惯": ["..."],
  "口头禅": ["..."],
  "避免": ["..."]
}`;

/**
 * 风格蒸馏的请求体。
 *
 * 刻意只发 model / messages / temperature —— 与 /ai/rewrite 完全同构。
 * 那个接口在同一个 key、同一个模型下稳定可用，所以任何多出来的参数都是
 * 新增的风险面。之前多发了一个 max_tokens，正是两者当时唯一的结构差异。
 */
function buildStyleRequest(model, corpus, noteCount) {
  return {
    model,
    messages: sanitizeMessages([
      { role: 'system', content: STYLE_SYSTEM_PROMPT },
      { role: 'user', content: `以下是这个作者的 ${noteCount} 篇文案：\n\n${corpus}` },
    ]),
    temperature: 0.2,
  };
}

function normaliseProfile(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const strArray = (v, n) => (Array.isArray(v) ? v : [])
    .filter(x => typeof x === 'string' && x.trim())
    .slice(0, n)
    .map(x => truncate(x, 120));
  return {
    开头习惯: strArray(parsed['开头习惯'], 5),
    句长节奏: typeof parsed['句长节奏'] === 'string' ? truncate(parsed['句长节奏'], 200) : '',
    emoji: {
      密度: typeof parsed?.emoji?.['密度'] === 'string' ? truncate(parsed.emoji['密度'], 80) : '',
      位置: typeof parsed?.emoji?.['位置'] === 'string' ? truncate(parsed.emoji['位置'], 80) : '',
    },
    自称: typeof parsed['自称'] === 'string' ? truncate(parsed['自称'], 20) : '',
    高频标签: strArray(parsed['高频标签'], 15),
    结尾习惯: strArray(parsed['结尾习惯'], 5),
    口头禅: strArray(parsed['口头禅'], 12),
    避免: strArray(parsed['避免'], 12),
  };
}

// Score library notes against the keywords pulled out of an image, so the
// exemplars attached to a generation are about the same subject rather than
// whatever happens to be newest.
function scoreMaterial(material, keywords) {
  const tags = Array.isArray(material.tags) ? material.tags : [];
  const haystack = `${material.title || ''} ${material.content || ''}`.toLowerCase();
  let score = 0;
  for (const kw of keywords) {
    const k = kw.toLowerCase();
    if (!k) continue;
    // A tag match is a much stronger signal of topic than a body mention.
    if (tags.some(t => String(t).toLowerCase().includes(k) || k.includes(String(t).toLowerCase()))) score += 3;
    if (haystack.includes(k)) score += 1;
  }
  return score;
}

module.exports = function setupXhsWriter(app, pool) {

  // Ensure upload dir exists
  fsSync.mkdirSync(CONFIG.uploadDir, { recursive: true });

  // ====== Security middleware (optional, loaded if available) ======
  if (helmet) app.use(helmet({ contentSecurityPolicy: false }));
  if (compression) app.use(compression());

  // Probe optional columns once at boot, then keep retrying until the migration
  // lands so that applying it needs no restart.
  probeSchema(pool).then((found) => {
    if (found) return;
    const timer = setInterval(async () => {
      if (await probeSchema(pool)) clearInterval(timer);
    }, CONFIG.schemaRecheck);
    timer.unref();
  });

  // Automatic orphan sweep is opt-in. Deleting the user's files on a schedule
  // that nobody asked for is the kind of surprise you only get to cause once,
  // so the default is off and the dry-run endpoint is how you decide.
  log('info', 'Vision capability', {
    enabled: visionEnabled(),
    provider: visionConfig().provider,
    model: visionConfig().model || '(unset)',
    keyFrom: process.env.XHS_VISION_KEY ? 'XHS_VISION_KEY' : (process.env.XHS_AI_KEY ? 'XHS_AI_KEY(fallback)' : '(none)'),
  });

  if (process.env.XHS_UPLOAD_SWEEP === '1') {
    const daily = 24 * 60 * 60 * 1000;
    const sweepTimer = setInterval(() => {
      sweepOrphanUploads(pool).catch(err => log('error', 'Scheduled sweep failed', { error: err.message }));
    }, daily);
    sweepTimer.unref();
    log('info', 'Automatic upload sweep enabled', { ttlDays: uploadTtlMs() / daily });
  }

  // Uploaded images are served before auth on purpose: a browser <img> tag cannot
  // send an Authorization header, and the filenames carry 4 bytes of randomness.
  app.use('/api/xhs/uploads', express.static(CONFIG.uploadDir));

  // Body parser with size limit
  app.use('/api/xhs', express.json({ limit: CONFIG.bodyLimit }));

  // Health check — public, used by the deploy verifier and the health-check workflow
  app.get('/api/xhs/health', (req, res) => {
    res.json({
      ok: true,
      uptime: process.uptime(),
      authRequired: !!process.env.API_TOKEN,
      gallery: schemaFlags.hasImagesColumn,
      // The frontend hides the whole image-to-copy entry point unless this is true,
      // so an unconfigured vision model looks like "feature absent", never "error".
      vision: visionEnabled(),
      visionModel: visionConfig().model || null,
      visionProvider: visionConfig().provider,
      visionUsingDefault: visionConfig().usingDefault,
      // 文案模型也报出来：CD 从不上传 .env，服务器上钉死的 XHS_AI_MODEL 会一直
      // 覆盖代码里的默认值，而看不到它的人只会以为"代码推了就升级了"。
      // 摆到设置页上，"现在到底跑的是哪个型号"不用 SSH 就能自己确认。
      textModel: textConfig().model,
      textModelPinned: !!process.env.XHS_AI_MODEL,
      styleProfile: schemaFlags.hasStyleTable,
      styleMinSamples: CONFIG.styleMinSamples,
      templateSync: schemaFlags.hasTemplateTable,
    });
  });

  // Version fingerprint — 线上部署的 commit SHA，供健康检查做漂移检测
  app.get('/api/xhs/version', (req, res) => {
    res.json({ version: readVersionFile() });
  });

  // Token verify probe — passing requireAuth is the verification. Depends on
  // neither DB nor AI, so the frontend can validate a token before either is ready.
  app.get('/api/xhs/verify', requireAuth, (req, res) => {
    res.json({ ok: true, authRequired: !!process.env.API_TOKEN });
  });

  // Everything below this line requires a token whenever API_TOKEN is configured.
  app.use('/api/xhs', requireAuth);

  // GET /api/xhs/materials/tags — the full tag set, not just the loaded page.
  // Registered before /materials/:id so that "tags" is not parsed as an id.
  app.get('/api/xhs/materials/tags', async (req, res) => {
    try {
      const [rows] = await pool.query('SELECT tags FROM xhs_materials WHERE tags IS NOT NULL');
      const counts = new Map();
      for (const row of rows) {
        const tags = parseJsonColumn(row.tags, []);
        if (!Array.isArray(tags)) continue;
        for (const tag of tags) {
          if (typeof tag !== 'string' || !tag.trim()) continue;
          counts.set(tag, (counts.get(tag) || 0) + 1);
        }
      }
      const data = [...counts.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
      res.json({ data });
    } catch (err) {
      log('error', 'Tag list failed', { error: err.message });
      res.status(500).json({ error: { message: '获取标签失败' } });
    }
  });

  // GET /api/xhs/materials (with pagination, search/tag/sort)
  app.get('/api/xhs/materials', async (req, res) => {
    try {
      const { search, tag, sort, page, pageSize } = req.query;
      const limit = Math.min(parseInt(pageSize, 10) || CONFIG.defaultPageSize, CONFIG.maxPageSize);
      const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;

      const galleryCol = schemaFlags.hasImagesColumn ? ', images' : '';
      let sql = 'SELECT id, title, content, tags, prompt, created_at, image_url' + galleryCol +
        ', (image_data IS NOT NULL AND image_data != \'\') AS has_image_data FROM xhs_materials';
      const params = [];
      const conditions = [];

      if (search) {
        conditions.push('(title LIKE ? OR content LIKE ?)');
        const pattern = `%${escapeLikePattern(search)}%`;
        params.push(pattern, pattern);
      }
      if (tag) {
        conditions.push('JSON_CONTAINS(tags, ?)');
        params.push(JSON.stringify(tag));
      }
      if (conditions.length) {
        sql += ' WHERE ' + conditions.join(' AND ');
      }
      sql += sort === 'oldest' ? ' ORDER BY created_at ASC' : ' ORDER BY created_at DESC';
      sql += ' LIMIT ? OFFSET ?';
      params.push(limit, offset);

      const [rows] = await pool.query(sql, params);

      // Total count for pagination
      const countSql = 'SELECT COUNT(*) AS cnt FROM xhs_materials' + (conditions.length ? ' WHERE ' + conditions.join(' AND ') : '');
      const countParams = params.slice(0, params.length - 2);
      const [countRows] = await pool.query(countSql, countParams);
      const total = countRows[0].cnt;

      const materials = rows.map(r => {
        const images = parseJsonColumn(r.images, []);
        return {
          id: r.id,
          title: r.title,
          content: r.content,
          tags: parseJsonColumn(r.tags, []),
          prompt: r.prompt || '',
          hasImage: !!(r.image_url || r.has_image_data),
          imageUrl: r.image_url || undefined,
          images: Array.isArray(images) && images.length ? images : undefined,
          createdAt: r.created_at,
        };
      });
      res.json({ data: materials, total, page: Math.floor(offset / limit) + 1, pageSize: limit });
    } catch (err) {
      log('error', 'Materials list failed', { error: err.message });
      res.status(500).json({ error: { message: '获取素材列表失败' } });
    }
  });

  // GET /api/xhs/materials/:id (explicit columns, no SELECT *)
  app.get('/api/xhs/materials/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ error: { message: 'Invalid id' } });
      const galleryCol = schemaFlags.hasImagesColumn ? ', images' : '';
      const [rows] = await pool.query(
        'SELECT id, title, content, tags, image_url, image_data, prompt, created_at' + galleryCol +
        ' FROM xhs_materials WHERE id=?',
        [id]
      );
      if (!rows.length) return res.status(404).json({ error: { message: '素材不存在' } });
      const r = rows[0];
      const images = parseJsonColumn(r.images, []);
      res.json({
        id: r.id,
        title: r.title,
        content: r.content,
        tags: parseJsonColumn(r.tags, []),
        imageUrl: r.image_url || undefined,
        imageData: (!r.image_url && r.image_data) ? r.image_data : undefined,
        images: Array.isArray(images) && images.length ? images : undefined,
        prompt: r.prompt || '',
        createdAt: r.created_at,
      });
    } catch (err) {
      log('error', 'Material get failed', { id: req.params.id, error: err.message });
      res.status(500).json({ error: { message: '获取素材失败' } });
    }
  });

  // POST /api/xhs/materials
  app.post('/api/xhs/materials', writeRateLimit, async (req, res) => {
    try {
      const { title, content, tags, imageData, images, prompt } = req.body;
      if (!title || !content) return res.status(400).json({ error: { message: 'title and content required' } });

      // The gallery, when supplied, owns the cover: its first image is what the
      // card and the phone preview show. Resolving `imageData` as well would
      // write the same data URL to disk a second time.
      const gallery = await resolveGalleryInput(images);
      const imageUrl = gallery
        ? (gallery[0] || null)
        : (await resolveImageInput(imageData, null)).url;

      const cols = ['title', 'content', 'tags', 'image_url', 'prompt'];
      const vals = [title, content, JSON.stringify(tags || []), imageUrl, prompt || ''];
      if (gallery && schemaFlags.hasImagesColumn) {
        cols.push('images');
        vals.push(JSON.stringify(gallery));
      }
      const [result] = await pool.query(
        `INSERT INTO xhs_materials (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
        vals
      );
      res.json({ id: result.insertId });
    } catch (err) {
      log('error', 'Material create failed', { error: err.message });
      res.status(500).json({ error: { message: '保存素材失败' } });
    }
  });

  // PUT /api/xhs/materials/:id
  app.put('/api/xhs/materials/:id', writeRateLimit, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ error: { message: 'Invalid id' } });
      const { title, content, tags, imageData, images, prompt } = req.body;
      if (!title || !content) return res.status(400).json({ error: { message: 'title and content required' } });

      const galleryCol = schemaFlags.hasImagesColumn ? ', images' : '';
      const [existing] = await pool.query(
        'SELECT id, image_url' + galleryCol + ' FROM xhs_materials WHERE id=?', [id]
      );
      if (!existing.length) return res.status(404).json({ error: { message: '素材不存在' } });
      const oldImageUrl = existing[0].image_url;
      const oldGallery = parseJsonColumn(existing[0].images, []);

      // As in POST: the gallery owns the cover, so `imageData` is only consulted
      // when no gallery came in — otherwise the same image lands on disk twice.
      const gallery = await resolveGalleryInput(images);
      let imageUrl;
      let changed;
      if (gallery) {
        imageUrl = gallery[0] || null;
        changed = true;
      } else {
        const resolved = await resolveImageInput(imageData, oldImageUrl);
        imageUrl = resolved.url;
        changed = resolved.changed;
      }

      const fields = ['title=?', 'content=?', 'tags=?', 'prompt=?'];
      const values = [title, content, JSON.stringify(tags || []), prompt || ''];
      if (changed) {
        fields.push('image_url=?');
        values.push(imageUrl);
      }
      if (gallery && schemaFlags.hasImagesColumn) {
        fields.push('images=?');
        values.push(JSON.stringify(gallery));
      }
      values.push(id);
      await pool.query('UPDATE xhs_materials SET ' + fields.join(', ') + ' WHERE id=?', values);

      // Clean up files the update orphaned, only after it committed.
      if (gallery) {
        const keep = new Set([...gallery, imageUrl].filter(Boolean));
        await pruneImages([...(Array.isArray(oldGallery) ? oldGallery : []), oldImageUrl], [...keep]);
      } else if (changed && oldImageUrl && oldImageUrl !== imageUrl) {
        await deleteImageFile(oldImageUrl);
      }
      res.json({ ok: true });
    } catch (err) {
      log('error', 'Material update failed', { id: req.params.id, error: err.message });
      res.status(500).json({ error: { message: '更新素材失败' } });
    }
  });

  // DELETE /api/xhs/materials/:id
  app.delete('/api/xhs/materials/:id', writeRateLimit, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ error: { message: 'Invalid id' } });
      const galleryCol = schemaFlags.hasImagesColumn ? ', images' : '';
      const [rows] = await pool.query('SELECT image_url' + galleryCol + ' FROM xhs_materials WHERE id=?', [id]);
      if (!rows.length) return res.status(404).json({ error: { message: '素材不存在' } });
      const gallery = parseJsonColumn(rows[0].images, []);
      // 先删记录、后删文件（与 PUT 一致）：反过来的话删库失败时，
      // 记录还在、图片却已经没了，素材库里就是一张张裂图
      await pool.query('DELETE FROM xhs_materials WHERE id=?', [id]);
      await pruneImages([...(Array.isArray(gallery) ? gallery : []), rows[0].image_url], []);
      res.json({ ok: true });
    } catch (err) {
      log('error', 'Material delete failed', { id: req.params.id, error: err.message });
      res.status(500).json({ error: { message: '删除素材失败' } });
    }
  });

  // POST /api/xhs/materials/batch-delete
  app.post('/api/xhs/materials/batch-delete', writeRateLimit, async (req, res) => {
    try {
      const { ids } = req.body;
      if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: { message: 'ids array required' } });
      if (ids.length > CONFIG.batchDeleteMax) return res.status(400).json({ error: { message: `Maximum ${CONFIG.batchDeleteMax} items` } });

      const validIds = ids.filter(id => Number.isInteger(id) && id > 0);
      if (validIds.length === 0) return res.status(400).json({ error: { message: 'No valid ids' } });

      const galleryCol = schemaFlags.hasImagesColumn ? ', images' : '';
      const [rows] = await pool.query(
        'SELECT id, image_url' + galleryCol + ' FROM xhs_materials WHERE id IN (?)', [validIds]
      );
      await pool.query('DELETE FROM xhs_materials WHERE id IN (?)', [validIds]);
      for (const row of rows) {
        const gallery = parseJsonColumn(row.images, []);
        await pruneImages([...(Array.isArray(gallery) ? gallery : []), row.image_url], []);
      }
      res.json({ deleted: rows.length });
    } catch (err) {
      log('error', 'Batch delete failed', { error: err.message });
      res.status(500).json({ error: { message: '批量删除失败' } });
    }
  });

  // GET /api/xhs/history
  app.get('/api/xhs/history', async (req, res) => {
    try {
      const [rows] = await pool.query(
        'SELECT id, LEFT(prompt, 100) AS prompt, source_url, created_at FROM xhs_rewrite_history ORDER BY created_at DESC LIMIT 50'
      );
      res.json(rows.map(r => ({
        id: r.id,
        prompt: r.prompt,
        sourceUrl: r.source_url || undefined,
        createdAt: r.created_at,
      })));
    } catch (err) {
      log('error', 'History list failed', { error: err.message });
      res.status(500).json({ error: { message: '获取历史记录失败' } });
    }
  });

  // GET /api/xhs/history/:id (explicit columns)
  app.get('/api/xhs/history/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ error: { message: 'Invalid id' } });
      const [rows] = await pool.query(
        'SELECT id, prompt, source_url, results, created_at FROM xhs_rewrite_history WHERE id=?',
        [id]
      );
      if (!rows.length) return res.status(404).json({ error: { message: '历史记录不存在' } });
      const r = rows[0];
      res.json({
        id: r.id,
        prompt: r.prompt,
        sourceUrl: r.source_url || undefined,
        results: typeof r.results === 'string' ? JSON.parse(r.results) : (r.results || []),
        createdAt: r.created_at,
      });
    } catch (err) {
      log('error', 'History get failed', { id: req.params.id, error: err.message });
      res.status(500).json({ error: { message: '获取历史记录失败' } });
    }
  });

  // POST /api/xhs/history
  app.post('/api/xhs/history', writeRateLimit, async (req, res) => {
    try {
      const { prompt, results, sourceUrl } = req.body;
      if (!prompt) return res.status(400).json({ error: { message: 'prompt required' } });
      const [result] = await pool.query(
        'INSERT INTO xhs_rewrite_history (prompt, source_url, results) VALUES (?, ?, ?)',
        [truncate(prompt, 5000), sourceUrl || null, JSON.stringify(results || [])]
      );
      res.json({ id: result.insertId });
    } catch (err) {
      log('error', 'History create failed', { error: err.message });
      res.status(500).json({ error: { message: '保存历史记录失败' } });
    }
  });

  // DELETE /api/xhs/history/:id
  app.delete('/api/xhs/history/:id', writeRateLimit, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ error: { message: 'Invalid id' } });
      const [result] = await pool.query('DELETE FROM xhs_rewrite_history WHERE id=?', [id]);
      if (result.affectedRows === 0) return res.status(404).json({ error: { message: '历史记录不存在' } });
      res.json({ ok: true });
    } catch (err) {
      log('error', 'History delete failed', { id: req.params.id, error: err.message });
      res.status(500).json({ error: { message: '删除历史记录失败' } });
    }
  });

  // DELETE /api/xhs/history (clear all)
  app.delete('/api/xhs/history', writeRateLimit, async (req, res) => {
    try {
      const [result] = await pool.query('DELETE FROM xhs_rewrite_history');
      res.json({ deleted: result.affectedRows });
    } catch (err) {
      log('error', 'History clear failed', { error: err.message });
      res.status(500).json({ error: { message: '清空历史记录失败' } });
    }
  });

  // POST /api/xhs/ai/rewrite (with rate limiting, timeout, input validation)
  app.post('/api/xhs/ai/rewrite', aiRateLimit, async (req, res) => {
    try {
      const { messages, temperature } = req.body;

      // Input validation
      if (!messages || !Array.isArray(messages) || messages.length === 0 || messages.length > 10) {
        return res.status(400).json({ error: { message: 'messages must be an array of 1-10 items' } });
      }
      for (const msg of messages) {
        if (!msg.role || !msg.content || typeof msg.content !== 'string') {
          return res.status(400).json({ error: { message: 'Each message must have role and content' } });
        }
        if (msg.content.length > 20000) {
          return res.status(400).json({ error: { message: 'Message content too long (max 20000 chars)' } });
        }
      }

      const provider = process.env.XHS_AI_PROVIDER || 'deepseek';
      const apiKey = process.env.XHS_AI_KEY || '';
      const model = process.env.XHS_AI_MODEL || 'deepseek-chat';

      if (!apiKey) return res.status(500).json({ error: { message: 'AI 服务未配置' } });

      const endpoint = ENDPOINTS[provider];
      if (!endpoint) return res.status(400).json({ error: { message: 'Unsupported provider' } });

      // Clamp temperature to valid range [0, 2]
      const temp = Math.min(Math.max(parseFloat(temperature) || 0.8, 0), 2);

      const upstream = await fetch(endpoint, {
        method: 'POST',
        signal: AbortSignal.timeout(CONFIG.aiTimeout),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey,
        },
        body: JSON.stringify({ model, messages: sanitizeMessages(messages), temperature: temp }),
      });

      // Only pass through successful responses; upstream error details stay in server logs
      if (!upstream.ok) {
        const errBody = await upstream.text().catch(() => '');
        log('error', 'AI upstream returned error', {
          status: upstream.status, model, body: errBody.slice(0, 500),
        });
        return res.status(502).json({
          error: {
            message: upstreamErrorMessage(upstream.status),
            detail: extractUpstreamDetail(errBody),
            model,
          },
        });
      }
      const data = await upstream.json();
      // Let the client show how many generations are left in the window, so a
      // batch of 5 is not launched into a quota that only has 2 slots.
      res.set('X-RateLimit-Limit', String(CONFIG.aiRateMax));
      res.set('X-RateLimit-Remaining', String(aiQuotaRemaining(req)));
      res.json(data);
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        log('error', 'AI request timed out', { timeout: CONFIG.aiTimeout });
        return res.status(504).json({ error: { message: 'AI 服务响应超时，请重试' } });
      }
      log('error', 'AI rewrite failed', { error: err.message });
      res.status(502).json({ error: { message: 'AI 服务暂时不可用' } });
    }
  });

  // POST /api/xhs/ai/vision — read an image into structured, confirmable facts.
  // Deliberately a separate route from /ai/rewrite: that one enforces string
  // content, and loosening it there would let arbitrary payloads reach the text
  // model too. This route accepts exactly one image and nothing else.
  app.post('/api/xhs/ai/vision', visionRateLimit, async (req, res) => {
    // 读图常常要几十秒，逼近甚至超过反向代理的默认读超时（nginx 通常是 60s）。
    // 一旦超过，代理会认为连接空闲并主动断开，浏览器只能看到一个笼统的网络
    // 错误——状态码、错误详情全部丢失，看起来像是"看图成文坏了"，其实只是
    // 代理等得不耐烦。committed 之后周期性写入一个空格保持连接有字节流出；
    // 空格是合法的 JSON 前导空白，JSON.parse 会自动忽略，不影响最终解析。
    //
    // 副作用：一旦提交了 200，HTTP 状态码就再也改不了，所有结果（成功/超时/
    // 上游报错）都只能靠响应体里的 error 字段区分——apiJson() 已经改成不再
    // 只看 res.ok，也会检查 body.error。
    let heartbeat = null;
    let committed = false;
    const stopHeartbeat = () => {
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    };
    const send = (status, body) => {
      stopHeartbeat();
      if (committed) {
        res.end(JSON.stringify(body));
      } else {
        res.status(status).json(body);
      }
    };
    try {
      if (!visionEnabled()) {
        return send(503, { error: { message: '未配置视觉模型，看图成文功能不可用' } });
      }

      // Accept a list; `image` stays supported so older clients keep working.
      const requested = Array.isArray(req.body?.images)
        ? req.body.images
        : (req.body?.image ? [req.body.image] : []);
      if (!requested.length) {
        return send(400, { error: { message: '请先选择图片' } });
      }

      const dataUrls = [];
      for (const entry of requested.slice(0, CONFIG.visionMaxImages)) {
        const resolved = await resolveVisionImage(entry);
        if (resolved) dataUrls.push(resolved);
      }
      if (!dataUrls.length) {
        return send(400, { error: { message: '图片无效：仅支持 jpg/png/webp，且需在体积上限内' } });
      }

      // 校验都做完了，接下来是真正调用上游模型的慢操作，开始心跳。
      res.status(200);
      res.set('Content-Type', 'application/json; charset=utf-8');
      committed = true;
      heartbeat = setInterval(() => {
        try {
          if (!res.writableEnded) res.write(' ');
        } catch { /* 客户端可能已断开，心跳本来就是尽力而为 */ }
      }, CONFIG.visionHeartbeatMs);

      const data = await callVisionModel(dataUrls);
      const raw = data?.choices?.[0]?.message?.content;
      const result = parseVisionResult(typeof raw === 'string' ? raw : '');
      if (!result) {
        log('error', 'Vision reply could not be parsed', { sample: String(raw).slice(0, 300) });
        return send(502, { error: { message: '读图结果解析失败，请重试' } });
      }

      log('info', 'Vision extraction done', {
        images: dataUrls.length,
        facts: result.facts.length,
        lowConfidence: result.facts.filter(f => f.confidence === 'low').length,
        hasText: result.hasText,
      });
      send(200, {
        ...result,
        imagesRead: dataUrls.length,
        quotaRemaining: visionQuotaRemaining(req),
        quotaLimit: CONFIG.visionRateMax,
      });
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        return send(504, { error: { message: '读图超时，请重试或换一张更小的图片' } });
      }
      log('error', 'Vision request failed', { error: err.message, status: err.status, model: err.model });
      // 不写死哪家能读图 —— 各家的多模态型号一直在变，写死必然过时。
      // 报错要指名道姓地说是哪个型号失败的：候选链降级过之后，失败的往往不是
      // 首选那个，说"当前为 X"会把人指向错误的方向。
      const failed = err.model || visionConfig().model;
      const hint = err.status === 400 || err.status === 404
        ? `；请确认 XHS_VISION_MODEL（本次实际调用的是 ${failed || '未设置'}）是一个支持图片输入的型号`
        : '';
      send(502, {
        error: {
          message: upstreamErrorMessage(err.status || 502, '读图服务') + hint,
          detail: err.detail || '',
          model: failed,
        },
      });
    }
  });

  // GET /api/xhs/style/profile — the cached writing-style profile, plus whether
  // the library is even large enough to build one.
  app.get('/api/xhs/style/profile', async (req, res) => {
    try {
      const [countRows] = await pool.query('SELECT COUNT(*) AS cnt FROM xhs_materials');
      const sampleCount = countRows[0].cnt;

      let profile = null;
      let updatedAt = null;
      if (schemaFlags.hasStyleTable) {
        const [rows] = await pool.query(
          'SELECT profile, sample_count, updated_at FROM xhs_style_profile WHERE id=1'
        );
        if (rows.length) {
          profile = parseJsonColumn(rows[0].profile, null);
          updatedAt = rows[0].updated_at;
        }
      }

      res.json({
        profile,
        updatedAt,
        sampleCount,
        minSamples: CONFIG.styleMinSamples,
        ready: sampleCount >= CONFIG.styleMinSamples,
        cacheAvailable: schemaFlags.hasStyleTable,
      });
    } catch (err) {
      log('error', 'Style profile read failed', { error: err.message });
      res.status(500).json({ error: { message: '获取风格画像失败' } });
    }
  });

  // POST /api/xhs/style/profile — rebuild by distilling the library, or accept a
  // hand-edited profile. Distilling costs a text call, so it shares the AI bucket.
  app.post('/api/xhs/style/profile', async (req, res) => {
    try {
      // Manual override: the profile is human-readable on purpose, so letting the
      // user correct it directly is cheaper and better than re-rolling the model.
      // This never calls the AI, so it must not sit behind aiRateLimit — a user
      // fixing a typo in their own profile should never trip "AI 请求已达上限".
      if (req.body?.profile) {
        const manual = normaliseProfile(req.body.profile);
        if (!manual) return res.status(400).json({ error: { message: '风格画像格式不正确' } });
        // Same graceful-degradation contract as the distilled path below: without
        // migrations/002 the edit still succeeds and is handed back to the client,
        // it just isn't persisted server-side. The client caches it in
        // localStorage either way, so an edit is never silently lost.
        if (schemaFlags.hasStyleTable) {
          await pool.query(
            `INSERT INTO xhs_style_profile (id, profile, sample_count) VALUES (1, ?, ?)
             ON DUPLICATE KEY UPDATE profile=VALUES(profile), sample_count=VALUES(sample_count)`,
            [JSON.stringify(manual), 0]
          );
        }
        return res.json({ profile: manual, source: 'manual', cached: schemaFlags.hasStyleTable });
      }

      // Only the distillation path below calls the AI, so the quota is only
      // charged here. aiRateLimit is synchronous — if it allows the request it
      // calls next() in the same tick, so checking the flag right after is safe.
      let allowed = false;
      aiRateLimit(req, res, () => { allowed = true; });
      if (!allowed) return; // aiRateLimit already sent the 429

      const [countRows] = await pool.query('SELECT COUNT(*) AS cnt FROM xhs_materials');
      const sampleCount = countRows[0].cnt;
      if (sampleCount < CONFIG.styleMinSamples) {
        return res.status(400).json({
          error: { message: `素材不足：需要至少 ${CONFIG.styleMinSamples} 篇，当前 ${sampleCount} 篇` },
        });
      }

      const cfg = textConfig();
      if (!cfg.key) return res.status(500).json({ error: { message: 'AI 服务未配置' } });
      const endpoint = ENDPOINTS[cfg.provider];
      if (!endpoint) return res.status(400).json({ error: { message: 'Unsupported provider' } });

      const [rows] = await pool.query(
        'SELECT title, content, tags FROM xhs_materials ORDER BY created_at DESC LIMIT ?',
        [CONFIG.styleMaxSamples]
      );

      // Take notes until the character budget runs out rather than always taking
      // all 60: style is legible from a couple of dozen excerpts, and an
      // over-long prompt is what got this endpoint rejected upstream.
      const parts = [];
      let used = 0;
      for (const r of rows) {
        const tags = parseJsonColumn(r.tags, []);
        const tagLine = Array.isArray(tags) && tags.length ? `\n标签：${tags.join('、')}` : '';
        const block = `【第 ${parts.length + 1} 篇】\n标题：${truncate(r.title, 60)}\n正文：${truncate(r.content, CONFIG.styleExcerptChars)}${tagLine}`;
        if (used + block.length > CONFIG.styleMaxChars) break;
        parts.push(block);
        used += block.length;
      }
      const corpus = parts.join('\n\n');
      if (!parts.length) {
        return res.status(400).json({ error: { message: '素材内容为空，无法分析风格' } });
      }
      log('info', 'Style corpus built', { notes: parts.length, chars: used, available: rows.length });

      const upstream = await fetch(endpoint, {
        method: 'POST',
        signal: AbortSignal.timeout(CONFIG.aiTimeout),
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.key },
        body: JSON.stringify(buildStyleRequest(cfg.model, corpus, parts.length)),
      });

      if (!upstream.ok) {
        const errBody = await upstream.text().catch(() => '');
        const detail = extractUpstreamDetail(errBody);
        log('error', 'Style distill upstream error', {
          status: upstream.status, chars: used, notes: parts.length,
          model: cfg.model, body: errBody.slice(0, 500),
        });
        return res.status(502).json({
          error: { message: upstreamErrorMessage(upstream.status), detail, model: cfg.model },
        });
      }

      const data = await upstream.json();
      const raw = data?.choices?.[0]?.message?.content || '';
      const match = raw.match(/\{[\s\S]*\}/);
      let profile = null;
      if (match) {
        try { profile = normaliseProfile(JSON.parse(match[0])); } catch { profile = null; }
      }
      if (!profile) {
        return res.status(502).json({ error: { message: '风格画像解析失败，请重试' } });
      }

      if (schemaFlags.hasStyleTable) {
        await pool.query(
          `INSERT INTO xhs_style_profile (id, profile, sample_count) VALUES (1, ?, ?)
           ON DUPLICATE KEY UPDATE profile=VALUES(profile), sample_count=VALUES(sample_count)`,
          [JSON.stringify(profile), parts.length]
        );
      }
      log('info', 'Style profile rebuilt', { samples: parts.length, cached: schemaFlags.hasStyleTable });
      res.json({ profile, sampleCount: parts.length, cached: schemaFlags.hasStyleTable, source: 'distilled' });
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        return res.status(504).json({ error: { message: '风格分析超时，请重试' } });
      }
      log('error', 'Style profile rebuild failed', { error: err.message });
      res.status(502).json({ error: { message: '风格分析失败，请稍后重试' } });
    }
  });

  // GET /api/xhs/style/examples?keywords=a,b,c — the few library notes most on
  // topic for what the image turned out to be about.
  app.get('/api/xhs/style/examples', async (req, res) => {
    try {
      const keywords = String(req.query.keywords || '')
        .split(',')
        .map(k => k.trim())
        .filter(Boolean)
        .slice(0, 12);

      const limit = Math.min(parseInt(req.query.limit, 10) || CONFIG.styleExampleCount, 5);
      const [rows] = await pool.query(
        'SELECT id, title, content, tags FROM xhs_materials ORDER BY created_at DESC LIMIT ?',
        [CONFIG.styleMaxSamples]
      );

      const scored = rows.map(r => {
        const material = { title: r.title, content: r.content, tags: parseJsonColumn(r.tags, []) };
        return { id: r.id, ...material, score: keywords.length ? scoreMaterial(material, keywords) : 0 };
      });

      // With no keywords, or nothing matching, the newest notes are still a fair
      // sample of how this person writes — better than returning nothing.
      scored.sort((a, b) => b.score - a.score);
      const picked = scored.slice(0, limit).map(m => ({
        id: m.id,
        title: m.title,
        content: truncate(m.content, 800),
        tags: m.tags,
        score: m.score,
      }));

      res.json({ data: picked, matched: picked.some(p => p.score > 0) });
    } catch (err) {
      log('error', 'Style examples failed', { error: err.message });
      res.status(500).json({ error: { message: '获取风格样例失败' } });
    }
  });

  // ====== Custom templates (cloud sync) ======
  // Templates are a user's accumulated asset. They used to live only in
  // localStorage, so clearing site data or switching device lost them.
  // The client keeps localStorage as its render cache and treats this as the
  // durable copy; when the table is missing it just stays local-only.
  app.get('/api/xhs/templates', async (req, res) => {
    if (!schemaFlags.hasTemplateTable) return res.json({ data: [], available: false });
    try {
      const [rows] = await pool.query(
        'SELECT id, name, icon, description, system_prompt, updated_at FROM xhs_templates ORDER BY created_at ASC'
      );
      res.json({
        available: true,
        data: rows.map(r => ({
          id: r.id,
          name: r.name,
          icon: r.icon || '📝',
          description: r.description || '',
          systemPrompt: r.system_prompt,
          isCustom: true,
          updatedAt: r.updated_at,
        })),
      });
    } catch (err) {
      log('error', 'Template list failed', { error: err.message });
      res.status(500).json({ error: { message: '获取模板失败' } });
    }
  });

  // Upsert by id so the client can push a locally-created template as-is and
  // keep the same id on both sides — no id reconciliation needed.
  app.put('/api/xhs/templates/:id', writeRateLimit, async (req, res) => {
    if (!schemaFlags.hasTemplateTable) {
      return res.status(503).json({ error: { message: '模板表尚未创建，请先执行 migrations/003' } });
    }
    try {
      const id = String(req.params.id || '').slice(0, 64);
      if (!/^[A-Za-z0-9_-]+$/.test(id)) {
        return res.status(400).json({ error: { message: '模板 id 不合法' } });
      }
      const { name, icon, description, systemPrompt } = req.body || {};
      if (!name || !systemPrompt) {
        return res.status(400).json({ error: { message: 'name and systemPrompt required' } });
      }
      if (String(systemPrompt).length > 8000) {
        return res.status(400).json({ error: { message: 'systemPrompt 过长（上限 8000 字）' } });
      }
      await pool.query(
        `INSERT INTO xhs_templates (id, name, icon, description, system_prompt)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE name=VALUES(name), icon=VALUES(icon),
           description=VALUES(description), system_prompt=VALUES(system_prompt)`,
        [id, truncate(name, 60), truncate(icon || '📝', 8),
         truncate(description, 200), String(systemPrompt)]
      );
      res.json({ ok: true, id });
    } catch (err) {
      log('error', 'Template upsert failed', { id: req.params.id, error: err.message });
      res.status(500).json({ error: { message: '保存模板失败' } });
    }
  });

  app.delete('/api/xhs/templates/:id', writeRateLimit, async (req, res) => {
    if (!schemaFlags.hasTemplateTable) return res.json({ ok: true, available: false });
    try {
      await pool.query('DELETE FROM xhs_templates WHERE id=?', [String(req.params.id).slice(0, 64)]);
      res.json({ ok: true });
    } catch (err) {
      log('error', 'Template delete failed', { id: req.params.id, error: err.message });
      res.status(500).json({ error: { message: '删除模板失败' } });
    }
  });

  // GET /api/xhs/uploads-orphans — dry run. Always safe: reports only.
  app.get('/api/xhs/uploads-orphans', async (req, res) => {
    try {
      const report = await findOrphanUploads(pool);
      res.json({
        orphanCount: report.orphans.length,
        bytes: report.bytes,
        scanned: report.scanned,
        referenced: report.referenced,
        ttlDays: uploadTtlMs() / (24 * 60 * 60 * 1000),
        autoSweep: process.env.XHS_UPLOAD_SWEEP === '1',
        sample: report.orphans.slice(0, 20),
      });
    } catch (err) {
      log('error', 'Orphan scan failed', { error: err.message });
      res.status(500).json({ error: { message: '扫描失败' } });
    }
  });

  // POST /api/xhs/uploads-sweep — actually deletes. Separate verb from the
  // dry run on purpose: nothing removes files without an explicit POST.
  app.post('/api/xhs/uploads-sweep', writeRateLimit, async (req, res) => {
    try {
      const report = await sweepOrphanUploads(pool);
      res.json({ deleted: report.deleted, bytes: report.bytes, scanned: report.scanned });
    } catch (err) {
      log('error', 'Upload sweep failed', { error: err.message });
      res.status(500).json({ error: { message: '清理失败' } });
    }
  });

  // POST /api/xhs/extract — 链接 → 标题 / 正文 / 话题 / 配图
  app.post('/api/xhs/extract', writeRateLimit, async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: { message: 'url required' } });

    if (typeof url !== 'string' || !isAllowedNoteUrl(url)) {
      return res.status(400).json({ error: { message: '仅支持小红书链接' } });
    }

    try {
      const note = await extractNote(url);
      if (!note.ok) {
        return res.status(422).json({ error: { message: EXTRACT_FAILURE_MESSAGES[note.reason] || EXTRACT_FAILURE_MESSAGES.empty } });
      }
      // 图片失败不拖累正文：拿不到图也照样把文字给用户
      let images = [];
      try {
        images = await downloadImagesParallel(note.imageUrls);
      } catch (imgErr) {
        log('error', 'Image extraction failed', { noteId: note.noteId, error: imgErr.message });
      }
      res.json({ title: note.title, content: note.content, tags: note.tags, images });
    } catch (err) {
      log('error', 'Extract failed', { url, error: err.message });
      if (err.message.includes('非预期域名')) {
        return res.status(422).json({ error: { message: err.message } });
      }
      res.status(500).json({ error: { message: '提取失败，请稍后重试' } });
    }
  });

  // NOTE: process lifecycle (SIGTERM/SIGINT, server.close, pool.end) is owned by src/index.js.
};

// Test hooks — not part of the public API surface
module.exports._test = {
  CONFIG,
  readVersionFile,
  isAllowedImageDomain,
  isAllowedNoteUrl,
  isShortLinkUrl,
  saveImageFile,
  deleteImageFile,
  resolveImageInput,
  resolveGalleryInput,
  parseJsonColumn,
  requireAuth,
  rateLimitKey,
  aiRateLimit,
  aiRateLimits,
  aiQuotaRemaining,
  writeRateLimit,
  writeRateLimits,
  visionConfig,
  visionEnabled,
  visionRateLimit,
  visionRateLimits,
  visionQuotaRemaining,
  parseVisionResult,
  resolveVisionImage,
  buildVisionContent,
  isUnknownModelError,
  escapeLikePattern,
  DEFAULT_VISION_MODELS,
  VISION_SYSTEM_PROMPT,
  normaliseProfile,
  scoreMaterial,
  uploadTtlMs,
  findOrphanUploads,
  sweepOrphanUploads,
  referencedUploadNames,
  schemaFlags,
  upstreamErrorMessage,
  extractUpstreamDetail,
  buildStyleRequest,
  truncate,
  stripLoneSurrogates,
  sanitizeMessages,
  parseNoteUrl,
  noteRefFromHtml,
  resolveNoteRef,
  noteFetchPlan,
  fetchXhsPage,
  parseInitialState,
  pickNoteFromState,
  pickImageUrl,
  noteContentFromState,
  legacyNoteFromHtml,
  extractNote,
  EXTRACT_FAILURE_MESSAGES,
  downloadImagesParallel,
};
