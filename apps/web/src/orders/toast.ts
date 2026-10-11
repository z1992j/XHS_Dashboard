/**
 * 页面内提示（替代旧版 alert）。
 *
 * alert() 在手机上是阻塞式弹窗，还会打断正在填的表单。这里用模块级 store +
 * 订阅，让任何非组件代码（csv / store / smartInput）都能直接调 toast()。
 *
 * opts.type: info / success / warn / error；opts.action: { label, onClick }（如「撤销」）。
 * 报错信息里可能带服务端原文，一律按纯文本塞，不当 HTML 解析（React 渲染
 * 文本节点天然安全）。
 */

export type ToastType = 'info' | 'success' | 'warn' | 'error';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
  action?: ToastAction;
}

interface ToastOptions {
  type?: ToastType;
  action?: ToastAction;
  /** 不传时按内容定时长：action=8000 / error=6000 / 其他 3500 */
  duration?: number;
}

let nextId = 1;
let items: ToastItem[] = [];
const listeners = new Set<(items: ToastItem[]) => void>();

function emit(): void {
  for (const fn of listeners) fn(items);
}

/** 供 ToastHost 订阅。返回取消订阅函数。 */
export function subscribeToasts(fn: (items: ToastItem[]) => void): () => void {
  listeners.add(fn);
  fn(items);
  return () => listeners.delete(fn);
}

export function getToasts(): ToastItem[] {
  return items;
}

/** 移除一条 toast（倒计时到点、点关闭或点操作按钮时调用）。 */
export function dismissToast(id: number): void {
  const next = items.filter((t) => t.id !== id);
  if (next.length === items.length) return;
  items = next;
  emit();
}

export function toast(message: string, opts: ToastOptions = {}): () => void {
  const item: ToastItem = {
    id: nextId++,
    type: opts.type || 'info',
    message,
    action: opts.action,
  };
  items = [...items, item];
  emit();
  return () => dismissToast(item.id);
}
