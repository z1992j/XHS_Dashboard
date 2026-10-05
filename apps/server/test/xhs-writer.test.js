// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 使用独立临时目录，避免污染仓库
const TMP_UPLOAD = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-test-'));
process.env.XHS_UPLOAD_DIR = TMP_UPLOAD;
process.env.API_TOKEN = 'test-token-abc';

// 动态加载（在 env 设置后）
const { _test } = await import('../src/xhs-writer.js');
const {
  isAllowedImageDomain, isAllowedNoteUrl, isShortLinkUrl, saveImageFile, resolveImageInput,
  resolveGalleryInput, parseJsonColumn, requireAuth, rateLimitKey, aiRateLimits, aiRateLimit,
  aiQuotaRemaining, writeRateLimit, writeRateLimits, readVersionFile, CONFIG,
  visionConfig, visionEnabled, visionRateLimit, visionRateLimits, visionQuotaRemaining,
  parseVisionResult, resolveVisionImage, normaliseProfile, scoreMaterial,
  uploadTtlMs, findOrphanUploads, sweepOrphanUploads, referencedUploadNames, schemaFlags,
  upstreamErrorMessage, extractUpstreamDetail, buildStyleRequest,
  truncate, stripLoneSurrogates, sanitizeMessages,
  parseNoteUrl, noteRefFromHtml, resolveNoteRef, noteFetchPlan, fetchXhsPage,
  parseInitialState, pickNoteFromState, pickImageUrl, noteContentFromState,
  legacyNoteFromHtml, extractNote, EXTRACT_FAILURE_MESSAGES, downloadImagesParallel,
} = _test;

describe('readVersionFile — 版本指纹', () => {
  it('文件存在时返回去空白后的内容', () => {
    const f = path.join(TMP_UPLOAD, 'VERSION');
    fs.writeFileSync(f, 'abc123def\n');
    expect(readVersionFile(f)).toBe('abc123def');
  });
  it('文件不存在时返回 unknown', () => {
    expect(readVersionFile(path.join(TMP_UPLOAD, 'no-such-VERSION'))).toBe('unknown');
  });
});

describe('isAllowedImageDomain — SSRF 白名单', () => {
  it('接受白名单主域', () => {
    expect(isAllowedImageDomain('https://xiaohongshu.com/x.jpg')).toBe(true);
    expect(isAllowedImageDomain('https://xhscdn.com/x.jpg')).toBe(true);
  });
  it('接受白名单子域', () => {
    expect(isAllowedImageDomain('https://sns-img.xhscdn.com/a.png')).toBe(true);
    expect(isAllowedImageDomain('https://www.xiaohongshu.com/x.jpg')).toBe(true);
  });
  it('拒绝伪装为后缀的攻击域名', () => {
    expect(isAllowedImageDomain('https://fakexhscdn.com/x.jpg')).toBe(false);
    expect(isAllowedImageDomain('https://evil.com/xhscdn.com/x.jpg')).toBe(false);
    expect(isAllowedImageDomain('https://xhscdn.com.evil.com/x.jpg')).toBe(false);
  });
  it('拒绝非法 URL', () => {
    expect(isAllowedImageDomain('not-a-url')).toBe(false);
    expect(isAllowedImageDomain('')).toBe(false);
  });
});

describe('saveImageFile — 扩展名白名单与体积上限', () => {
  const validPngBase64 =
    'data:image/png;base64,' +
    Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');

  it('保存合法 png', async () => {
    const rel = await saveImageFile(validPngBase64);
    expect(rel).toMatch(/^\/api\/xhs\/uploads\/\d+_[a-f0-9]+\.png$/);
    const abs = path.join(TMP_UPLOAD, path.basename(rel));
    expect(fs.existsSync(abs)).toBe(true);
  });

  it('拒绝 SVG（XSS 载体）— 返回 null', async () => {
    const svg = 'data:image/svg+xml;base64,' + Buffer.from('<svg/>').toString('base64');
    expect(await saveImageFile(svg)).toBe(null);
  });

  it('拒绝未知扩展名 gif — 返回 null', async () => {
    const gif = 'data:image/gif;base64,' + Buffer.from('GIF').toString('base64');
    expect(await saveImageFile(gif)).toBe(null);
  });

  it('拒绝格式非法 base64 — 返回 null', async () => {
    expect(await saveImageFile('not-base64')).toBe(null);
  });

  it('拒绝超过 imageMaxSize 的图片 — 返回 null', async () => {
    const bigBuf = Buffer.alloc(CONFIG.imageMaxSize + 1024, 0x89);
    const big = 'data:image/png;base64,' + bigBuf.toString('base64');
    expect(await saveImageFile(big)).toBe(null);
  });
});

describe('resolveImageInput — 明确移除 vs 保持', () => {
  it('空字符串代表明确删除', async () => {
    const r = await resolveImageInput('', '/api/xhs/uploads/xhs_old.png');
    expect(r.url).toBe(null);
    expect(r.changed).toBe(true);
  });

  it('undefined 代表保持不变', async () => {
    const r = await resolveImageInput(undefined, '/api/xhs/uploads/xhs_old.png');
    expect(r.changed).toBe(false);
    expect(r.url).toBe('/api/xhs/uploads/xhs_old.png');
  });

  it('已有 /api/xhs/uploads/ 路径且未变化 changed=false', async () => {
    const r = await resolveImageInput('/api/xhs/uploads/xhs_x.png', '/api/xhs/uploads/xhs_x.png');
    expect(r.url).toBe('/api/xhs/uploads/xhs_x.png');
    expect(r.changed).toBe(false);
  });

  it('替换为不同的 uploads 路径 changed=true', async () => {
    const r = await resolveImageInput('/api/xhs/uploads/xhs_new.png', '/api/xhs/uploads/xhs_old.png');
    expect(r.url).toBe('/api/xhs/uploads/xhs_new.png');
    expect(r.changed).toBe(true);
  });

  it('data:image base64 会保存并返回新 url', async () => {
    const validPngBase64 =
      'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
    const r = await resolveImageInput(validPngBase64, null);
    expect(r.url).toMatch(/^\/api\/xhs\/uploads\/\d+_[a-f0-9]+\.png$/);
    expect(r.changed).toBe(true);
  });
});

describe('rateLimitKey — 基于 token 的桶键', () => {
  it('有 Bearer token 时按 token 哈希分桶', () => {
    const req = { headers: { authorization: 'Bearer abc123' }, ip: '1.1.1.1', query: {} };
    const k1 = rateLimitKey(req);
    const req2 = { headers: { authorization: 'Bearer abc123' }, ip: '9.9.9.9', query: {} };
    const k2 = rateLimitKey(req2);
    expect(k1).toBe(k2);
    expect(k1.startsWith('tk:')).toBe(true);
  });

  it('无 token 时降级为 IP', () => {
    const req = { headers: {}, ip: '2.2.2.2', query: {} };
    const k = rateLimitKey(req);
    expect(k).toBe('ip:2.2.2.2');
  });

  it('不同 token 分不同桶', () => {
    const a = rateLimitKey({ headers: { authorization: 'Bearer AAA' }, query: {} });
    const b = rateLimitKey({ headers: { authorization: 'Bearer BBB' }, query: {} });
    expect(a).not.toBe(b);
  });
});

describe('aiRateLimit — 达到上限返回 429', () => {
  beforeEach(() => {
    aiRateLimits.clear();
  });

  const mkReq = (tok = 'usr1') => ({ headers: { authorization: `Bearer ${tok}` }, query: {} });
  const mkRes = () => {
    const res = { statusCode: 200, body: null, headers: {} };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    res.set = (k, v) => { res.headers[k] = v; return res; };
    return res;
  };

  it('在窗口内消耗完 tokens 后返回 429', () => {
    const req = mkReq('u-limit');
    let nextCalls = 0;
    const next = () => nextCalls++;
    for (let i = 0; i < CONFIG.aiRateMax; i++) {
      aiRateLimit(req, mkRes(), next);
    }
    expect(nextCalls).toBe(CONFIG.aiRateMax);
    const res = mkRes();
    aiRateLimit(req, res, next);
    expect(res.statusCode).toBe(429);
    // 提示里要带上具体额度和重试时间，用户才知道等多久
    expect(res.body?.error?.message).toMatch(/已达上限/);
    expect(res.body?.error?.message).toContain(String(CONFIG.aiRateMax));
    expect(res.headers['X-RateLimit-Remaining']).toBe('0');
  });

  it('不同 token 不互相干扰', () => {
    let nextCalls = 0;
    const next = () => nextCalls++;
    for (let i = 0; i < CONFIG.aiRateMax; i++) {
      aiRateLimit(mkReq('A'), mkRes(), next);
    }
    // A 已耗尽，B 仍应放行
    const res = mkRes();
    aiRateLimit(mkReq('B'), res, next);
    expect(res.statusCode).toBe(200);
    expect(nextCalls).toBe(CONFIG.aiRateMax + 1);
  });
});

