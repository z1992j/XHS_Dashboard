import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import {
  Sparkles, Loader2, ImageIcon, X, Save, Check, ChevronLeft, ChevronRight,
  Link2, Plus, History, ChevronDown, Zap, RotateCcw, Copy, Trash2, ShieldCheck,
  ScanLine, PenLine, Wand2, Eraser,
} from 'lucide-react';
import PhonePreview from '../components/PhonePreview';
import {
  rewriteNote, materialsApi, historyApi, getAiQuota,
  visionApi, styleApi, composeFromFacts, fetchCapabilities, getVisionQuota,
  type GeneratedNote, type HistoryItem, type VisionFact, type VisionResult,
  type StyleProfile, type StyleExample, type ServerCapabilities,
} from '../lib/api';
import FactConfirm from '../components/FactConfirm';
import { getAllTemplates } from '../lib/templates';
import { compressImage, shrinkForVision, estimateVisionPayload, VISION_BODY_SAFE_LIMIT } from '../lib/image';
import { copyNote } from '../lib/clipboard';
import { similarityScore, describeSimilarity } from '../lib/similarity';

const XHS_URL_RE = /https?:\/\/(?:www\.)?(?:xiaohongshu\.com\/(?:explore|discovery\/item)\/[\w]+(?:\?[^\s]*)?|xhslink\.(?:com|cn)\/[\w/]+(?:\?[^\s]*)?)/i;

const MAX_GALLERY = 9;

// 一次读几张。图集能放 9 张，但按张计费，读太多不划算，
// 而套餐信息通常一两张就说完了。
const MAX_READ_IMAGES = 4;

// 刷新页面不该丢掉没保存的编辑内容
const DRAFT_KEY = 'xhs_writer_draft';

interface Draft {
  prompt: string;
  images: string[];
  coverIdx: number;
  results: GeneratedNote[];
  activeIdx: number;
  sourceUrl: string | null;
  sourceText: string;
  editingId: number | null;
}

function readDraft(): Draft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? JSON.parse(raw) as Draft : null;
  } catch {
    return null;
  }
}

function writeDraft(draft: Draft | null) {
  if (!draft) {
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* 无所谓 */ }
    return;
  }
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // 超配额时退化为只存文字，至少不丢文案
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...draft, images: [] }));
    } catch { /* 存不下就放弃草稿 */ }
  }
}

type ToastKind = 'success' | 'error';

