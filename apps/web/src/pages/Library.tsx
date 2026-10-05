import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { materialsApi, galleryOf, type Material } from '../lib/api';
import { copyNote } from '../lib/clipboard';
import { Trash2, Edit3, Copy, Check, FileText, Download, X, Search, ArrowUpDown, CheckSquare, Square, Images } from 'lucide-react';
import PhonePreview from '../components/PhonePreview';
import LibraryInsights from '../components/LibraryInsights';

const PAGE_SIZE = 20;

function Thumb({ material }: { material: Material }) {
  const src = material.imageData || material.imageUrl;
  const count = galleryOf(material).length;
  if (src) {
    return (
      <div className="relative w-14 h-14 rounded-xl overflow-hidden shrink-0" style={{ background: 'var(--bg)' }}>
        <img src={src} alt="" className="w-full h-full object-cover" />
        {count > 1 && (
          <span
            className="absolute bottom-0 right-0 text-[9px] px-1 flex items-center gap-0.5"
            style={{ background: 'rgba(0,0,0,.55)', color: '#fff' }}
          >
            <Images size={8} />{count}
          </span>
        )}
      </div>
    );
  }
  if (material.hasImage) {
    return (
      <div className="w-14 h-14 rounded-xl overflow-hidden shrink-0 flex items-center justify-center" style={{ background: 'var(--bg)' }}>
        <Download size={16} style={{ color: 'var(--text-3)' }} />
      </div>
    );
  }
  return null;
}