describe('isAllowedNoteUrl — 提取接口的 SSRF 入口校验', () => {
  it('接受正常的小红书链接', () => {
    expect(isAllowedNoteUrl('https://www.xiaohongshu.com/explore/abc123')).toBe(true);
    expect(isAllowedNoteUrl('https://xiaohongshu.com/discovery/item/x')).toBe(true);
    expect(isAllowedNoteUrl('https://xhslink.com/a/xyz')).toBe(true);
    expect(isAllowedNoteUrl('https://xhslink.cn/q/abc')).toBe(true);
  });

  it('拒绝把白名单域名藏在查询参数/fragment 里的内网地址', () => {
    // 这是修复前的真实绕过：子串匹配会放行下面全部四条
    expect(isAllowedNoteUrl('http://169.254.169.254/latest/meta-data/?ref=xiaohongshu.com')).toBe(false);
    expect(isAllowedNoteUrl('http://127.0.0.1:3306/#xiaohongshu.com')).toBe(false);
    expect(isAllowedNoteUrl('http://internal-admin.local/?x=xhslink.com')).toBe(false);
    expect(isAllowedNoteUrl('http://10.0.0.1/admin?from=https://xiaohongshu.com/')).toBe(false);
  });

  it('拒绝后缀伪装域名', () => {
    expect(isAllowedNoteUrl('https://xiaohongshu.com.evil.net/a')).toBe(false);
    expect(isAllowedNoteUrl('https://fakexhslink.com/a')).toBe(false);
  });

  it('拒绝非 http(s) 协议', () => {
    expect(isAllowedNoteUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedNoteUrl('gopher://xiaohongshu.com/')).toBe(false);
  });

  it('拒绝非法输入', () => {
    expect(isAllowedNoteUrl('not-a-url')).toBe(false);
    expect(isAllowedNoteUrl('')).toBe(false);
  });
});

describe('isShortLinkUrl — 只认短链域名', () => {
  it('识别 xhslink 主域与子域', () => {
    expect(isShortLinkUrl('https://xhslink.com/a')).toBe(true);
    expect(isShortLinkUrl('https://www.xhslink.cn/a')).toBe(true);
  });

  it('小红书正式域名不算短链', () => {
    expect(isShortLinkUrl('https://www.xiaohongshu.com/explore/a')).toBe(false);
  });
});

describe('requireAuth — 仅在配置了 API_TOKEN 时生效', () => {
  const mkRes = () => {
    const res = { statusCode: 200, body: null, headers: {} };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    res.set = (k, v) => { res.headers[k] = v; return res; };
    return res;
  };

  afterEach(() => { delete process.env.API_TOKEN; });

  it('未配置 API_TOKEN 时一律放行（保持现网免登录行为）', () => {
    delete process.env.API_TOKEN;
    let called = 0;
    requireAuth({ headers: {} }, mkRes(), () => called++);
    expect(called).toBe(1);
  });

  it('配置后，正确令牌放行', () => {
    process.env.API_TOKEN = 'secret-token';
    let called = 0;
    requireAuth({ headers: { authorization: 'Bearer secret-token' } }, mkRes(), () => called++);
    expect(called).toBe(1);
  });

  it('配置后，缺令牌返回 401', () => {
    process.env.API_TOKEN = 'secret-token';
    const res = mkRes();
    requireAuth({ headers: {} }, res, () => { throw new Error('should not pass'); });
    expect(res.statusCode).toBe(401);
  });

  it('配置后，错误令牌返回 401', () => {
    process.env.API_TOKEN = 'secret-token';
    const res = mkRes();
    requireAuth({ headers: { authorization: 'Bearer wrong' } }, res, () => { throw new Error('should not pass'); });
    expect(res.statusCode).toBe(401);
  });

  it('长度不同的令牌不会因 timingSafeEqual 抛错', () => {
    process.env.API_TOKEN = 'secret-token';
    const res = mkRes();
    expect(() => requireAuth({ headers: { authorization: 'Bearer x' } }, res, () => {})).not.toThrow();
    expect(res.statusCode).toBe(401);
  });
});

describe('resolveGalleryInput — 图集入库', () => {
  it('非数组返回 null（代表调用方没传，保持原样）', async () => {
    expect(await resolveGalleryInput(undefined)).toBe(null);
    expect(await resolveGalleryInput('x')).toBe(null);
  });

  it('保留已存在的 uploads 路径', async () => {
    const r = await resolveGalleryInput(['/api/xhs/uploads/a.jpg', '/api/xhs/uploads/b.png']);
    expect(r).toEqual(['/api/xhs/uploads/a.jpg', '/api/xhs/uploads/b.png']);
  });

  it('丢弃外部 URL 和垃圾数据', async () => {
    const r = await resolveGalleryInput(['https://evil.com/a.jpg', 42, null, '/etc/passwd']);
    expect(r).toEqual([]);
  });

  it('最多保留 9 张', async () => {
    const many = Array.from({ length: 20 }, (_, i) => `/api/xhs/uploads/${i}.jpg`);
    expect((await resolveGalleryInput(many)).length).toBe(CONFIG.maxGalleryImages);
  });

  it('data:image 会落盘并转成 uploads 路径', async () => {
    const png = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
    const r = await resolveGalleryInput([png]);
    expect(r[0]).toMatch(/^\/api\/xhs\/uploads\/\d+_[a-f0-9]+\.png$/);
  });
});

describe('parseJsonColumn — 兼容驱动返回的字符串/对象两种形态', () => {
  it('字符串会被解析', () => {
    expect(parseJsonColumn('["a","b"]', [])).toEqual(['a', 'b']);
  });
  it('已是对象时原样返回', () => {
    expect(parseJsonColumn(['a'], [])).toEqual(['a']);
  });
  it('null 返回兜底值', () => {
    expect(parseJsonColumn(null, [])).toEqual([]);
  });
  it('坏 JSON 返回兜底值而不是抛错', () => {
    expect(parseJsonColumn('{not json', [])).toEqual([]);
  });
});

describe('aiQuotaRemaining — 剩余额度不消耗配额', () => {
  beforeEach(() => { aiRateLimits.clear(); });

  it('全新调用方拿到满额', () => {
    expect(aiQuotaRemaining({ headers: { authorization: 'Bearer fresh' }, query: {} })).toBe(CONFIG.aiRateMax);
  });

  it('消耗后剩余额度相应减少', () => {
    const req = { headers: { authorization: 'Bearer spend' }, query: {} };
    const res = { status: () => res, json: () => res, set: () => res };
    aiRateLimit(req, res, () => {});
    aiRateLimit(req, res, () => {});
    expect(aiQuotaRemaining(req)).toBe(CONFIG.aiRateMax - 2);
  });

  it('查询本身不消耗配额', () => {
    const req = { headers: { authorization: 'Bearer peek' }, query: {} };
    const res = { status: () => res, json: () => res, set: () => res };
    aiRateLimit(req, res, () => {});
    const first = aiQuotaRemaining(req);
    aiQuotaRemaining(req);
    expect(aiQuotaRemaining(req)).toBe(first);
  });
});