export default function Writer() {
  const [prompt, setPrompt] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [coverIdx, setCoverIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState<{ msg: string; kind: ToastKind } | null>(null);
  const [results, setResults] = useState<GeneratedNote[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [savedSet, setSavedSet] = useState<Set<number>>(new Set());
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [count, setCount] = useState(1);
  const [progress, setProgress] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const [author, setAuthor] = useState(() => localStorage.getItem('default_author') || '我的账号');
  const [extracting, setExtracting] = useState(false);
  const [detectedUrl, setDetectedUrl] = useState<string | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [sourceText, setSourceText] = useState('');
  const [newTag, setNewTag] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyList, setHistoryList] = useState<HistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<string>('default');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [inputCollapsed, setInputCollapsed] = useState(false);
  const [quota, setQuota] = useState<{ limit: number; remaining: number } | null>(null);
  const [visionQuota, setVisionQuota] = useState<{ limit: number; remaining: number } | null>(null);

  // ---- 看图成文 ----
  const [mode, setMode] = useState<'text' | 'image'>('text');
  const [caps, setCaps] = useState<ServerCapabilities | null>(null);
  const [reading, setReading] = useState(false);
  const [vision, setVision] = useState<VisionResult | null>(null);
  const [styleState, setStyleState] = useState<{ profile: StyleProfile | null; ready: boolean; sampleCount: number; minSamples: number } | null>(null);
  const [styleBusy, setStyleBusy] = useState(false);
  const [useMyStyle, setUseMyStyle] = useState(true);
  const [usedExamples, setUsedExamples] = useState<StyleExample[]>([]);

  const templates = getAllTemplates();
  const fileRef = useRef<HTMLInputElement>(null);
  const extractTriggered = useRef(false);
  const toastTimer = useRef<number | undefined>(undefined);

  const current = results[activeIdx] || null;
  const hasResults = results.length > 0 && !loading;
  const cover = images[coverIdx];

  const showToast = useCallback((msg: string, kind: ToastKind = 'success') => {
    setToast({ msg, kind });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  // 能力位决定「从图片生成」入口是否出现；没配视觉模型时当功能不存在
  useEffect(() => {
    fetchCapabilities().then(setCaps);
    styleApi.get()
      .then(s => setStyleState({ profile: s.profile, ready: s.ready, sampleCount: s.sampleCount, minSamples: s.minSamples }))
      .catch((e) => {
        // 拿不到就退回预设模板，但把原因打进控制台 —— 之前完全静默，
        // 出问题时连"是网络挂了还是没有数据"都分不清。
        console.error('获取写作风格失败', e);
      });
  }, []);

  // 与原文的相似度：核心卖点的量化反馈
  const verdict = useMemo(() => {
    if (!current || !sourceText.trim()) return null;
    return describeSimilarity(similarityScore(sourceText, current.content));
  }, [current, sourceText]);

  // 与自家历史素材的重合度。平台对同账号重复内容一样限流，
  // 所以「跟别人不像」还不够，「跟自己以前发的不像」同样要看。
  const selfOverlap = useMemo(() => {
    if (!current || !usedExamples.length) return null;
    let worst = { score: 0, title: '' };
    for (const ex of usedExamples) {
      const score = similarityScore(ex.content, current.content);
      if (score > worst.score) worst = { score, title: ex.title };
    }
    return worst.score >= 40 ? worst : null;
  }, [current, usedExamples]);

  const updateResult = useCallback((field: keyof GeneratedNote, value: string | string[]) => {
    setResults(prev => prev.map((r, i) => i === activeIdx ? { ...r, [field]: value } : r));
    setSavedSet(prev => { const next = new Set(prev); next.delete(activeIdx); return next; });
  }, [activeIdx]);

  const removeTag = useCallback((tagIdx: number) => {
    if (!current) return;
    updateResult('tags', current.tags.filter((_, i) => i !== tagIdx));
  }, [current, updateResult]);

  const addTag = useCallback(() => {
    const t = newTag.replace(/^#/, '').trim();
    if (!t || !current) return;
    if (!current.tags.includes(t)) {
      updateResult('tags', [...current.tags, t]);
    }
    setNewTag('');
  }, [newTag, current, updateResult]);

  const handleImage = useCallback(async (files: FileList) => {
    const picked = [...files].filter(f => f.type.startsWith('image/'));
    if (!picked.length) return;
    try {
      const room = MAX_GALLERY - images.length;
      if (room <= 0) {
        showToast(`最多 ${MAX_GALLERY} 张配图`, 'error');
        return;
      }
      const encoded = await Promise.all(picked.slice(0, room).map(compressImage));
      setImages(prev => [...prev, ...encoded].slice(0, MAX_GALLERY));
    } catch (e) {
      showToast(e instanceof Error ? e.message : '图片处理失败', 'error');
    }
  }, [images.length, showToast]);

  const removeImage = useCallback((idx: number) => {
    setImages(prev => prev.filter((_, i) => i !== idx));
    setCoverIdx(prev => (idx < prev ? prev - 1 : prev === idx ? 0 : prev));
  }, []);

  const handleExtract = useCallback(async (url: string, opts?: { confirmOverwrite?: boolean }) => {
    // 提取会整段替换输入框，覆盖用户手写内容前先问一句
    if (opts?.confirmOverwrite) {
      const typed = prompt.replace(url, '').trim();
      if (typed && !confirm('提取原文会替换输入框里已有的内容，确定继续？')) return;
    }
    setExtracting(true);
    setError('');
    try {
      const data = await materialsApi.extractNote(url);
      const tagLine = data.tags?.length ? '\n\n' + data.tags.map((t: string) => '#' + t).join(' ') : '';
      const text = (data.title || '') + '\n\n' + (data.content || '') + tagLine;
      setPrompt(text);
      setSourceText(text);
      setSourceUrl(url);
      if (data.images?.length) {
        setImages(data.images.slice(0, MAX_GALLERY));
        setCoverIdx(0);
      }
      setDetectedUrl(null);
      showToast(data.images?.length ? `已提取原文和 ${data.images.length} 张配图` : '已提取原文');
    } catch (e) {
      setError(e instanceof Error ? e.message : '链接提取失败');
    } finally {
      setExtracting(false);
    }
  }, [prompt, showToast]);

  const handlePromptChange = useCallback((value: string) => {
    setPrompt(value);
    const match = value.match(XHS_URL_RE);
    setDetectedUrl(match ? match[0] : null);
    if (match && value.trim() === match[0] && !extractTriggered.current) {
      extractTriggered.current = true;
      handleExtract(match[0]);
    }
    if (!match) extractTriggered.current = false;
  }, [handleExtract]);

  // 读图：拿到的是待确认的事实清单，不是文案
  // 封面排第一，其余按顺序补齐 —— 套餐信息常常跨几张图
  const readTargets = useMemo(() => {
    if (!images.length) return [];
    const cover = images[coverIdx] ?? images[0];
    return [cover, ...images.filter((_, i) => i !== coverIdx)].slice(0, MAX_READ_IMAGES);
  }, [images, coverIdx]);

  const handleReadImage = useCallback(async () => {
    if (!readTargets.length) {
      showToast('请先选择一张图片', 'error');
      return;
    }
    setReading(true);
    setError('');
    setVision(null);
    try {
      // 压进请求体预算再发 —— 手机原图 4 张能到 5MB+，
      // nginx 默认 1MB 就断连，前端只会看到一个无从下手的「网络连接失败」
      const payload = await shrinkForVision(readTargets);
      const bytes = estimateVisionPayload(payload);
      // 用和 apiFetch 判断"是否会被反代拒绝"完全同一把尺子——压缩失败的兜底
      // 情况下这里提前拦住，好过发出去之后才收到一个笼统的网络错误。
      if (bytes > VISION_BODY_SAFE_LIMIT) {
        throw new Error(`图片体积过大（约 ${Math.round(bytes / 1024)}KB），请减少张数或换更小的图`);
      }
      const result = await visionApi.read(payload);
      setVision(result);
      setVisionQuota(getVisionQuota());
      const n = result.imagesRead ?? readTargets.length;
      if (!result.facts.length) {
        showToast(`${n > 1 ? `这 ${n} 张图` : '这张图'}没读到具体信息，可以手动补充`, 'error');
      } else {
        const low = result.facts.filter(f => f.confidence === 'low').length;
        const base = `从 ${n} 张图读到 ${result.facts.length} 条信息`;
        showToast(low ? `${base}，其中 ${low} 条需核对` : base);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '读图失败');
      setVisionQuota(getVisionQuota());
    } finally {
      setReading(false);
    }
  }, [readTargets, showToast]);

  // 由确认过的事实生成文案
  const handleComposeFromImage = useCallback(async (confirmed: VisionFact[]) => {
    if (!vision) return;
    setLoading(true);
    setError('');
    setResults([]);
    setActiveIdx(0);
    setSavedSet(new Set());
    setProgress(0);
    setFailedCount(0);
    setEditingId(null);
    setInputCollapsed(true);
    // 事实清单同时作为"原文"参与相似度比对，避免生成结果跟自家素材撞车
    setSourceText(confirmed.map(f => `${f.key}：${f.value}`).join('\n'));

    try {
      // 用事实里的关键词去素材库找同主题的样例
      let examples: StyleExample[] = [];
      const wantStyle = useMyStyle && styleState?.ready;
      if (wantStyle) {
        const keywords = confirmed.map(f => f.value).filter(Boolean).slice(0, 8);
        try {
          const r = await styleApi.examples(keywords);
          examples = r.data;
        } catch { /* 样例拿不到就只用画像 */ }
      }
      setUsedExamples(examples);

      const tpl = templates.find(t => t.id === selectedTemplate);
      const sysPrompt = tpl && tpl.id !== 'default' ? tpl.systemPrompt : undefined;

      const settled = await Promise.allSettled(
        Array.from({ length: count }, () =>
          composeFromFacts({
            facts: confirmed,
            scene: vision.scene,
            styleProfile: wantStyle ? styleState?.profile ?? null : null,
            examples,
            systemPrompt: sysPrompt,
          }).then((note) => { setProgress(p => p + 1); return note; })
        )
      );

      const notes = settled
        .filter((r): r is PromiseFulfilledResult<GeneratedNote> => r.status === 'fulfilled')
        .map(r => r.value);
      const failures = settled.filter(r => r.status === 'rejected') as PromiseRejectedResult[];

      setQuota(getAiQuota());
      setFailedCount(failures.length);

      if (!notes.length) {
        const reason = failures[0]?.reason;
        setError(reason instanceof Error ? reason.message : '生成失败');
        setInputCollapsed(false);
        return;
      }
      setResults(notes);
      if (failures.length) {
        showToast(`${notes.length} 篇成功，${failures.length} 篇失败`, 'error');
      }
      historyApi.create({
        prompt: `[看图成文] ${vision.scene}\n` + confirmed.map(f => `${f.key}：${f.value}`).join('\n'),
        results: notes,
      }).catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e.message : '生成失败');
      setInputCollapsed(false);
    } finally {
      setLoading(false);
      setProgress(0);
    }
  }, [vision, useMyStyle, styleState, templates, selectedTemplate, count, showToast]);

  const handleGenerate = async () => {
    if (!prompt.trim()) return;
    setLoading(true);
    setError('');
    setResults([]);
    setActiveIdx(0);
    setSavedSet(new Set());
    setProgress(0);
    setFailedCount(0);
    setEditingId(null);
    setInputCollapsed(true);
    setSourceText(prompt.trim());
    setUsedExamples([]);
    try {
      const imageDesc = images.length
        ? `已上传 ${images.length} 张配图，文案需配合图片主题`
        : undefined;
      const tpl = templates.find(t => t.id === selectedTemplate);
      const sysPrompt = tpl && tpl.id !== 'default' ? tpl.systemPrompt : undefined;
      const wantStyle = useMyStyle && styleState?.ready && !!styleState?.profile;

      // allSettled：一篇失败不该把已经生成好的其他几篇一起丢掉
      const settled = await Promise.allSettled(
        Array.from({ length: count }, () =>
          rewriteNote(prompt.trim(), imageDesc, sysPrompt, wantStyle ? styleState?.profile ?? null : null).then((note) => {
            setProgress((p) => p + 1);
            return note;
          })
        )
      );

      const notes = settled
        .filter((r): r is PromiseFulfilledResult<GeneratedNote> => r.status === 'fulfilled')
        .map(r => r.value);
      const failures = settled.filter(r => r.status === 'rejected') as PromiseRejectedResult[];

      setQuota(getAiQuota());
      setFailedCount(failures.length);

      if (!notes.length) {
        const reason = failures[0]?.reason;
        setError(reason instanceof Error ? reason.message : '生成失败');
        setInputCollapsed(false);
        return;
      }

      setResults(notes);
      if (failures.length) {
        const reason = failures[0]?.reason;
        showToast(
          `${notes.length} 篇成功，${failures.length} 篇失败：${reason instanceof Error ? reason.message : '未知错误'}`,
          'error',
        );
      }
      historyApi.create({
        prompt: prompt.trim(),
        results: notes,
        sourceUrl: sourceUrl || undefined,
      }).catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e.message : '生成失败');
      setInputCollapsed(false);
    } finally {
      setLoading(false);
      setProgress(0);
    }
  };

  const handleRegenerate = () => {
    setInputCollapsed(false);
    setResults([]);
  };

  const handleCopy = async () => {
    if (!current) return;
    try {
      await copyNote(current);
      setCopiedIdx(activeIdx);
      showToast('已复制，可直接粘贴到小红书');
      window.setTimeout(() => setCopiedIdx(null), 2000);
    } catch {
      showToast('复制失败，请手动选中文本复制', 'error');
    }
  };

  // 全部结果都保存完之后，把表单清空准备下一篇。
  //
  // 不清的话有两个问题：输入框和图集一直挂着这篇已经存好的旧内容，
  // 看着像"什么都没发生"；更麻烦的是草稿自动保存（见下方 useEffect）
  // 会照常把这篇"已经保存过"的内容持续写回 localStorage，下次打开
  // Writer 页时还会把它当草稿恢复回来，感觉就是"保存了但页面从没重置过"。
  // 设置页删掉之后，「重新分析」就放在用得到它的那一行旁边 ——
  // 本来也没道理为了一个按钮让人跳去另一个页面。
  const handleRebuildStyle = useCallback(async () => {
    setStyleBusy(true);
    try {
      const r = await styleApi.rebuild();
      setStyleState(prev => prev ? { ...prev, profile: r.profile, sampleCount: r.sampleCount ?? prev.sampleCount } : prev);
      setUseMyStyle(true);
      showToast(`已学完 ${r.sampleCount ?? ''} 篇素材`);
    } catch (e) {
      showToast(e instanceof Error ? e.message : '分析失败，请重试', 'error');
    } finally {
      setStyleBusy(false);
    }
  }, [showToast]);

  const resetForNextNote = useCallback(() => {
    setPrompt('');
    setImages([]);
    setCoverIdx(0);
    setResults([]);
    setActiveIdx(0);
    setSavedSet(new Set());
    setSourceUrl(null);
    setSourceText('');
    setUsedExamples([]);
    setEditingId(null);
    setInputCollapsed(false);
    setVision(null);
    setDetectedUrl(null);
    setError('');
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* 无所谓，下次覆盖写入即可 */ }
  }, []);

  // 一键回到空白输入界面。清空是不可逆的，所以有没保存的结果时先问一句 ——
  // 生成一篇要花配额和时间，手滑点掉不该是"就这么没了"。
  const handleResetAll = useCallback(() => {
    const unsaved = results.length > 0 && savedSet.size < results.length;
    if (unsaved && !confirm('还有没保存的文案，确定清空重新开始？')) return;
    resetForNextNote();
    showToast('已清空，可以重新开始了');
  }, [results.length, savedSet.size, resetForNextNote, showToast]);

  const handleSave = async () => {
    if (!current || saving) return;
    setSaving(true);
    try {
      const ordered = cover ? [cover, ...images.filter((_, i) => i !== coverIdx)] : images;
      const payload = {
        title: current.title,
        content: current.content,
        tags: current.tags || [],
        imageData: cover ?? '',
        images: ordered,
        prompt: prompt.trim(),
      };
      if (editingId) {
        await materialsApi.update(editingId, payload);
      } else {
        await materialsApi.create(payload);
      }
      // 只有这批结果全部保存完才重置 —— 批量生成了 5 篇只存了 2 篇时，
      // 不能把另外 3 篇还没保存的也一并清掉。
      const nextSaved = new Set(savedSet).add(activeIdx);
      const allSaved = nextSaved.size === results.length;
      setSavedSet(nextSaved);
      showToast(editingId ? '已更新到素材库' : '已保存到素材库');
      if (allSaved) resetForNextNote();
    } catch (e) {
      showToast(e instanceof Error ? e.message : '保存失败，请重试', 'error');
    } finally {
      setSaving(false);
    }
  };

  const loadHistoryList = useCallback(async () => {
    setHistoryLoading(true);
    try {
      setHistoryList(await historyApi.list());
    } catch (e) {
      showToast(e instanceof Error ? e.message : '历史记录加载失败', 'error');
    } finally {
      setHistoryLoading(false);
    }
  }, [showToast]);

  const toggleHistory = async () => {
    if (historyOpen) {
      setHistoryOpen(false);
      return;
    }
    setHistoryOpen(true);
    await loadHistoryList();
  };

  const loadHistory = async (id: number) => {
    try {
      const h = await historyApi.get(id);
      if (h.prompt) {
        setPrompt(h.prompt);
        setSourceText(h.prompt);
      }
      setSourceUrl(h.sourceUrl || null);
      if (h.results?.length) {
        setResults(h.results);
        setActiveIdx(0);
        setSavedSet(new Set());
        setInputCollapsed(true);
      }
      setHistoryOpen(false);
    } catch (e) {
      showToast(e instanceof Error ? e.message : '读取历史失败', 'error');
    }
  };

  const deleteHistory = async (id: number) => {
    if (!confirm('删除这条历史记录？')) return;
    try {
      await historyApi.delete(id);
      setHistoryList(prev => prev.filter(h => h.id !== id));
      showToast('已删除');
    } catch (e) {
      showToast(e instanceof Error ? e.message : '删除失败', 'error');
    }
  };

  const clearHistory = async () => {
    if (!confirm('清空全部仿写历史？此操作不可撤销。')) return;
    if (!confirm('再确认一次：所有历史记录都会被删除。')) return;
    try {
      const r = await historyApi.clear();
      setHistoryList([]);
      showToast(`已清空 ${r.deleted} 条历史`);
    } catch (e) {
      showToast(e instanceof Error ? e.message : '清空失败', 'error');
    }
  };

  useEffect(() => {
    const raw = localStorage.getItem('load_material');
    if (!raw) {
      // 没有从素材库跳转过来，就尝试恢复上次的草稿
      const draft = readDraft();
      if (draft && (draft.prompt || draft.results?.length)) {
        setPrompt(draft.prompt || '');
        setImages(draft.images || []);
        setCoverIdx(draft.coverIdx || 0);
        setResults(draft.results || []);
        setActiveIdx(draft.activeIdx || 0);
        setSourceUrl(draft.sourceUrl ?? null);
        setSourceText(draft.sourceText || '');
        setEditingId(draft.editingId ?? null);
        if (draft.results?.length) setInputCollapsed(true);
      }
      return;
    }
    if (raw) {
      localStorage.removeItem('load_material');
      try {
        const item = JSON.parse(raw);
        setResults([{ title: item.title, content: item.content, tags: item.tags }]);
        setActiveIdx(0);
        const loaded: string[] = Array.isArray(item.images) && item.images.length
          ? item.images
          : (item.imageData ? [item.imageData] : []);
        setImages(loaded);
        setCoverIdx(0);
        setPrompt(item.prompt || '');
        setSourceText(item.prompt || '');
        setInputCollapsed(true);
        if (item.id) {
          setEditingId(item.id);
          setSavedSet(new Set());
        } else {
          setSavedSet(new Set([0]));
        }
      } catch { /* 损坏的暂存数据直接忽略 */ }
    }
  }, []);

  // 草稿落盘（配图是 data URL 时可能超出 localStorage 配额，写失败就算了）。
  // 防抖写入：自己上传的配图是 data URL，9 张能有十来 MB，原来每敲一个字
  // 都要整份 JSON.stringify 再同步写盘，手机上打字明显卡顿。
  // 离开页面 / 卸载组件时补写最后一份，防抖不会丢最后几个字。
  const draftRef = useRef<Draft | null>(null);
  useEffect(() => {
    draftRef.current = (!prompt && !results.length)
      ? null
      : { prompt, images, coverIdx, results, activeIdx, sourceUrl, sourceText, editingId };
    const timer = window.setTimeout(() => writeDraft(draftRef.current), 400);
    return () => window.clearTimeout(timer);
  }, [prompt, images, coverIdx, results, activeIdx, sourceUrl, sourceText, editingId]);
  useEffect(() => {
    const flush = () => writeDraft(draftRef.current);
    window.addEventListener('pagehide', flush);
    return () => { window.removeEventListener('pagehide', flush); flush(); };
  }, []);

  const isSaved = savedSet.has(activeIdx);
  const titleLen = [...(current?.title || '')].length;
  const contentLen = [...(current?.content || '')].length;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-5 items-start">
      {/* ====== Left: Main Panel ====== */}
      <div className="space-y-3">
        {/* 顶部状态条。原来是「输入→生成→编辑→带走」四步进度条 ——
            对每天重复用的人来说那只是噪音，换成一句当前状态 + 两个动作。 */}
        <div className="page-head">
          <div className="page-head-state">
            <span className="page-head-dot" style={{ background: hasResults ? 'var(--success)' : loading ? 'var(--primary)' : 'var(--border)' }} />
            <span className="page-head-text">
              {loading ? `生成中 ${progress}/${count}` : hasResults ? `已生成 ${results.length} 篇，可编辑后复制` : '粘贴原文或链接，开始仿写'}
            </span>
          </div>
          <div className="page-head-actions">
            {(hasResults || prompt.trim() || images.length > 0) && (
              <button
                onClick={handleResetAll}
                className="head-btn"
                title="清空原文和结果，回到空白输入界面"
              >
                <Eraser size={12} />
                初始化
              </button>
            )}
            <button
              onClick={toggleHistory}
              className={`head-btn ${historyOpen ? 'active' : ''}`}
            >
              <History size={12} />
              历史
              <ChevronDown size={10} className={`transition-transform ${historyOpen ? 'rotate-180' : ''}`} />
            </button>
          </div>
        </div>

        {/* History Panel */}
        {historyOpen && (
          <div className="white-card p-3">
            <div className="flex items-center justify-between mb-1.5 px-1">
              <span className="text-[11px] font-semibold" style={{ color: 'var(--text-3)' }}>
                最近 {historyList.length} 条
              </span>
              {historyList.length > 0 && (
                <button
                  onClick={clearHistory}
                  className="text-[11px] font-medium"
                  style={{ color: 'var(--danger)' }}
                >
                  清空全部
                </button>
              )}
            </div>
            <div className="max-h-48 overflow-y-auto">
              {historyLoading ? (
                <p className="text-xs text-center py-2" style={{ color: 'var(--text-3)' }}>加载中...</p>
              ) : historyList.length === 0 ? (
                <p className="text-xs text-center py-2" style={{ color: 'var(--text-3)' }}>暂无仿写历史</p>
              ) : (
                <div className="space-y-1">
                  {historyList.map(h => (
                    <div key={h.id} className="flex items-center gap-1 rounded-lg hover:bg-gray-50 group">
                      <button
                        onClick={() => loadHistory(h.id)}
                        className="flex-1 min-w-0 text-left px-3 py-2"
                      >
                        <p className="text-xs line-clamp-1" style={{ color: 'var(--text)' }}>{h.prompt}</p>
                        <p className="text-[10px] mt-0.5 flex items-center gap-1.5" style={{ color: 'var(--text-3)' }}>
                          {new Date(h.createdAt).toLocaleString('zh-CN')}
                          {h.sourceUrl && (
                            <span className="inline-flex items-center gap-0.5">
                              <Link2 size={9} /> 有来源
                            </span>
                          )}
                        </p>
                      </button>
                      <button
                        onClick={() => deleteHistory(h.id)}
                        className="btn-icon danger shrink-0 mr-1"
                        title="删除这条历史"
                        aria-label="删除这条历史"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* 模式切换：只有服务端配了视觉模型才出现 */}
        {caps?.vision && (!inputCollapsed || !hasResults) && (
          <div className="mode-switch">
            <button
              onClick={() => { setMode('text'); setVision(null); }}
              className={`mode-item ${mode === 'text' ? 'active' : ''}`}
            >
              <PenLine size={14} />
              从原文仿写
            </button>
            <button
              onClick={() => setMode('image')}
              className={`mode-item ${mode === 'image' ? 'active' : ''}`}
            >
              <ScanLine size={14} />
              从图片生成
            </button>
          </div>
        )}

        {/* Input Area — full when no results, compact when results exist */}
        {(!inputCollapsed || !hasResults) && (
          <div className="white-card p-4 space-y-3">
            {mode === 'text' && (
            <label className="text-xs font-semibold" style={{ color: 'var(--text-2)' }}>原文 / 链接</label>
            )}
            {mode === 'text' && (
            <textarea
              value={prompt}
              onChange={(e) => handlePromptChange(e.target.value)}
              placeholder="粘贴小红书帖子链接自动提取 / 手动粘贴原文..."
              rows={5}
              className="w-full p-3 rounded-lg text-sm resize-none input-glow"
              style={{ lineHeight: 1.6, border: '1px solid var(--border)', background: 'var(--bg)' }}
            />
            )}

            {mode === 'text' && (detectedUrl || extracting) && (
              <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs ${extracting ? 'extract-bar-loading' : 'extract-bar'}`}>
                <Link2 size={13} />
                {extracting ? (
                  <span className="flex items-center gap-1.5">
                    <Loader2 size={12} className="animate-spin" />
                    正在提取原文...
                  </span>
                ) : (
                  <>
                    <span className="flex-1 truncate" style={{ color: '#16a34a' }}>识别到小红书链接</span>
                    <button
                      onClick={() => handleExtract(detectedUrl!, { confirmOverwrite: true })}
                      className="shrink-0 px-2.5 py-1 rounded-full text-[11px] font-medium text-white"
                      style={{ background: '#22c55e' }}
                    >
                      提取原文
                    </button>
                  </>
                )}
              </div>
            )}

            {/* Gallery */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-semibold" style={{ color: 'var(--text-2)' }}>
                  {mode === 'image' ? '选一张图来生成' : '配图'}
                  {images.length > 0 && <span style={{ color: 'var(--text-3)' }}> {images.length}/{MAX_GALLERY}</span>}
                </label>
                {images.length > 1 && (
                  <span className="text-[10px]" style={{ color: 'var(--text-3)' }}>点击设为封面</span>
                )}
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={(e) => { if (e.target.files?.length) handleImage(e.target.files); e.target.value = ''; }}
                />
                {images.map((src, i) => (
                  <div key={i} className="relative">
                    <button
                      onClick={() => setCoverIdx(i)}
                      className="block w-14 h-14 rounded-lg overflow-hidden"
                      style={{
                        border: coverIdx === i ? '2px solid var(--primary)' : '1px solid var(--border)',
                      }}
                      title={coverIdx === i ? '当前封面' : '设为封面'}
                    >
                      <img src={src} alt="" className="w-full h-full object-cover" />
                    </button>
                    {coverIdx === i && (
                      <span
                        className="absolute bottom-0 left-0 right-0 text-[8px] text-center text-white"
                        style={{ background: 'var(--primary)' }}
                      >
                        封面
                      </span>
                    )}
                    <button
                      onClick={() => removeImage(i)}
                      className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-red-500 text-white rounded-full flex items-center justify-center"
                      aria-label="移除这张配图"
                    >
                      <X size={8} />
                    </button>
                  </div>
                ))}
                {images.length < MAX_GALLERY && (
                  <button
                    onClick={() => fileRef.current?.click()}
                    className="w-14 h-14 rounded-lg flex flex-col items-center justify-center gap-1 transition-all group"
                    style={{ background: 'var(--bg)', border: '1.5px dashed var(--border)' }}
                  >
                    <ImageIcon size={16} className="text-gray-400 group-hover:text-blue-500 transition-colors" />
                    <span className="text-[9px] text-gray-400 group-hover:text-blue-500 transition-colors">添加</span>
                  </button>
                )}
              </div>
            </div>

            {/* 图片模式：读图 → 确认事实 → 生成 */}
            {mode === 'image' && (
              <div className="space-y-3">
                {!vision && (
                  <div className="space-y-1.5">
                    <button
                      onClick={handleReadImage}
                      disabled={reading || !images.length}
                      className="btn-primary w-full h-10 rounded-xl text-sm flex items-center justify-center gap-2"
                    >
                      {reading ? <Loader2 size={15} className="animate-spin" /> : <ScanLine size={15} />}
                      {reading
                        ? `正在读取 ${readTargets.length} 张图片...`
                        : readTargets.length > 1
                          ? `读取这 ${readTargets.length} 张图片的信息`
                          : '读取图片信息'}
                    </button>
                    {images.length > MAX_READ_IMAGES && (
                      <p className="text-[11px] text-center" style={{ color: 'var(--text-3)' }}>
                        共 {images.length} 张，只读前 {MAX_READ_IMAGES} 张（含封面）—— 按张计费
                      </p>
                    )}
                    {visionQuota && (
                      <p className="text-[11px] text-center" style={{ color: visionQuota.remaining === 0 ? 'var(--danger)' : 'var(--text-3)' }}>
                        本分钟读图剩余 {visionQuota.remaining}/{visionQuota.limit}
                        {visionQuota.remaining === 0 && ' · 请稍候再试'}
                      </p>
                    )}
                  </div>
                )}

              </div>
            )}

            {/* 账号名只影响右侧预览里的显示，设一次就不再动 ——
                不值得占满一整行，收成内联字段 */}
            <div className="inline-field">
              <label className="inline-field-label" htmlFor="author-input">账号名</label>
              <input
                id="author-input"
                value={author}
                onChange={(e) => { setAuthor(e.target.value); localStorage.setItem('default_author', e.target.value); }}
                className="inline-field-input input-glow"
              />
            </div>

            {/* 我的风格 —— 两种模式都适用。设置页已删，重新分析就放在这里 */}
            {styleState && (
              <div
                className="style-row"
                style={{
                  borderColor: useMyStyle && styleState.ready && styleState.profile ? 'var(--primary)' : 'var(--border)',
                  background: useMyStyle && styleState.ready && styleState.profile ? 'var(--primary-light)' : 'var(--bg)',
                }}
              >
                <button
                  onClick={() => styleState.ready && styleState.profile && setUseMyStyle(v => !v)}
                  disabled={!styleState.ready || !styleState.profile}
                  className="style-row-main"
                >
                  <Wand2 size={15} className="shrink-0" style={{ color: styleState.ready ? 'var(--primary)' : 'var(--text-3)' }} />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold" style={{ color: 'var(--text)' }}>
                      我的风格
                      {styleState.profile && <span style={{ color: 'var(--text-3)' }}>（学自 {styleState.sampleCount} 篇）</span>}
                    </p>
                    <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-3)' }}>
                      {!styleState.ready
                        ? `素材还差 ${styleState.minSamples - styleState.sampleCount} 篇（需要 ${styleState.minSamples} 篇），先用预设风格`
                        : !styleState.profile
                          ? '还没学过你的写法，点右边分析一次'
                          : useMyStyle ? '按你以前的写法生成' : '已关闭，使用预设风格'}
                    </p>
                  </div>
                  {styleState.ready && styleState.profile && useMyStyle && (
                    <Check size={14} className="shrink-0" style={{ color: 'var(--primary)' }} />
                  )}
                </button>
                {styleState.ready && (
                  <button
                    onClick={handleRebuildStyle}
                    disabled={styleBusy}
                    className="style-row-action"
                    title="重新学习素材库里的写法"
                  >
                    {styleBusy ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
                    {styleState.profile ? '重学' : '分析'}
                  </button>
                )}
              </div>
            )}

            {/* 仿写风格。只剩一个可选项时整块不渲染 ——
                「种草文」「避坑指南」删掉后预设只剩通用仿写，
                一个永远只有单选项的选择器是纯噪音。有自定义模板时会自己回来。 */}
            {templates.length > 1 && (
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--text-3)' }}>仿写风格</div>
              <div className="tpl-grid">
                {templates.map(tpl => (
                  <button
                    key={tpl.id}
                    onClick={() => setSelectedTemplate(tpl.id)}
                    className={`tpl-card ${selectedTemplate === tpl.id ? 'active' : ''}`}
                  >
                    <div className="tpl-card-icon">{tpl.icon}</div>
                    <div className="tpl-card-name">{tpl.name}</div>
                    <div className="tpl-card-desc">{tpl.description}</div>
                  </button>
                ))}
              </div>
            </div>
            )}

            {/* Count + Generate */}
            <div className="flex items-center gap-3 pt-1" style={{ display: mode === 'image' && !vision ? 'none' : undefined }}>
              <div className="white-card flex items-center gap-1 px-2 py-1.5">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    onClick={() => setCount(n)}
                    className="w-7 h-7 rounded-full text-[11px] font-semibold transition-all"
                    style={{
                      background: count === n ? 'var(--primary)' : 'transparent',
                      color: count === n ? '#fff' : 'var(--text-3)',
                    }}
                  >
                    {n}
                  </button>
                ))}
              </div>
              {mode === 'text' && (
                <button
                  onClick={handleGenerate}
                  disabled={loading || !prompt.trim()}
                  className="btn-yellow flex-1 flex items-center justify-center gap-2 h-11 rounded-xl text-sm"
                >
                  {loading ? <Loader2 size={15} className="animate-spin" /> : <Zap size={15} />}
                  {loading ? `生成中 ${progress}/${count}` : `生成 ${count} 篇`}
                </button>
              )}
              {mode === 'image' && (
                <span className="flex-1 text-[11px]" style={{ color: 'var(--text-3)' }}>
                  确认下方信息后生成 {count} 篇
                </span>
              )}
            </div>

            {quota && (
              <p className="text-[11px] text-right" style={{ color: quota.remaining < count ? 'var(--danger)' : 'var(--text-3)' }}>
                本分钟文案生成剩余 {quota.remaining}/{quota.limit}
                {quota.remaining < count && ' · 不足以生成所选篇数，请减少篇数或稍候'}
              </p>
            )}
          </div>
        )}

        {/* 事实确认卡 —— 生成前必须过人眼的一步 */}
        {mode === 'image' && vision && !hasResults && !loading && (
          <FactConfirm
            scene={vision.scene}
            hasText={vision.hasText}
            facts={vision.facts}
            warnings={vision.warnings}
            onChange={(facts) => setVision({ ...vision, facts })}
            onConfirm={handleComposeFromImage}
            disabled={loading}
          />
        )}

        {/* Loading State */}
        {loading && inputCollapsed && (
          <div className="white-card p-8 flex flex-col items-center gap-4">
            <div className="relative">
              <Loader2 size={32} className="animate-spin" style={{ color: 'var(--primary)' }} />
            </div>
            <div className="text-center">
              <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>AI 正在仿写...</p>
              <p className="text-xs mt-1" style={{ color: 'var(--text-3)' }}>已完成 {progress}/{count} 篇</p>
            </div>
            <div className="w-full max-w-xs">
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${(progress / count) * 100}%` }} />
              </div>
            </div>
          </div>
        )}

        {/* ====== Results Editor (MAIN AREA after generation) ====== */}
        {hasResults && (
          <div className="result-card p-5 space-y-4">
            {/* Header with navigation and actions */}
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-3">
                <span className="text-base font-semibold flex items-center gap-2" style={{ color: 'var(--text)' }}>
                  <Sparkles size={16} style={{ color: 'var(--primary)' }} /> 编辑结果
                </span>
                {results.length > 1 && (
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => setActiveIdx((i) => Math.max(0, i - 1))}
                      disabled={activeIdx === 0}
                      className="w-6 h-6 rounded-full flex items-center justify-center transition-all disabled:opacity-30"
                      style={{ background: 'var(--primary-light)', color: 'var(--primary)' }}
                      aria-label="上一篇"
                    >
                      <ChevronLeft size={14} />
                    </button>
                    <div className="flex items-center gap-1">
                      {results.map((_, i) => (
                        <button
                          key={i}
                          onClick={() => setActiveIdx(i)}
                          className="relative w-6 h-6 rounded-full text-[10px] font-semibold transition-all"
                          style={{
                            background: activeIdx === i ? 'var(--primary)' : 'var(--primary-light)',
                            color: activeIdx === i ? '#fff' : 'var(--primary)',
                          }}
                        >
                          {i + 1}
                          {savedSet.has(i) && (
                            <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full flex items-center justify-center" style={{ background: 'var(--success)' }}>
                              <Check size={6} className="text-white" />
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                    <button
                      onClick={() => setActiveIdx((i) => Math.min(results.length - 1, i + 1))}
                      disabled={activeIdx === results.length - 1}
                      className="w-6 h-6 rounded-full flex items-center justify-center transition-all disabled:opacity-30"
                      style={{ background: 'var(--primary-light)', color: 'var(--primary)' }}
                      aria-label="下一篇"
                    >
                      <ChevronRight size={14} />
                    </button>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleRegenerate}
                  className="btn-outlined flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium"
                >
                  <RotateCcw size={11} />
                  重新生成
                </button>
                <button
                  onClick={handleResetAll}
                  className="btn-outlined flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium"
                  title="清空原文和结果，回到空白输入界面"
                >
                  <Eraser size={11} />
                  初始化
                </button>
                <button
                  onClick={handleSave}
                  disabled={isSaved || saving}
                  className={`btn-outlined flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium ${isSaved ? 'saved' : ''}`}
                >
                  {saving ? <Loader2 size={11} className="animate-spin" /> : isSaved ? <Check size={11} /> : <Save size={11} />}
                  {saving ? '保存中' : isSaved ? '已保存' : editingId ? '更新' : '保存'}
                </button>
                <button
                  onClick={handleCopy}
                  className="btn-primary flex items-center gap-1.5 px-4 py-1.5 rounded-full text-[11px] font-medium"
                >
                  {copiedIdx === activeIdx ? <Check size={11} /> : <Copy size={11} />}
                  {copiedIdx === activeIdx ? '已复制' : '复制文案'}
                </button>
              </div>
            </div>

            {/* Similarity verdict — 核心卖点的量化反馈 */}
            {verdict && (
              <div
                className="flex items-start gap-2.5 px-3 py-2.5 rounded-xl"
                style={{
                  background: verdict.level === 'good' ? 'var(--success-light, var(--bg))' : verdict.level === 'fair' ? 'var(--accent-light)' : 'var(--primary-light)',
                  border: '1px solid ' + (verdict.level === 'good' ? 'var(--success)' : verdict.level === 'fair' ? 'var(--accent)' : 'var(--primary)'),
                }}
              >
                <ShieldCheck
                  size={15}
                  className="shrink-0 mt-0.5"
                  style={{ color: verdict.level === 'good' ? 'var(--success)' : verdict.level === 'fair' ? 'var(--accent)' : 'var(--primary)' }}
                />
                <div className="min-w-0">
                  <p className="text-xs font-semibold" style={{ color: 'var(--text)' }}>
                    与原文相似度 {verdict.score}% · {verdict.label}
                  </p>
                  <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-2)' }}>{verdict.hint}</p>
                </div>
              </div>
            )}

            {selfOverlap && (
              <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-xl"
                style={{ background: 'var(--accent-light)', border: '1px solid var(--accent)' }}>
                <ShieldCheck size={15} className="shrink-0 mt-0.5" style={{ color: 'var(--accent)' }} />
                <div className="min-w-0">
                  <p className="text-xs font-semibold" style={{ color: 'var(--text)' }}>
                    与你自己的《{selfOverlap.title}》重合 {selfOverlap.score}%
                  </p>
                  <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-2)' }}>
                    同账号发布高度相似的内容一样会被限流，建议再改改表达
                  </p>
                </div>
              </div>
            )}

            {usedExamples.length > 0 && !selfOverlap && (
              <p className="text-[11px]" style={{ color: 'var(--text-3)' }}>
                参考了你的 {usedExamples.length} 篇历史素材来把握语气
              </p>
            )}

            {failedCount > 0 && (
              <p className="text-[11px]" style={{ color: 'var(--danger)' }}>
                本次有 {failedCount} 篇生成失败，已保留成功的 {results.length} 篇
              </p>
            )}

            {/* Title */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[11px] font-medium" style={{ color: 'var(--text-3)' }}>标题</span>
                <span className="text-[11px]" style={{ color: titleLen > 20 ? 'var(--danger)' : 'var(--text-3)' }}>
                  {titleLen}/20
                </span>
              </div>
              <input
                value={current?.title || ''}
                onChange={(e) => updateResult('title', e.target.value)}
                className="w-full font-semibold text-base px-3 py-2.5 border rounded-xl input-glow"
                style={{ color: 'var(--text)', borderColor: titleLen > 20 ? 'var(--danger)' : 'var(--border)', background: 'var(--bg)' }}
              />
            </div>

            {/* Content */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[11px] font-medium" style={{ color: 'var(--text-3)' }}>正文</span>
                <span className="text-[11px]" style={{ color: contentLen > 1000 ? 'var(--danger)' : 'var(--text-3)' }}>
                  {contentLen}/1000
                </span>
              </div>
              <textarea
                value={current?.content || ''}
                onChange={(e) => updateResult('content', e.target.value)}
                rows={Math.min(12, Math.max(6, (current?.content || '').split('\n').length + 2))}
                className="w-full text-sm leading-relaxed px-3 py-2.5 border rounded-xl resize-none input-glow"
                style={{ color: 'var(--text-2)', borderColor: contentLen > 1000 ? 'var(--danger)' : 'var(--border)', background: 'var(--bg)' }}
              />
            </div>

            {/* Tags */}
            <div>
              <div className="text-[11px] font-medium mb-1.5" style={{ color: 'var(--text-3)' }}>标签</div>
              <div className="flex flex-wrap gap-1.5 items-center">
                {(current?.tags || []).map((t, i) => (
                  <span key={i} className="tag-chip">
                    #{t}
                    <button
                      onClick={() => removeTag(i)}
                      className="ml-0.5 w-3.5 h-3.5 rounded-full flex items-center justify-center hover:bg-red-200 transition-colors"
                      aria-label={`移除标签 ${t}`}
                    >
                      <X size={8} />
                    </button>
                  </span>
                ))}
                <span className="inline-flex items-center gap-1">
                  <input
                    value={newTag}
                    onChange={(e) => setNewTag(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }}
                    placeholder="添加标签"
                    className="w-20 text-[11px] px-2.5 py-1 border rounded-full input-glow"
                    style={{ borderColor: 'var(--border)' }}
                  />
                  {newTag.trim() && (
                    <button
                      onClick={addTag}
                      className="w-5 h-5 rounded-full flex items-center justify-center"
                      style={{ background: 'var(--primary)', color: '#fff' }}
                      aria-label="添加标签"
                    >
                      <Plus size={9} />
                    </button>
                  )}
                </span>
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="alert-yellow">
            <span>⚠</span>
            {error}
          </div>
        )}
      </div>

      {/* ====== Right Column: Phone Preview (sticky) ====== */}
      <div className="lg:sticky lg:top-16 lg:self-start space-y-3">
        <div className="text-center">
          <span className="preview-badge">
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--primary)' }} />
            实时预览
          </span>
        </div>
        <PhonePreview
          title={current?.title}
          content={current?.content}
          tags={current?.tags}
          imageData={cover}
          imageCount={images.length}
          author={author}
          compact
        />
      </div>

      {/* Toast */}
      {toast && (
        <div className="toast">
          <div className={`toast-inner ${toast.kind === 'success' ? 'success' : 'error'}`}>
            {toast.kind === 'success' ? <Check size={14} /> : <X size={14} />}
            {toast.msg}
          </div>
        </div>
      )}
    </div>
  );
}