export default function Library() {
  const [materials, setMaterials] = useState<Material[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);
  const navigate = useNavigate();
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [downloadedId, setDownloadedId] = useState<number | null>(null);
  const [selected, setSelected] = useState<Material | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [sortOrder, setSortOrder] = useState<'newest' | 'oldest'>('newest');
  const [allTags, setAllTags] = useState<string[]>([]);
  const [showAllTags, setShowAllTags] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const buildQuery = useCallback((p: number) => {
    const params = new URLSearchParams();
    if (search.trim()) params.set('search', search.trim());
    if (tagFilter) params.set('tag', tagFilter);
    if (sortOrder === 'oldest') params.set('sort', 'oldest');
    params.set('page', String(p));
    params.set('pageSize', String(PAGE_SIZE));
    return params.toString();
  }, [search, tagFilter, sortOrder]);

  // 标签筛选取的是整个素材库的标签，而不是当前已加载的那几页
  const refreshTags = useCallback(() => {
    materialsApi.tags()
      .then((res) => setAllTags(res.data.map((t) => t.name)))
      .catch(() => { /* 标签栏拿不到就先空着，不影响列表 */ });
  }, []);

  useEffect(() => { refreshTags(); }, [refreshTags]);

  // Initial load + refetch on filter change (debounced while typing)
  useEffect(() => {
    // 清掉定时器只能拦住还没发出的请求；已经在路上的旧请求如果晚到，
    // 会把新关键词的结果覆盖成旧的。用 stale 标记丢弃过期响应。
    let stale = false;
    const timer = setTimeout(() => {
      materialsApi.list(buildQuery(1)).then((res) => {
        if (stale) return;
        setMaterials(res.data);
        setTotal(res.total);
        setPage(1);
      }).catch(() => {
        if (stale) return;
        setMaterials([]);
        setTotal(0);
      });
    }, search ? 300 : 0);
    return () => { stale = true; clearTimeout(timer); };
  }, [buildQuery, search]);

  const loadMore = async () => {
    if (loadingMore || !materials) return;
    setLoadingMore(true);
    try {
      const nextPage = page + 1;
      const res = await materialsApi.list(buildQuery(nextPage));
      setMaterials((prev) => [...(prev || []), ...res.data]);
      setTotal(res.total);
      setPage(nextPage);
    } catch {
      showToast('加载失败，请重试');
    } finally {
      setLoadingMore(false);
    }
  };

  const handleSelect = async (m: Material) => {
    if (selected?.id === m.id) {
      setSelected(null);
      return;
    }
    setSelected(m);
    if (m.hasImage && !m.imageData && !m.imageUrl) {
      const full = await materialsApi.get(m.id);
      setSelected(full);
      setMaterials((prev) => prev ? prev.map((x) => x.id === full.id ? full : x) : prev);
    }
  };

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 1800);
  };

  const handleCopy = async (m: Material) => {
    try {
      await copyNote(m);
      setCopiedId(m.id ?? null);
      showToast('已复制到剪贴板');
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      showToast('复制失败，请手动选中文本复制');
    }
  };

  const handleEdit = async (m: Material) => {
    const full = (m.imageData || m.imageUrl) ? m : (m.hasImage ? await materialsApi.get(m.id) : m);
    localStorage.setItem('load_material', JSON.stringify({
      id: full.id, title: full.title, content: full.content, tags: full.tags,
      imageData: full.imageData || full.imageUrl, images: galleryOf(full), prompt: full.prompt,
    }));
    navigate('/writer');
  };

  const handleDelete = async (id: number) => {
    if (!confirm('确定删除这篇文案？')) return;
    try {
      await materialsApi.delete(id);
      setMaterials((prev) => prev ? prev.filter((m) => m.id !== id) : prev);
      setTotal((t) => Math.max(0, t - 1));
      if (selected?.id === id) setSelected(null);
      refreshTags();
    } catch (e) {
      showToast(e instanceof Error ? e.message : '删除失败，请重试');
    }
  };

  const toggleSelect = (id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleBatchDelete = async () => {
    if (selectedIds.size === 0) return;
    if (!confirm(`确定删除选中的 ${selectedIds.size} 篇文案？`)) return;
    try {
      const removed = selectedIds.size;
      await materialsApi.batchDelete([...selectedIds]);
      setMaterials(prev => prev ? prev.filter(m => !selectedIds.has(m.id)) : prev);
      setTotal((t) => Math.max(0, t - removed));
      if (selected && selectedIds.has(selected.id)) setSelected(null);
      setSelectedIds(new Set());
      setSelectMode(false);
      refreshTags();
      showToast(`已删除 ${removed} 篇`);
    } catch (e) {
      showToast(e instanceof Error ? e.message : '批量删除失败，请重试');
    }
  };

  const handleExport = () => {
    if (!materials) return;
    const items = materials.filter(m => selectedIds.has(m.id));
    const text = items.map(m => {
      const tagLine = (m.tags || []).map(t => '#' + t).join(' ');
      return `📌 ${m.title}\n\n${m.content}\n\n${tagLine}\n${'─'.repeat(30)}`;
    }).join('\n\n');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const link = document.createElement('a');
    const dateStr = new Date().toISOString().slice(0, 10);
    link.download = `薯文素材_${dateStr}.txt`;
    link.href = URL.createObjectURL(blob);
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    showToast(`已导出 ${items.length} 篇`);
  };

  const safeFileName = (m: Material) =>
    m.title.slice(0, 20).replace(/[/\\?%*:|"<>]/g, '') || '未命名';

  const handleDownloadImage = async (m: Material) => {
    const full = (m.imageData || m.imageUrl) ? m : (m.hasImage ? await materialsApi.get(m.id) : m);
    setDownloadedId(m.id ?? null);
    showToast('图片已下载');
    setTimeout(() => setDownloadedId(null), 2000);
    const imgSrc = full.imageData || full.imageUrl;
    if (imgSrc) {
      const isPng = imgSrc.startsWith('data:image/png');
      const link = document.createElement('a');
      link.download = `${safeFileName(m)}.${isPng ? 'png' : 'jpg'}`;
      link.href = imgSrc;
      link.click();
      return;
    }
    // No image — generate a title card on canvas
    const canvas = document.createElement('canvas');
    canvas.width = 1080;
    canvas.height = 1440;
    const ctx = canvas.getContext('2d')!;
    const grad = ctx.createLinearGradient(0, 0, 1080, 1440);
    // canvas 读不到 CSS 变量，只能写死；跟 --gradient-primary 保持同一组蓝
    grad.addColorStop(0, '#17306e');
    grad.addColorStop(1, '#2f5fd0');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 1080, 1440);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 72px -apple-system, "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const maxWidth = 900;
    const lineHeight = 96;
    const words = m.title.split('');
    const textLines: string[] = [];
    let currentLine = '';
    for (const char of words) {
      const testLine = currentLine + char;
      if (ctx.measureText(testLine).width > maxWidth && currentLine) {
        textLines.push(currentLine);
        currentLine = char;
      } else {
        currentLine = testLine;
      }
    }
    if (currentLine) textLines.push(currentLine);
    const startY = 720 - ((textLines.length - 1) * lineHeight) / 2;
    for (let i = 0; i < textLines.length; i++) {
      ctx.fillText(textLines[i], 540, startY + i * lineHeight);
    }
    const link = document.createElement('a');
    link.download = `${safeFileName(m)}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  };

  if (!materials) return <div className="text-center py-20" style={{ color: 'var(--text-3)' }}>加载中...</div>;

  const hasMore = materials.length < total;

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold" style={{ color: 'var(--text)' }}>素材库</h2>
        <div className="flex items-center gap-2">
          {materials.length > 0 && (
            <button
              onClick={() => { setSelectMode(!selectMode); setSelectedIds(new Set()); }}
              className="text-xs px-3 py-1.5 rounded-full font-medium transition-all"
              style={{
                border: '1.5px solid ' + (selectMode ? 'var(--primary)' : 'var(--border)'),
                background: selectMode ? 'var(--primary)' : 'var(--bg-card)',
                color: selectMode ? '#fff' : 'var(--text-3)',
              }}
            >
              {selectMode ? '取消选择' : '选择'}
            </button>
          )}
          <span className="text-xs font-semibold px-2.5 py-1 rounded-full" style={{ background: 'var(--primary-light)', color: 'var(--primary)' }}>
            共 {total} 篇
          </span>
        </div>
      </div>

      {/* Search + Sort */}
      <div className="flex items-center gap-2 mb-3">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-3)' }} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索标题、正文关键词..."
            className="search-input"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 rounded-full flex items-center justify-center"
              style={{ background: 'var(--border)' }}
              aria-label="清除搜索"
            >
              <X size={8} style={{ color: 'var(--text-3)' }} />
            </button>
          )}
        </div>
        <button
          onClick={() => setSortOrder(s => s === 'newest' ? 'oldest' : 'newest')}
          className="flex items-center gap-1.5 px-3 py-2.5 rounded-xl text-xs font-medium white-card shrink-0"
          style={{ color: 'var(--text-2)' }}
        >
          <ArrowUpDown size={12} />
          {sortOrder === 'newest' ? '最新' : '最早'}
        </button>
      </div>

      {/* Tag Filters */}
      {allTags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-4">
          <button
            onClick={() => setTagFilter('')}
            className="text-[11px] px-3 py-1 rounded-full font-medium transition-all"
            style={{
              background: !tagFilter ? 'var(--primary)' : 'var(--bg-card)',
              color: !tagFilter ? '#fff' : 'var(--text-2)',
              border: '1px solid ' + (!tagFilter ? 'var(--primary)' : 'var(--border)'),
            }}
          >
            全部
          </button>
          {(showAllTags ? allTags : allTags.slice(0, 12)).map(tag => (
            <button
              key={tag}
              onClick={() => setTagFilter(t => t === tag ? '' : tag)}
              className="text-[11px] px-3 py-1 rounded-full font-medium transition-all"
              style={{
                background: tagFilter === tag ? 'var(--primary)' : 'var(--bg-card)',
                color: tagFilter === tag ? '#fff' : 'var(--primary)',
                border: '1px solid ' + (tagFilter === tag ? 'var(--primary)' : 'var(--border)'),
              }}
            >
              #{tag}
            </button>
          ))}
          {allTags.length > 12 && (
            <button
              onClick={() => setShowAllTags(v => !v)}
              className="text-[11px] px-3 py-1 rounded-full font-medium"
              style={{ color: 'var(--text-3)', border: '1px dashed var(--border)' }}
            >
              {showAllTags ? '收起' : `+${allTags.length - 12} 个标签`}
            </button>
          )}
        </div>
      )}

      <LibraryInsights materials={materials} />

      {/* Content */}
      {materials.length === 0 ? (
        <div className="white-card empty-state">
          <div className="empty-state-icon">
            <FileText size={24} />
          </div>
          <p className="text-sm" style={{ color: 'var(--text-3)' }}>{search || tagFilter ? '没有找到匹配的文案' : '素材库还是空的'}</p>
          {!search && !tagFilter && (
            <button onClick={() => navigate('/writer')} className="mt-3 text-sm font-medium" style={{ color: 'var(--primary)' }}>
              去生成第一篇 →
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-5">
          {/* Card List */}
          <div className="flex flex-col gap-3">
            {materials.map((m) => (
              <div
                key={m.id}
                onClick={() => selectMode ? toggleSelect(m.id) : handleSelect(m)}
                className={`white-card px-4 py-3 cursor-pointer card-hoverable group ${selected?.id === m.id && !selectMode ? 'card-selected' : ''} ${selectMode && selectedIds.has(m.id) ? 'ring-2' : ''}`}
                style={{
                  ...(selectMode && selectedIds.has(m.id) ? { '--tw-ring-color': 'var(--primary)' } as React.CSSProperties : {}),
                }}
              >
                <div className="flex items-start justify-between gap-3">
                  {selectMode && (
                    <div className="pt-0.5 shrink-0">
                      {selectedIds.has(m.id) ? (
                        <CheckSquare size={18} style={{ color: 'var(--primary)' }} />
                      ) : (
                        <Square size={18} style={{ color: 'var(--border)' }} />
                      )}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold text-sm leading-snug line-clamp-1 mb-1" style={{ color: 'var(--text)' }}>{m.title}</h3>
                    <p className="text-xs line-clamp-2 mb-2" style={{ color: 'var(--text-2)' }}>{m.content}</p>
                    {m.tags && m.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1 mb-2">
                        {m.tags.slice(0, 3).map((t, i) => (
                          <span key={i} className="tag-chip">#{t}</span>
                        ))}
                        {m.tags.length > 3 && <span className="text-[11px]" style={{ color: 'var(--text-3)' }}>+{m.tags.length - 3}</span>}
                      </div>
                    )}
                  </div>
                  <Thumb material={m} />
                </div>
                <div className="flex items-center justify-between pt-2.5 mt-2 border-t" style={{ borderColor: 'var(--border-light)' }}>
                  <span className="text-[11px]" style={{ color: 'var(--text-3)' }}>
                    {new Date(m.createdAt).toLocaleDateString('zh-CN')}
                  </span>
                  <div className="flex items-center gap-1 card-actions">
                    <button onClick={(e) => { e.stopPropagation(); handleDownloadImage(m); }} className="btn-icon" title="下载图片" aria-label="下载图片">
                      {downloadedId === m.id ? <Check size={13} style={{ color: 'var(--success)' }} /> : <Download size={13} />}
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); handleCopy(m); }} className="btn-icon" title="复制文案" aria-label="复制文案">
                      {copiedId === m.id ? <Check size={13} style={{ color: 'var(--success)' }} /> : <Copy size={13} />}
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); handleEdit(m); }} className="btn-icon" title="载入编辑" aria-label="载入编辑">
                      <Edit3 size={13} />
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); handleDelete(m.id); }} className="btn-icon danger" title="删除" aria-label="删除">
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              </div>
            ))}

            {/* Load more */}
            {hasMore && (
              <button
                onClick={loadMore}
                disabled={loadingMore}
                className="white-card py-3 text-sm font-medium transition-colors"
                style={{ color: 'var(--primary)' }}
              >
                {loadingMore ? '加载中...' : `加载更多（已显示 ${materials.length}/${total}）`}
              </button>
            )}
            {!hasMore && materials.length > 0 && (
              <p className="text-center text-[11px] py-2" style={{ color: 'var(--text-3)' }}>已加载全部 {total} 篇</p>
            )}
          </div>

          {/* Preview Sidebar */}
          <div className="hidden lg:block">
            <div className="sticky top-16 self-start">
              <div className="text-center mb-2">
                <span className="preview-badge">
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--primary)' }} />
                  {selected ? '实时预览' : '点击文案卡片预览'}
                </span>
              </div>
              {selected ? (
                <PhonePreview
                  title={selected.title}
                  content={selected.content}
                  tags={selected.tags}
                  imageData={selected.imageData}
                  imageUrl={selected.imageUrl}
                  imageCount={galleryOf(selected).length}
                  author={localStorage.getItem('default_author') || '我的账号'}
                />
              ) : (
                <div className="flex justify-center">
                  {/* 空态占位要跟真机预览的外壳同色（.phone-frame 的 #1a1a1c），
                      它跟主题色无关；原来写的是旧调色板的 #1f2937，跟真机框对不上 */}
                  <div className="relative rounded-[44px] p-2 opacity-30" style={{ width: 320, height: 660, background: '#1a1a1c' }}>
                    <div className="rounded-[36px] h-full flex items-center justify-center" style={{ background: 'var(--bg)' }}>
                      <p className="text-sm" style={{ color: 'var(--text-3)' }}>选择一篇文案</p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Batch Action Bar */}
      {selectMode && selectedIds.size > 0 && (
        <div className="batch-bar">
          <div className="batch-bar-inner">
            <span className="text-sm font-semibold" style={{ color: 'var(--text)' }}>已选 {selectedIds.size} 项</span>
            <button onClick={handleExport} className="px-4 py-1.5 rounded-full text-xs font-medium text-white transition-colors" style={{ background: 'var(--success)' }}>
              导出
            </button>
            <button onClick={handleBatchDelete} className="px-4 py-1.5 rounded-full text-xs font-medium text-white transition-colors" style={{ background: 'var(--danger)' }}>
              删除
            </button>
          </div>
        </div>
      )}

      {/* Mobile Preview Sheet */}
      {selected && (
        <div className="bottom-sheet-overlay lg:hidden">
          <div
            className="bottom-sheet-backdrop"
            role="button"
            tabIndex={-1}
            style={{ cursor: 'pointer' }}
            onClick={() => setSelected(null)}
            onTouchEnd={(e) => { e.preventDefault(); setSelected(null); }}
          />
          <div className="bottom-sheet-content" onClick={e => e.stopPropagation()} onTouchEnd={e => e.stopPropagation()}>
            <div className="shrink-0 px-4 pt-2 pb-2">
              <div
                className="bottom-sheet-handle"
                role="button"
                tabIndex={-1}
                onClick={() => setSelected(null)}
                onTouchEnd={(e) => { e.preventDefault(); setSelected(null); }}
                style={{ cursor: 'pointer' }}
              />
              <div className="flex items-center justify-between mt-1">
                <span className="preview-badge">
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--primary)' }} />
                  实时预览
                </span>
                <button
                  onClick={() => setSelected(null)}
                  onTouchEnd={(e) => { e.preventDefault(); setSelected(null); }}
                  className="px-3 h-7 flex items-center gap-1 rounded-full text-xs"
                  style={{ background: 'var(--bg)', color: 'var(--text-3)' }}
                >
                  <X size={12} />
                  关闭
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-4 pb-6">
              <PhonePreview
                title={selected.title}
                content={selected.content}
                tags={selected.tags}
                imageData={selected.imageData}
                imageUrl={selected.imageUrl}
                imageCount={galleryOf(selected).length}
                author={localStorage.getItem('default_author') || '我的账号'}
              />
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className="toast">
          <div className="toast-inner success">
            <Check size={14} />
            {toast}
          </div>
        </div>
      )}
    </div>
  );
}