describe('writeRateLimit — 写操作独立配额', () => {
  beforeEach(() => { writeRateLimits.clear(); });

  const mkRes = () => {
    const res = { statusCode: 200, body: null, headers: {} };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    res.set = (k, v) => { res.headers[k] = v; return res; };
    return res;
  };

  it('额度内放行', () => {
    const req = { headers: { authorization: 'Bearer w1' }, query: {} };
    let called = 0;
    for (let i = 0; i < CONFIG.writeRateMax; i++) writeRateLimit(req, mkRes(), () => called++);
    expect(called).toBe(CONFIG.writeRateMax);
  });

  it('超出后返回 429', () => {
    const req = { headers: { authorization: 'Bearer w2' }, query: {} };
    for (let i = 0; i < CONFIG.writeRateMax; i++) writeRateLimit(req, mkRes(), () => {});
    const res = mkRes();
    writeRateLimit(req, res, () => { throw new Error('should not pass'); });
    expect(res.statusCode).toBe(429);
  });

  it('写配额与 AI 配额互不影响', () => {
    aiRateLimits.clear();
    const req = { headers: { authorization: 'Bearer w3' }, query: {} };
    for (let i = 0; i < CONFIG.writeRateMax; i++) writeRateLimit(req, mkRes(), () => {});
    expect(aiQuotaRemaining(req)).toBe(CONFIG.aiRateMax);
  });
});

describe('visionEnabled — 开关是模型，不是 Key', () => {
  afterEach(() => {
    for (const k of ['XHS_VISION_KEY', 'XHS_VISION_PROVIDER', 'XHS_VISION_MODEL',
                     'XHS_AI_KEY', 'XHS_AI_PROVIDER']) delete process.env[k];
  });

  it('有 Key 就自动启用 —— 模型名不是密钥，默认值写在代码里，推代码即可用', () => {
    process.env.XHS_AI_PROVIDER = 'deepseek';
    process.env.XHS_AI_KEY = 'k';
    expect(visionEnabled()).toBe(true);
    expect(visionConfig().model).toBe('deepseek-v4-flash-vision-exp');
    expect(visionConfig().usingDefault).toBe(true);
  });

  it('默认值按 provider 匹配，不会拿甲家的 Key 去调乙家的模型', () => {
    process.env.XHS_AI_PROVIDER = 'dashscope';
    process.env.XHS_AI_KEY = 'k';
    expect(visionConfig().model).toBe('qwen-vl-max');
  });

  it('没有任何 Key 时为 false —— 全新部署不会凭空开启', () => {
    expect(visionEnabled()).toBe(false);
  });

  it('XHS_VISION_MODEL=off 可显式关闭', () => {
    process.env.XHS_AI_KEY = 'k';
    for (const v of ['off', 'none', 'false', 'disabled', '0', 'OFF']) {
      process.env.XHS_VISION_MODEL = v;
      expect(visionEnabled()).toBe(false);
      expect(visionConfig().disabled).toBe(true);
    }
  });

  it('显式指定的型号优先于默认值', () => {
    process.env.XHS_AI_KEY = 'k';
    process.env.XHS_VISION_MODEL = 'my-own-vl';
    expect(visionConfig().model).toBe('my-own-vl');
    expect(visionConfig().usingDefault).toBe(false);
  });

  it('指定模型后沿用文案模型的 Key 和 provider —— 同平台不必再配一套', () => {
    process.env.XHS_AI_KEY = 'shared-key';
    process.env.XHS_AI_PROVIDER = 'deepseek';
    process.env.XHS_VISION_MODEL = 'deepseek-v4-flash-vision-exp';
    expect(visionEnabled()).toBe(true);
    const cfg = visionConfig();
    expect(cfg.key).toBe('shared-key');
    expect(cfg.provider).toBe('deepseek');
    expect(cfg.model).toBe('deepseek-v4-flash-vision-exp');
  });

  it('独立配置优先于回落值 —— 想换别家就三个都填', () => {
    process.env.XHS_AI_KEY = 'text-key';
    process.env.XHS_AI_PROVIDER = 'deepseek';
    process.env.XHS_VISION_KEY = 'vision-key';
    process.env.XHS_VISION_PROVIDER = 'dashscope';
    process.env.XHS_VISION_MODEL = 'qwen-vl-max';
    const cfg = visionConfig();
    expect(cfg.key).toBe('vision-key');
    expect(cfg.provider).toBe('dashscope');
    expect(visionEnabled()).toBe(true);
  });

  it('provider 不认识时为 false，不会去请求未知端点', () => {
    process.env.XHS_VISION_KEY = 'k';
    process.env.XHS_VISION_MODEL = 'm';
    process.env.XHS_VISION_PROVIDER = 'nonexistent';
    expect(visionEnabled()).toBe(false);
  });

  it('未知 provider 没有默认模型，也不会启用', () => {
    process.env.XHS_AI_KEY = 'k';
    process.env.XHS_VISION_PROVIDER = 'nonexistent';
    expect(visionConfig().model).toBe('');
    expect(visionEnabled()).toBe(false);
  });

  it('默认值是一条候选链，首选之后还有稳定别名兜底', () => {
    // -vision-exp 是 V4.1 Flash 之前的实验分支，正式版发布后随时会下线；
    // 后面跟一个稳定别名，型号更替时读图不会跟着一起死
    process.env.XHS_AI_PROVIDER = 'deepseek';
    process.env.XHS_AI_KEY = 'k';
    const cfg = visionConfig();
    expect(cfg.models.length).toBeGreaterThan(1);
    expect(cfg.models[0]).toBe(cfg.model);
    expect(cfg.models).toContain('deepseek-chat');
  });

  it('显式指定型号时只用这一个，不背着人再去试别的', () => {
    // 人写死了型号就是要它；偷偷降级到另一个模型会让"我指定了 A"变成"实际跑的是 B"
    process.env.XHS_AI_KEY = 'k';
    process.env.XHS_VISION_MODEL = 'my-own-vl';
    expect(visionConfig().models).toEqual(['my-own-vl']);
  });

  it('关闭时候选链为空', () => {
    process.env.XHS_AI_KEY = 'k';
    process.env.XHS_VISION_MODEL = 'off';
    expect(visionConfig().models).toEqual([]);
  });

  it('默认候选链里不含带过期日期的内测型号 —— 那种 ID 到期即失效', () => {
    // deepseek-v4.1-flash-expires-on-0910 这类 ID 名字里就写着哪天过期，
    // 写进代码等于埋定时炸弹
    for (const chain of Object.values(_test.DEFAULT_VISION_MODELS)) {
      for (const m of chain) expect(m).not.toMatch(/expires?-on/i);
    }
  });
});

describe('isUnknownModelError — 只有型号问题才值得换候选重试', () => {
  it('404 一律算型号不存在', () => {
    // OpenAI 兼容端点路径固定，能收到 404 基本只可能是模型名不对
    expect(_test.isUnknownModelError(404, '')).toBe(true);
  });

  it('400 且报错原文提到 model/模型时才算', () => {
    expect(_test.isUnknownModelError(400, 'Model Not Exist')).toBe(true);
    expect(_test.isUnknownModelError(400, '模型不存在')).toBe(true);
  });

  it('400 但原因是别的（体积、内容）时不换候选', () => {
    // 换个型号一样会因为同样的原因失败，白烧一次调用
    expect(_test.isUnknownModelError(400, 'Failed to parse the request body as JSON')).toBe(false);
    expect(_test.isUnknownModelError(400, '')).toBe(false);
  });

  it('限流/鉴权/余额/服务端异常都不换候选', () => {
    for (const s of [401, 402, 403, 429, 500, 502, 503]) {
      expect(_test.isUnknownModelError(s, 'model')).toBe(false);
    }
  });
});

describe('resolveVisionImage — 只接受自家图片，杜绝代抓', () => {
  it('接受合法 data URL', async () => {
    const png = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
    expect(await resolveVisionImage(png)).toBe(png);
  });

  it('拒绝任意 http(s) 地址（否则等于替攻击者抓取）', async () => {
    expect(await resolveVisionImage('https://evil.com/a.jpg')).toBe(null);
    expect(await resolveVisionImage('http://169.254.169.254/meta')).toBe(null);
  });

  it('拒绝 SVG 等非白名单格式', async () => {
    const svg = 'data:image/svg+xml;base64,' + Buffer.from('<svg/>').toString('base64');
    expect(await resolveVisionImage(svg)).toBe(null);
  });

  it('拒绝 uploads 路径穿越', async () => {
    expect(await resolveVisionImage('/api/xhs/uploads/../../etc/passwd')).toBe(null);
    expect(await resolveVisionImage('/api/xhs/uploads/a/b.png')).toBe(null);
  });

  it('拒绝空值与非字符串', async () => {
    expect(await resolveVisionImage('')).toBe(null);
    expect(await resolveVisionImage(null)).toBe(null);
    expect(await resolveVisionImage(42)).toBe(null);
  });

  it('读取真实存在的 uploads 文件并转成 data URL', async () => {
    const rel = await saveImageFile('data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'));
    const out = await resolveVisionImage(rel);
    expect(out).toMatch(/^data:image\/png;base64,/);
  });

  it('uploads 里不存在的文件返回 null', async () => {
    expect(await resolveVisionImage('/api/xhs/uploads/does-not-exist.png')).toBe(null);
  });
});

