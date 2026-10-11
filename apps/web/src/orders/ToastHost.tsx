import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { dismissToast, subscribeToasts } from './toast';
import type { ToastItem } from './toast';

/**
 * 页面内提示宿主：渲染在订单页根部，登录页和弹窗上层都盖得住。
 * 倒计时逻辑照抄旧版 toast()：
 * - 时长规则 action=8000 / error=6000 / 其他 3500，可用 duration 覆盖；
 * - 鼠标停在上面时不自动收走，读长报错时不会看到一半消失；
 * - 只认真鼠标（pointerType==='mouse'）：手机上点一下会触发 mouseenter
 *   却不会有 mouseleave，用 mouse 事件的话提示会永远挂在屏幕上。
 */

const TYPE_LABEL: Record<ToastItem['type'], string> = {
  info: '提示',
  success: '成功',
  warn: '警告',
  error: '错误',
};

interface Row {
  item: ToastItem;
  leaving: boolean;
  /** 每条自己持有的计时器句柄，供悬停暂停/恢复 */
  armRef: { timer: number | null; ms: number };
}

function durationOf(item: ToastItem): number {
  return item.action ? 8000 : item.type === 'error' ? 6000 : 3500;
}

export default function ToastHost() {
  const [rows, setRows] = useState<Row[]>([]);
  const [mounted, setMounted] = useState(false);
  const rowsRef = useRef<Row[]>([]);

  useEffect(() => {
    setMounted(true);
    const dismiss = (id: number) => {
      // 离场动画期间先标记 leaving，200ms 后真正移除
      const cur = rowsRef.current;
      const target = cur.find((r) => r.item.id === id);
      if (!target || target.leaving) return;
      if (target.armRef.timer !== null) window.clearTimeout(target.armRef.timer);
      const marked = cur.map((r) => (r.item.id === id ? { ...r, leaving: true } : r));
      rowsRef.current = marked;
      setRows(marked);
      window.setTimeout(() => dismissToast(id), 200);
    };

    const unsub = subscribeToasts((items) => {
      // 订阅回调拿到的是全量列表：新增的行补计时器，已移除的行直接丢弃
      const prev = rowsRef.current;
      const kept = prev.filter((r) => items.some((t) => t.id === r.item.id));
      const added = items
        .filter((t) => !prev.some((r) => r.item.id === t.id))
        .map<Row>((item) => {
          const armRef = { timer: null as number | null, ms: durationOf(item) };
          return { item, leaving: false, armRef };
        });
      const next = [...kept, ...added];
      rowsRef.current = next;
      setRows(next);
      for (const r of added) {
        r.armRef.timer = window.setTimeout(() => dismiss(r.item.id), r.armRef.ms);
      }
    });
    return () => {
      unsub();
      for (const r of rowsRef.current) {
        if (r.armRef.timer !== null) window.clearTimeout(r.armRef.timer);
      }
      rowsRef.current = [];
    };
  }, []);

  if (!mounted) return null;

  return createPortal(
    <div className="orders-toast-stack" aria-live="polite">
      {rows.map((r) => {
        const { item } = r;
        const dismissNow = () => dismissToast(item.id);
        return (
          <div
            key={item.id}
            className={`orders-toast orders-toast-${item.type}${r.leaving ? ' leaving' : ''}`}
            role={item.type === 'error' ? 'alert' : 'status'}
            onPointerEnter={(e) => {
              // 只认真鼠标：手机上 mouseenter 无 mouseleave 会永久挂着
              if (e.pointerType === 'mouse' && r.armRef.timer !== null) {
                window.clearTimeout(r.armRef.timer);
                r.armRef.timer = null;
              }
            }}
            onPointerLeave={(e) => {
              if (e.pointerType !== 'mouse' || r.leaving) return;
              if (r.armRef.timer === null) {
                r.armRef.timer = window.setTimeout(() => dismissToast(item.id), 2000);
              }
            }}
          >
            <span className="orders-toast-text">{item.message}</span>
            {item.action && (
              <button
                type="button"
                className="orders-toast-action"
                onClick={() => {
                  dismissToast(item.id);
                  item.action!.onClick();
                }}
              >
                {item.action.label}
              </button>
            )}
            <button
              type="button"
              className="orders-toast-close"
              aria-label={`关闭${TYPE_LABEL[item.type]}`}
              onClick={dismissNow}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
