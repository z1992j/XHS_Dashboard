import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

interface ModalProps {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** 智能录入等多条预览要更宽 */
  wide?: boolean;
  /** 详情卡是窄弹窗，居中卡片式 */
  narrow?: boolean;
}

/**
 * 通用弹窗外壳：遮罩、标题、关闭按钮、Esc 关闭、点遮罩关闭。
 * Esc 的优先级照抄旧版：同时开着多个层时只关最上面那个 ——
 * 确认层(400) > 弹窗(300)，确认层自己监听自己，这里只管本层。
 */
export default function Modal({ title, onClose, children, wide, narrow }: ModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (typeof document === 'undefined') return null;

  const cls = narrow ? 'orders-modal orders-modal-narrow' : `orders-modal${wide ? ' orders-modal-wide' : ''}`;

  return createPortal(
    <div
      className="orders-modal-overlay active"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={cls} role="dialog" aria-modal="true">
        <h2 className="orders-modal-title">
          <span className="orders-modal-title-text">{title}</span>
          <button
            type="button"
            className="orders-modal-close"
            aria-label="关闭"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </h2>
        <div className="orders-modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