describe('parseVisionResult — 事实归一化', () => {
  it('解析出场景与事实', () => {
    const r = parseVisionResult(JSON.stringify({
      scene: '资费单页', hasText: true,
      facts: [{ key: '月费', value: '59 元', confidence: 'high' }],
      warnings: ['含二维码'],
    }));
    expect(r.scene).toBe('资费单页');
    expect(r.facts).toEqual([{ key: '月费', value: '59 元', confidence: 'high' }]);
    expect(r.warnings).toEqual(['含二维码']);
  });

  it('未明确标注 high 的一律降级为 low —— 宁可多让人核对一条', () => {
    const r = parseVisionResult(JSON.stringify({
      facts: [
        { key: 'a', value: '1' },
        { key: 'b', value: '2', confidence: 'medium' },
        { key: 'c', value: '3', confidence: 'high' },
      ],
    }));
    expect(r.facts.map(f => f.confidence)).toEqual(['low', 'low', 'high']);
  });

  it('容忍模型在 JSON 前后夹带解释文字', () => {
    const r = parseVisionResult('好的，结果如下：\n{"scene":"x","facts":[]}\n以上。');
    expect(r.scene).toBe('x');
  });

  it('丢弃结构不完整的事实条目', () => {
    const r = parseVisionResult(JSON.stringify({ facts: [{ value: '缺 key' }, { key: '缺 value' }, null] }));
    expect(r.facts).toEqual([]);
  });

  it('无法解析时返回 null 而不是抛错', () => {
    expect(parseVisionResult('完全不是 JSON')).toBe(null);
    expect(parseVisionResult('{坏 JSON')).toBe(null);
    expect(parseVisionResult(null)).toBe(null);
  });

  it('hasText 只有显式 false 才算没有文字', () => {
    expect(parseVisionResult('{"hasText":false,"facts":[]}').hasText).toBe(false);
    expect(parseVisionResult('{"facts":[]}').hasText).toBe(true);
  });
});

describe('normaliseProfile — 风格画像结构化', () => {
  it('保留已知字段', () => {
    const p = normaliseProfile({
      开头习惯: ['先抛结论'], 句长节奏: '长短交替', 自称: '我',
      emoji: { 密度: '每段1-2个', 位置: '句尾' },
      高频标签: ['宽带办理'], 结尾习惯: ['引导评论'], 口头禅: ['说实话'], 避免: ['综上所述'],
    });
    expect(p.开头习惯).toEqual(['先抛结论']);
    expect(p.emoji.密度).toBe('每段1-2个');
    expect(p.高频标签).toEqual(['宽带办理']);
  });

  it('过滤非字符串条目', () => {
    expect(normaliseProfile({ 口头禅: ['ok', 42, null, { a: 1 }] }).口头禅).toEqual(['ok']);
  });

  it('缺字段时给出空值而不是 undefined', () => {
    const p = normaliseProfile({});
    expect(p.开头习惯).toEqual([]);
    expect(p.句长节奏).toBe('');
    expect(p.emoji.密度).toBe('');
  });

  it('非对象返回 null', () => {
    expect(normaliseProfile(null)).toBe(null);
    expect(normaliseProfile('x')).toBe(null);
  });
});

describe('scoreMaterial — 标签命中权重高于正文', () => {
  const m = { title: '上海移动宽带', content: '500M 每月 59 元', tags: ['宽带办理', '上海'] };

  it('标签命中得分高于正文命中', () => {
    const tagHit = scoreMaterial(m, ['宽带办理']);
    const bodyHit = scoreMaterial(m, ['500M']);
    expect(tagHit).toBeGreaterThan(bodyHit);
  });

  it('多个关键词累加', () => {
    expect(scoreMaterial(m, ['宽带办理', '上海'])).toBeGreaterThan(scoreMaterial(m, ['宽带办理']));
  });

  it('毫不相干的关键词得 0', () => {
    expect(scoreMaterial(m, ['螺蛳粉'])).toBe(0);
  });

  it('空关键词表得 0，不抛错', () => {
    expect(scoreMaterial(m, [])).toBe(0);
  });

  it('缺字段的素材不抛错', () => {
    expect(scoreMaterial({}, ['x'])).toBe(0);
  });
});

describe('visionRateLimit — 独立且更小的配额', () => {
  beforeEach(() => { visionRateLimits.clear(); aiRateLimits.clear(); });

  const mkRes = () => {
    const res = { statusCode: 200, body: null, headers: {} };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    res.set = (k, v) => { res.headers[k] = v; return res; };
    return res;
  };

  it('额度比文本额度小', () => {
    expect(CONFIG.visionRateMax).toBeLessThan(CONFIG.aiRateMax);
  });

  it('用尽后返回 429 并带上剩余额度头', () => {
    const req = { headers: { authorization: 'Bearer v1' }, query: {} };
    for (let i = 0; i < CONFIG.visionRateMax; i++) visionRateLimit(req, mkRes(), () => {});
    const res = mkRes();
    visionRateLimit(req, res, () => { throw new Error('should not pass'); });
    expect(res.statusCode).toBe(429);
    expect(res.headers['X-Vision-Remaining']).toBe('0');
  });

  it('读图配额与文案配额互不影响', () => {
    const req = { headers: { authorization: 'Bearer v2' }, query: {} };
    for (let i = 0; i < CONFIG.visionRateMax; i++) visionRateLimit(req, mkRes(), () => {});
    expect(visionQuotaRemaining(req)).toBe(0);
    expect(aiQuotaRemaining(req)).toBe(CONFIG.aiRateMax);
  });
});

describe('uploadTtlMs — 回收宽限期', () => {
  afterEach(() => { delete process.env.XHS_UPLOAD_TTL_DAYS; });

  it('默认 7 天', () => {
    expect(uploadTtlMs()).toBe(7 * 24 * 3600 * 1000);
  });

  it('可通过环境变量调整', () => {
    process.env.XHS_UPLOAD_TTL_DAYS = '2';
    expect(uploadTtlMs()).toBe(2 * 24 * 3600 * 1000);
  });

  it('非法值回退到 7 天，不会退化成 0（否则会删掉刚下载的图）', () => {
    for (const bad of ['0', '-3', 'abc', '']) {
      process.env.XHS_UPLOAD_TTL_DAYS = bad;
      expect(uploadTtlMs()).toBe(7 * 24 * 3600 * 1000);
    }
  });
});

