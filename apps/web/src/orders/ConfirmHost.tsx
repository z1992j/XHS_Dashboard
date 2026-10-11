import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { setConfirmImpl } from './confirm';

/**
 * 应用内确认宿主（替代 window.confirm）。
 *
 * 挂载时把自己注入 confirm.ts；文案里的 \n 配合 .orders-confirm-message
 * 的 white-space:pre-wrap 换行显示（删除确认的「撤销」提示是两行文案）。
 */

interface Pending {
  message: string;
  title?: string;
  resolve: (ok: boolean) => void;
}

/** 层级：弹窗 300 < 确认 400，登录层 500 由 LoginOverlay 自己占。 */
const CONFIRM_Z = 400;

export default function ConfirmHost() {
  const [pending, setPending] = useState<Pending | null>(null);
  const [mounted, setMounted] = useState(false);
  const pendingRef = useRef<Pending | null>(null);

  useEffect(() => {
    setMounted(true);
    const prev = setConfirmImpl((message, opts) => {
      const current = pendingRef.current;
      // 上一个确认还没答，先按取消结掉，避免留下永不 resolve 的 Promise
      if (current) current.resolve(false);
      return new Promise<boolean>((resolve) => {
        const next = { message, title: opts?.title, resolve };
        pendingRef.current = next;
        setPending(next);
      });
    });
    return () => {
      setConfirmImpl(prev);
      if (pendingRef.current) {
        pendingRef.current.resolve(false);
        pendingRef.current = null;
      }
    };
  }, []);

  const settle = (ok: boolean) => {
    const current = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    if (current) current.resolve(ok);
  };

  if (!mounted || !pending) return null;

  return createPortal(
    <div
      className="orders-modal-overlay active orders-confirm-overlay"
      style={{ zIndex: CONFIRM_Z }}
      onClick={(e) => {
        if (e.target === e.currentTarget) settle(false);
      }}
    >
      <div className="orders-modal orders-confirm-modal" role="alertdialog" aria-modal="true">
        {pending.title && <h2 className="orders-confirm-title">{pending.title}</h2>}
        <div className="orders-confirm-message">{pending.message}</div>
        <div className="orders-modal-actions">
          <button type="button" className="orders-btn orders-btn-cancel" onClick={() => settle(false)}>
            取消
          </button>
          <button
            type="button"
            className="orders-btn orders-btn-danger"
            onClick={() => settle(true)}
            autoFocus
          >
            确定
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