describe('孤儿图片回收', () => {
  // 造一个假 pool：只需要回答 SELECT image_url... 这一条查询
  const mkPool = (rows) => ({ query: async () => [rows] });
  const old = new Date(Date.now() - 30 * 24 * 3600 * 1000);

  const writeUpload = (name, mtime) => {
    const abs = path.join(TMP_UPLOAD, name);
    fs.writeFileSync(abs, 'x');
    if (mtime) fs.utimesSync(abs, mtime, mtime);
    return abs;
  };

  beforeEach(() => {
    for (const f of fs.readdirSync(TMP_UPLOAD)) {
      const abs = path.join(TMP_UPLOAD, f);
      if (fs.statSync(abs).isFile()) fs.unlinkSync(abs);
    }
    schemaFlags.hasImagesColumn = false;
  });

  it('referencedUploadNames 收集 image_url 引用', async () => {
    const names = await referencedUploadNames(mkPool([{ image_url: '/api/xhs/uploads/a.jpg' }]));
    expect(names.has('a.jpg')).toBe(true);
  });

  it('图集列存在时也收集 images 数组里的引用', async () => {
    schemaFlags.hasImagesColumn = true;
    const names = await referencedUploadNames(mkPool([
      { image_url: '/api/xhs/uploads/a.jpg', images: '["/api/xhs/uploads/b.png","/api/xhs/uploads/c.webp"]' },
    ]));
    expect([...names].sort()).toEqual(['a.jpg', 'b.png', 'c.webp']);
  });

  it('被引用的文件不算孤儿', async () => {
    writeUpload('kept.jpg', old);
    const r = await findOrphanUploads(mkPool([{ image_url: '/api/xhs/uploads/kept.jpg' }]));
    expect(r.orphans.map(o => o.name)).not.toContain('kept.jpg');
  });

  it('未被引用且足够旧的算孤儿', async () => {
    writeUpload('orphan.jpg', old);
    const r = await findOrphanUploads(mkPool([]));
    expect(r.orphans.map(o => o.name)).toContain('orphan.jpg');
  });

  it('未被引用但还很新的不动 —— 草稿里可能正引用着它', async () => {
    writeUpload('fresh.jpg');
    const r = await findOrphanUploads(mkPool([]));
    expect(r.orphans.map(o => o.name)).not.toContain('fresh.jpg');
  });

  it('干跑不删任何文件', async () => {
    writeUpload('orphan2.jpg', old);
    await findOrphanUploads(mkPool([]));
    expect(fs.existsSync(path.join(TMP_UPLOAD, 'orphan2.jpg'))).toBe(true);
  });

  it('sweep 只删孤儿，保留被引用的和新文件', async () => {
    writeUpload('gone.jpg', old);
    writeUpload('kept2.jpg', old);
    writeUpload('young.jpg');
    const r = await sweepOrphanUploads(mkPool([{ image_url: '/api/xhs/uploads/kept2.jpg' }]));
    expect(r.deleted).toBe(1);
    expect(fs.existsSync(path.join(TMP_UPLOAD, 'gone.jpg'))).toBe(false);
    expect(fs.existsSync(path.join(TMP_UPLOAD, 'kept2.jpg'))).toBe(true);
    expect(fs.existsSync(path.join(TMP_UPLOAD, 'young.jpg'))).toBe(true);
  });

  it('统计里带上可回收字节数', async () => {
    writeUpload('big.jpg', old);
    const r = await findOrphanUploads(mkPool([]));
    expect(r.bytes).toBeGreaterThan(0);
  });
});

describe('upstreamErrorMessage — 上游失败要说得出原因', () => {
  it('把常见状态码翻译成可执行的提示，而不是笼统的「不可用」', () => {
    expect(upstreamErrorMessage(400)).toMatch(/内容过长|参数/);
    expect(upstreamErrorMessage(401)).toMatch(/Key/);
    expect(upstreamErrorMessage(402)).toMatch(/余额/);
    expect(upstreamErrorMessage(403)).toMatch(/权限/);
    expect(upstreamErrorMessage(404)).toMatch(/模型/);
    expect(upstreamErrorMessage(429)).toMatch(/限流/);
    expect(upstreamErrorMessage(503)).toMatch(/上游异常/);
  });

  it('每条消息都带上状态码，方便报障时说清楚', () => {
    for (const code of [400, 401, 402, 403, 404, 429, 500, 503]) {
      expect(upstreamErrorMessage(code)).toContain(String(code));
    }
  });

  it('可以自定义主语，读图和文案的报错能区分开', () => {
    expect(upstreamErrorMessage(402, '读图服务')).toContain('读图服务');
    expect(upstreamErrorMessage(402)).toContain('AI 服务');
  });

  it('未知状态码也有兜底文案', () => {
    expect(upstreamErrorMessage(418)).toContain('418');
  });

  it('不回显上游返回的正文', () => {
    // 只根据状态码生成，不接收 body 参数，天然不会泄漏上游细节
    expect(upstreamErrorMessage.length).toBeLessThanOrEqual(2);
  });
});

describe('风格蒸馏语料预算', () => {
  it('单条消息上限低于 /ai/rewrite 已验证可用的 20000 字', () => {
    expect(CONFIG.styleMaxChars).toBeLessThan(20000);
  });

  it('摘录长度足以听出语气但不浪费', () => {
    expect(CONFIG.styleExcerptChars).toBeGreaterThanOrEqual(200);
    expect(CONFIG.styleExcerptChars).toBeLessThanOrEqual(600);
  });

  it('按预算截断后，最坏情况仍不超上限', () => {
    // 复刻服务端的拼装逻辑，验证预算真的收敛
    let used = 0, notes = 0;
    for (let i = 0; i < CONFIG.styleMaxSamples; i++) {
      const block = `【第 ${i + 1} 篇】\n标题：${'标'.repeat(60)}\n正文：${'文'.repeat(CONFIG.styleExcerptChars)}\n标签：${'签'.repeat(40)}`;
      if (used + block.length > CONFIG.styleMaxChars) break;
      used += block.length;
      notes++;
    }
    expect(used).toBeLessThanOrEqual(CONFIG.styleMaxChars);
    expect(notes).toBeGreaterThanOrEqual(CONFIG.styleMinSamples);
  });

  it('预算下仍能取到不少于门槛篇数的素材，否则功能等于白开', () => {
    const perNote = CONFIG.styleExcerptChars + 120;
    expect(Math.floor(CONFIG.styleMaxChars / perNote)).toBeGreaterThanOrEqual(CONFIG.styleMinSamples);
  });
});

describe('多图读取', () => {
  it('一次最多读 4 张 —— 图集能放 9 张，但按张计费', () => {
    expect(CONFIG.visionMaxImages).toBe(4);
    expect(CONFIG.visionMaxImages).toBeLessThan(CONFIG.maxGalleryImages);
  });

  it('提示词交代了多图时要合并、冲突要标出来', () => {
    // 两张图的月费对不上却悄悄挑一个，正是这个功能最危险的失败方式
    const p = _test.VISION_SYSTEM_PROMPT;
    expect(p).toContain('多张图');
    expect(p).toMatch(/合并/);
    expect(p).toMatch(/不一致|对不上/);
  });

  it('提示词明确排除小红书号等截图水印，不当成套餐信息提取', () => {
    // 小红书截图自带账号名、点赞数这些界面元素，模型如果不加区分地照单全收，
    // 会把和资费无关的东西也塞进 facts 里
    const p = _test.VISION_SYSTEM_PROMPT;
    expect(p).toMatch(/小红书号|昵称|水印/);
    expect(p).toMatch(/不要.{0,6}(提取|当成|写)/);
  });

  it('facts 的 key 是一份明确的白名单，不是"尽量"从里面选', () => {
    // "尽量从这些里选"给模型留了口子，可以自己发明新 key（比如把水印文字
    // 当成一个新字段塞进去）；改成"只能从这里面选"才是真的收紧
    const p = _test.VISION_SYSTEM_PROMPT;
    expect(p).toMatch(/只能从.{0,10}选/);
    expect(p).not.toMatch(/尽量从/);
  });

  it('多图仍然走一次调用，提示词和回复只付一次钱', () => {
    // buildVisionContent 把 N 张图放进同一条 user message
    const content = _test.buildVisionContent(['data:image/png;base64,a', 'data:image/png;base64,b']);
    expect(content.filter(c => c.type === 'image_url')).toHaveLength(2);
    expect(content.filter(c => c.type === 'text')).toHaveLength(1);
  });

  it('单图和多图的引导语不同', () => {
    expect(_test.buildVisionContent(['x'])[0].text).not.toContain('合并');
    expect(_test.buildVisionContent(['x', 'y'])[0].text).toContain('合并');
  });
});

describe('extractUpstreamDetail — 把上游的解释带回去，但不泄漏密钥', () => {
  it('取 OpenAI 兼容格式里的 error.message', () => {
    const body = JSON.stringify({ error: { message: 'max_tokens is not supported', type: 'invalid_request_error' } });
    expect(extractUpstreamDetail(body)).toBe('max_tokens is not supported');
  });

  it('也支持顶层 message', () => {
    expect(extractUpstreamDetail(JSON.stringify({ message: '模型不存在' }))).toBe('模型不存在');
  });

  it('不是 JSON 时退回原文压缩空白', () => {
    expect(extractUpstreamDetail('  Bad   Request \n gateway ')).toBe('Bad Request gateway');
  });

  it('抹掉形如 API Key 的字符串', () => {
    const out = extractUpstreamDetail(JSON.stringify({ error: { message: 'bad key sk-abcdef1234567890 given' } }));
    expect(out).not.toContain('sk-abcdef1234567890');
    expect(out).toContain('<redacted>');
  });

  it('抹掉长十六进制串', () => {
    const out = extractUpstreamDetail('trace ' + 'a1b2c3d4'.repeat(6));
    expect(out).toContain('<redacted>');
  });

  it('截断到 300 字以内', () => {
    expect(extractUpstreamDetail('x'.repeat(1000)).length).toBeLessThanOrEqual(300);
  });

  it('空输入返回空串，不抛错', () => {
    expect(extractUpstreamDetail('')).toBe('');
    expect(extractUpstreamDetail(null)).toBe('');
  });
});

describe('风格蒸馏请求结构 —— 与仿写保持同构', () => {
  const body = buildStyleRequest('deepseek-chat', '语料', 3);

  it('只发 model / messages / temperature 三个字段', () => {
    expect(Object.keys(body).sort()).toEqual(['messages', 'model', 'temperature']);
  });

  it('不含 max_tokens —— 多出来的参数是新增的风险面', () => {
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('max_completion_tokens');
  });

  it('消息内容是字符串，不是多模态数组', () => {
    for (const m of body.messages) expect(typeof m.content).toBe('string');
  });

  it('用户消息里带上真实篇数和语料', () => {
    expect(body.messages[1].content).toContain('3 篇');
    expect(body.messages[1].content).toContain('语料');
  });
});

describe('truncate — 按码点截断，不切开 emoji', () => {
  // 上游曾因此返回：unexpected end of hex escape at line 1 column 9654
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const emojiText = '办宽带真的香🎉每月只要59元💰速度稳定👍';

  it('截断后绝不留下孤立代理项', () => {
    for (let n = 1; n <= [...emojiText].length + 2; n++) {
      expect(lone.test(truncate(emojiText, n))).toBe(false);
    }
  });

  it('结果按码点计不超过上限', () => {
    for (let n = 1; n <= 20; n++) {
      expect([...truncate(emojiText, n)].length).toBeLessThanOrEqual(n);
    }
  });

  it('未超长时原样返回', () => {
    expect(truncate('短文本', 100)).toBe('短文本');
  });

  it('容忍 null / undefined / 数字', () => {
    expect(truncate(null, 10)).toBe('');
    expect(truncate(undefined, 10)).toBe('');
    expect(truncate(123, 10)).toBe('123');
  });

  it('对比原生 slice：原生会切坏，truncate 不会', () => {
    const cut = emojiText.indexOf('🎉') + 1;
    expect(lone.test(emojiText.slice(0, cut))).toBe(true);   // 旧写法
    expect(lone.test(truncate(emojiText, cut))).toBe(false); // 新写法
  });
});

describe('stripLoneSurrogates / sanitizeMessages — 出口兜底', () => {
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const dirty = '你好' + '\uD83D' + '世界';   // 数据库旧记录可能就长这样

  it('清掉孤立代理项', () => {
    expect(lone.test(stripLoneSurrogates(dirty))).toBe(false);
    expect(stripLoneSurrogates(dirty)).toBe('你好世界');
  });

  it('完整 emoji 不受影响', () => {
    expect(stripLoneSurrogates('好👍的')).toBe('好👍的');
  });

  it('清洗后一定能被严格 JSON 解析', () => {
    const body = JSON.stringify({ content: stripLoneSurrogates(dirty) });
    expect(/\\ud[89ab][0-9a-f]{2}/i.test(body)).toBe(false);
  });

  it('sanitizeMessages 处理字符串消息', () => {
    const out = sanitizeMessages([{ role: 'user', content: dirty }]);
    expect(lone.test(out[0].content)).toBe(false);
  });

  it('sanitizeMessages 也处理多模态数组里的 text 段', () => {
    const out = sanitizeMessages([{
      role: 'user',
      content: [{ type: 'text', text: dirty }, { type: 'image_url', image_url: { url: 'data:image/png;base64,x' } }],
    }]);
    expect(lone.test(out[0].content[0].text)).toBe(false);
    expect(out[0].content[1].image_url.url).toBe('data:image/png;base64,x');
  });

  it('干净输入原样返回', () => {
    const clean = [{ role: 'system', content: '正常内容👍' }];
    expect(sanitizeMessages(clean)[0].content).toBe('正常内容👍');
  });
});

describe('escapeLikePattern — 搜索词里的通配符不该当通配符用', () => {
  it('% 被转义 —— 否则搜一个 % 就能把整库捞出来', () => {
    expect(_test.escapeLikePattern('100%')).toBe('100\\%');
  });

  it('_ 被转义 —— 否则搜 "3_0" 会连 "300" 一起命中', () => {
    expect(_test.escapeLikePattern('3_0')).toBe('3\\_0');
  });

  it('反斜杠先于其它字符转义，不会把新加的转义符再转一遍', () => {
    expect(_test.escapeLikePattern('a\\b')).toBe('a\\\\b');
    // 反斜杠+百分号：两者都要各自转义，且顺序不能乱
    expect(_test.escapeLikePattern('\\%')).toBe('\\\\\\%');
  });

  it('普通中文和空值原样通过', () => {
    expect(_test.escapeLikePattern('广州宽带')).toBe('广州宽带');
    expect(_test.escapeLikePattern(null)).toBe('');
    expect(_test.escapeLikePattern(undefined)).toBe('');
  });
});

describe('downloadImage —— 重定向后必须复检白名单', () => {
  it('源码里对 resp.url 做了复检，而不是只查初始 URL', () => {
    // 跟随重定向后不复检，白名单域上的开放重定向就能把请求带去内网。
    // 同文件的 resolveShortUrl 一直是复检的，这里此前漏了。
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'xhs-writer.js'), 'utf8'
    );
    const fn = src.slice(src.indexOf('async function downloadImage'));
    const body = fn.slice(0, fn.indexOf('\nasync function'));
    expect(body).toMatch(/isAllowedImageDomain\(\s*resp\.url/);
  });
});

// ====== 小红书笔记抓取 ======
// 夹具照 2026-10 在 GitHub Actions 海外 runner 上逐跳实测到的真实结构构造：
// 短链 302 → /discovery/item/；该页对手机 UA 200 + SSR，对电脑 UA 一律 302 /login。

const NOTE_ID = '6abdfa090000000014032f24';
const TOKEN = 'CBg-hj9a1G8Wg5BPhRKcaRfcTmyLGtB28IiAVk1PM5YPo=';
const SHORT = 'https://xhslink.cn/o/6DzDoSPjwzk';
const SHARE_TARGET = `https://www.xiaohongshu.com/discovery/item/${NOTE_ID}?app_platform=ios&app_version=9.48`
  + `&xsec_source=app_share&type=normal&xsec_token=${encodeURIComponent(TOKEN)}&xhsshare=CopyLink`;

/** 照真实页面拼一份 SSR：URL 里的斜杠转义成 /，还带一个 JS 字面量 undefined。 */
function mobileSharePage(note = {}) {
  const state = {
    global: { x: null },
    fakeModal: {},
    noteData: {
      routeQuery: { xsec_source: 'app_share' },
      data: {
        noteData: {
          noteId: NOTE_ID,
          type: 'normal',
          title: '江苏宽带国庆价！无锡300M仅220🔥',
          desc: '江苏的宝子们！国庆前办宽带真的能省一笔💰\n300M → 299元/年 #江苏宽带[话题]# #无锡宽带[话题]#',
          tagList: [
            { id: '1', name: '江苏宽带', type: 'topic' },
            { id: '2', name: '无锡宽带', type: 'topic' },
            { id: '3', name: '联通宽带', type: 'topic' },
          ],
          imageList: [{
            width: 1440,
            url: 'http://sns-webpic-qc.xhscdn.com/a/prv1',
            infoList: [
              { imageScene: 'H5_DTL', url: 'http://sns-webpic-qc.xhscdn.com/a/dtl1' },
              { imageScene: 'H5_PRV', url: 'http://sns-webpic-qc.xhscdn.com/a/prv1' },
            ],
          }],
          ...note,
        },
        // 同一份 state 里挂着别人的笔记 —— 取错一篇比取不到更糟
        relatedNotes: [{ noteId: 'a'.repeat(24), title: '别人的笔记', desc: '别人的正文' }],
      },
    },
  };
  const js = JSON.stringify(state).replace(/\//g, '\\u002F').replace('"x":null', '"x":undefined');
  return `<html><head><title>小红书</title></head><body><script>window.__INITIAL_STATE__=${js}</script></body></html>`;
}

/** 登录页也有一份 __INITIAL_STATE__ —— 正是它把旧实现骗过去的。 */
const LOGIN_PAGE = '<html><head><title>小红书 - 你的生活兴趣社区</title></head><body>'
  + '<script>window.__INITIAL_STATE__={"global":{},"user":{},"feed":{},"login":{}}</script></body></html>';

const isMobile = (opts) => /iPhone/.test(opts?.headers?.['User-Agent'] || '');

/** 按 URL 应答的假 fetch，顺带记下每次请求，好断言「哪些地址根本没被请求过」。 */
function fakeFetch(route) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, mobile: isMobile(opts), redirect: opts.redirect });
    const r = route(u, opts);
    if (!r) throw new Error(`意料之外的请求: ${u}`);
    return new Response(r.body ?? '', { status: r.status ?? 200, headers: r.location ? { location: r.location } : {} });
  };
  impl.calls = calls;
  return impl;
}

/** 生产环境实测到的行为。 */
const realXhs = (overrides = {}) => fakeFetch((u, opts) => {
  if (overrides[u]) return overrides[u](opts);
  if (u === SHORT) return { status: 302, location: SHARE_TARGET };
  const path = new URL(u).pathname;
  if (path === `/discovery/item/${NOTE_ID}` || path === `/explore/${NOTE_ID}`) {
    if (path.startsWith('/discovery') && isMobile(opts)) return { status: 200, body: mobileSharePage() };
    return { status: 302, location: `https://www.xiaohongshu.com/login?redirectPath=${encodeURIComponent(u)}` };
  }
  if (path === '/login') return { status: 200, body: LOGIN_PAGE };
  return null;
});

describe('extractNote — 手机 App 分享链接（本次修复的回归用例）', () => {
  it('xhslink.cn/o/ 短链能提取出标题、正文、话题和配图', async () => {
    const f = realXhs();
    const note = await extractNote(SHORT, f);
    expect(note.ok).toBe(true);
    expect(note.via).toBe('mobile-share');
    expect(note.title).toBe('江苏宽带国庆价！无锡300M仅220🔥');
    expect(note.content).toBe('江苏的宝子们！国庆前办宽带真的能省一笔💰\n300M → 299元/年');
    // 正文里的话题在前，tagList 补齐正文里没出现的
    expect(note.tags).toEqual(['江苏宽带', '无锡宽带', '联通宽带']);
    // 手机页没有 WB_DFT，也没有 og:image —— 旧实现在这一页上一张图都拿不到
    expect(note.imageUrls).toEqual(['http://sns-webpic-qc.xhscdn.com/a/dtl1']);
  });

  it('取正文用手机 UA 请求分享页，token 原样带过去', async () => {
    const f = realXhs();
    await extractNote(SHORT, f);
    const page = f.calls[1];
    expect(new URL(page.url).pathname).toBe(`/discovery/item/${NOTE_ID}`);
    expect(page.mobile).toBe(true);
    expect(new URL(page.url).searchParams.get('xsec_token')).toBe(TOKEN);
  });

  it('只发两个请求：短链一跳拿到笔记地址就停，不会跟进登录墙', async () => {
    const f = realXhs();
    await extractNote(SHORT, f);
    expect(f.calls).toHaveLength(2);
    expect(f.calls.every(c => c.redirect === 'manual')).toBe(true);
    expect(f.calls.some(c => c.url.includes('/login'))).toBe(false);
  });

  it('旧的取法（/explore/ + 电脑 UA）确实只会撞上登录墙 —— 这就是原来报错的原因', async () => {
    const f = realXhs();
    const plan = noteFetchPlan({ noteId: NOTE_ID, query: new URL(SHARE_TARGET).searchParams });
    const desktop = plan.find(p => p.label === 'desktop-explore');
    expect(await fetchXhsPage(desktop.url, desktop.ua, f)).toEqual({ kind: 'login' });
    // 登录页本身没被请求：识别出跳转目标是 /login 就停
    expect(f.calls.some(c => new URL(c.url).pathname === '/login')).toBe(false);
  });

  it('手机分享页也被拦时，如实说是登录墙，而不是「笔记不存在」', async () => {
    const f = realXhs({
      [SHARE_TARGET]: () => ({ status: 302, location: 'https://www.xiaohongshu.com/login?redirectPath=x' }),
    });
    const note = await extractNote(SHORT, f);
    expect(note).toMatchObject({ ok: false, reason: 'login' });
    expect(EXTRACT_FAILURE_MESSAGES.login).toMatch(/登录/);
    expect(EXTRACT_FAILURE_MESSAGES.login).not.toMatch(/不存在/);
  });

  it('跳到 /404 才报笔记不存在', async () => {
    const f = realXhs({
      [SHARE_TARGET]: () => ({ status: 302, location: 'https://www.xiaohongshu.com/404?source=note' }),
    });
    expect(await extractNote(SHORT, f)).toMatchObject({ ok: false, reason: 'gone' });
  });

  it('不带 token 的直链跳 /404 时，提示缺 token 而不是「笔记不存在」（线上实测行为）', async () => {
    const f = fakeFetch(() => ({ status: 302, location: 'https://www.xiaohongshu.com/404?source=note' }));
    const note = await extractNote(`https://www.xiaohongshu.com/explore/${NOTE_ID}`, f);
    expect(note).toMatchObject({ ok: false, reason: 'no_token' });
  });

  it('没有 xsec_token 又提取不到时，提示去 App 里重新复制分享链接', async () => {
    const f = fakeFetch((u) => {
      if (new URL(u).pathname.startsWith('/discovery')) return { status: 200, body: LOGIN_PAGE };
      return { status: 302, location: 'https://www.xiaohongshu.com/login' };
    });
    const note = await extractNote(`https://www.xiaohongshu.com/explore/${NOTE_ID}`, f);
    expect(note).toMatchObject({ ok: false, reason: 'no_token' });
    expect(EXTRACT_FAILURE_MESSAGES.no_token).toMatch(/复制链接/);
  });

  it('短链失效（不跳也不带笔记）时报解析失败', async () => {
    const f = fakeFetch(() => ({ status: 200, body: '<html>链接已失效</html>' }));
    expect(await extractNote(SHORT, f)).toMatchObject({ ok: false, reason: 'unresolved' });
  });
});

describe('小红书抓取 — 每一跳都过白名单（SSRF）', () => {
  it('短链跳去内网地址时直接拒绝，内网地址从未被请求', async () => {
    const f = fakeFetch((u) => (u === SHORT ? { status: 302, location: 'http://169.254.169.254/latest/meta-data' } : null));
    await expect(extractNote(SHORT, f)).rejects.toThrow('非预期域名');
    expect(f.calls.map(c => c.url)).toEqual([SHORT]);
  });

  it('笔记页中途跳去内网地址时同样拒绝', async () => {
    const f = realXhs({ [SHARE_TARGET]: () => ({ status: 302, location: 'http://10.0.0.1/admin' }) });
    await expect(extractNote(SHORT, f)).rejects.toThrow('非预期域名');
    expect(f.calls.some(c => c.url.includes('10.0.0.1'))).toBe(false);
  });

  it('旧实现用 redirect: follow，中间跳在复检前就已发出；现在一律手动跟踪', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'xhs-writer.js'), 'utf8');
    const start = src.indexOf('// ====== 小红书笔记抓取 ======');
    const block = src.slice(start, src.indexOf('const EXTRACT_FAILURE_MESSAGES'));
    expect(block).not.toMatch(/redirect:\s*'follow'/);
  });
});

describe('parseNoteUrl / noteRefFromHtml — 认出是哪一篇', () => {
  it('电脑端与手机端两种直链都认，参数保留', () => {
    const a = parseNoteUrl(`https://www.xiaohongshu.com/explore/${NOTE_ID}?xsec_token=abc&xsec_source=pc_feed`);
    expect(a.noteId).toBe(NOTE_ID);
    expect(a.query.get('xsec_source')).toBe('pc_feed');
    expect(parseNoteUrl(`https://www.xiaohongshu.com/discovery/item/${NOTE_ID}/`).noteId).toBe(NOTE_ID);
  });

  it('短链、非笔记页、非白名单域、id 不是 24 位十六进制都不认', () => {
    expect(parseNoteUrl(SHORT)).toBeNull();
    expect(parseNoteUrl('https://www.xiaohongshu.com/login')).toBeNull();
    expect(parseNoteUrl(`https://evil.com/explore/${NOTE_ID}`)).toBeNull();
    expect(parseNoteUrl('https://www.xiaohongshu.com/explore/123')).toBeNull();
  });

  it('早期 /o/ 页面：xsecToken 驼峰写法、\\u002F 转义、%3D 编码都能解出来', () => {
    const html = `<script>var d={"noteId":"${NOTE_ID}","url":"https:\\u002F\\u002Fx?xsecToken=CBg-abc%3D"}</script>`;
    const ref = noteRefFromHtml(html);
    expect(ref.noteId).toBe(NOTE_ID);
    expect(ref.query.get('xsec_token')).toBe('CBg-abc=');
  });

  it('电脑端复制的链接，第一方案也是手机分享页，token 一起带过去', async () => {
    const ref = await resolveNoteRef(`https://www.xiaohongshu.com/explore/${NOTE_ID}?xsec_token=T1&xsec_source=pc_feed`);
    const [first, second] = noteFetchPlan(ref);
    expect(first.url).toBe(`https://www.xiaohongshu.com/discovery/item/${NOTE_ID}?xsec_token=T1&xsec_source=pc_feed`);
    expect(/iPhone/.test(first.ua)).toBe(true);
    expect(second.url).toContain(`/explore/${NOTE_ID}?xsec_token=T1&xsec_source=pc_feed`);
  });
});

describe('parseInitialState / pickNoteFromState — 取对那一篇', () => {
  it('state 里的 undefined 字面量不会让解析失败', () => {
    const html = '<script>window.__INITIAL_STATE__={"a":undefined,"b":[undefined,1]}</script>';
    expect(parseInitialState(html)).toEqual({ a: null, b: [null, 1] });
    expect(parseInitialState('<html>没有 state</html>')).toBeNull();
  });

  it('手机分享页与电脑端两种结构都能取到', () => {
    const mobile = parseInitialState(mobileSharePage());
    expect(pickNoteFromState(mobile, NOTE_ID).title).toContain('江苏宽带国庆价');
    const desktop = { note: { noteDetailMap: { [NOTE_ID]: { note: { noteId: NOTE_ID, title: 'T', desc: 'D' } } } } };
    expect(pickNoteFromState(desktop, NOTE_ID).title).toBe('T');
  });

  it('noteId 对不上就不取 —— 宁可兜底也不拿错一篇', () => {
    const state = parseInitialState(mobileSharePage({ noteId: 'b'.repeat(24) }));
    expect(pickNoteFromState(state, NOTE_ID)).toBeNull();
  });

  it('登录页的 state 里取不到任何笔记', () => {
    expect(pickNoteFromState(parseInitialState(LOGIN_PAGE), NOTE_ID)).toBeNull();
  });

  it('结构化解析失败时，兜底只在这一篇的 noteId 附近找，不会抓到相关推荐', () => {
    const broken = `<script>window.__INITIAL_STATE__={"t":new Date(0),"related":[{"noteId":"${'a'.repeat(24)}","title":"别人的","desc":"别人的正文"}],`
      + `"main":{"noteId":"${NOTE_ID}","title":"本篇","desc":"本篇正文"}}</script>`;
    expect(parseInitialState(broken)).toBeNull();
    expect(legacyNoteFromHtml(broken, NOTE_ID)).toMatchObject({ title: '本篇', content: '本篇正文' });
    expect(legacyNoteFromHtml(broken, 'c'.repeat(24))).toBeNull();
  });

  it('兜底的括号配对会跳过字符串里的 { }，不会切歪', () => {
    const html = `<script>window.__INITIAL_STATE__={"t":new Date(0),"related":[{"title":"别人的"}],`
      + `"main":{"desc":"套餐 {300M} 每月 }79{ 元","noteId":"${NOTE_ID}","title":"本篇"}}</script>`;
    expect(legacyNoteFromHtml(html, NOTE_ID)).toMatchObject({ title: '本篇', content: '套餐 {300M} 每月 }79{ 元' });
  });

  it('那个对象本身也解析不了时，仍只在对象内部按字段取', () => {
    const html = `<script>window.__INITIAL_STATE__={"related":[{"title":"别人的","desc":"别人的正文"}],`
      + `"main":{"noteId":"${NOTE_ID}","when":new Date(0),"title":"本篇","desc":"本篇正文"}}</script>`;
    expect(legacyNoteFromHtml(html, NOTE_ID)).toMatchObject({ title: '本篇', content: '本篇正文' });
  });
});

describe('noteContentFromState / pickImageUrl — 正文、话题、配图', () => {
  it('正文去掉末尾话题；话题去重且过滤过长的', () => {
    const r = noteContentFromState({
      title: '标题 - 小红书',
      desc: '正文 #宽带[话题]# #宽带[话题]# #' + '长'.repeat(40) + '#',
      tagList: [{ name: '宽带' }, { name: '广州' }],
    });
    expect(r.title).toBe('标题');
    expect(r.content).toBe('正文');
    expect(r.tags).toEqual(['宽带', '广州']);
  });

  it('「标签：#A# #B#」剥掉话题后，不留下孤零零的「标签：」（线上实测）', () => {
    const desc = '国庆前办折扣多\n有问题评论区聊💬\n标签：#江苏宽带[话题]# #国庆宽带[话题]#';
    expect(noteContentFromState({ desc }).content).toBe('国庆前办折扣多\n有问题评论区聊💬');
    expect(noteContentFromState({ desc: '正文\n话题: #A#' }).content).toBe('正文');
  });

  it('正文里正常出现的「标签」二字不会被误删', () => {
    expect(noteContentFromState({ desc: '记得给宽带贴个标签' }).content).toBe('记得给宽带贴个标签');
    expect(noteContentFromState({ desc: '价目表见标签：下方' }).content).toBe('价目表见标签：下方');
  });

  it('配图地址优先取正文大图，缩略图垫底', () => {
    expect(pickImageUrl({ infoList: [{ imageScene: 'WB_PRV', url: 'p' }, { imageScene: 'WB_DFT', url: 'd' }] })).toBe('d');
    expect(pickImageUrl({ url: 'u', infoList: [{ imageScene: 'H5_DTL', url: 'dtl' }] })).toBe('dtl');
    expect(pickImageUrl({ urlDefault: 'def', url: 'u' })).toBe('def');
    expect(pickImageUrl({ infoList: [{ imageScene: 'H5_PRV', url: 'prv' }] })).toBe('prv');
    expect(pickImageUrl(null)).toBe('');
  });

  it('最多 9 张', () => {
    const imageList = Array.from({ length: 12 }, (_, i) => ({ url: `u${i}` }));
    expect(noteContentFromState({ title: 't', imageList }).imageUrls).toHaveLength(9);
  });
});

describe('downloadImagesParallel — 结果按输入顺序，不按完成顺序', () => {
  it('先下完的排不到前面去，封面始终是第一张', async () => {
    const delay = { a: 30, b: 10, c: 0, d: 5 };
    const download = (u) => new Promise(r => setTimeout(() => r(u === 'd' ? null : `/local/${u}`), delay[u]));
    expect(await downloadImagesParallel(['a', 'b', 'c', 'd'], download)).toEqual(['/local/a', '/local/b', '/local/c']);
  });

  it('空列表不报错', async () => {
    expect(await downloadImagesParallel([], async () => 'x')).toEqual([]);
  });
});
