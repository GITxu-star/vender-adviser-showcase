/**
 * ConfirmModal —— 全项目统一的轻量确认弹窗
 * 用法：
 *   const [open, setOpen] = useState(false);
 *   <ConfirmModal open={open} onClose={() => setOpen(false)} onConfirm={() => {...}}
 *     title="确定吗？" body="这个操作不能撤销。" confirmText="删掉" danger />
 */
import { useEffect, type ReactNode } from 'react';

interface Props {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title?: string;
  body?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

export function ConfirmModal({
  open, onClose, onConfirm,
  title = '确定吗？', body,
  confirmText = '确定', cancelText = '取消',
  danger = false,
}: Props) {
  // ESC 关闭 + 背景锁定
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-card-in">
      {/* 遮罩 */}
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      {/* 弹窗 */}
      <div className="relative w-full max-w-sm bg-white rounded-3xl shadow-float border border-mint-100 overflow-hidden">
        <div className="px-6 pt-6 pb-4">
          <h3 className="text-[16px] font-bold text-gray-900">{title}</h3>
          {body && (
            <div className="mt-2 text-[14px] text-gray-600 leading-relaxed whitespace-pre-line">
              {body}
            </div>
          )}
        </div>
        <div className="px-4 pb-4 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 py-2.5 rounded-2xl text-[14px] font-medium text-gray-600 bg-gray-50 hover:bg-gray-100 transition-all active:scale-[0.98]"
          >
            {cancelText}
          </button>
          <button
            type="button"
            onClick={() => { onConfirm(); onClose(); }}
            className="flex-1 py-2.5 rounded-2xl text-[14px] font-semibold transition-all active:scale-[0.98]"
            style={{
              backgroundImage: danger
                ? 'linear-gradient(to bottom right, #f87171, #ef4444)'
                : 'linear-gradient(to bottom right, #1f7a44, #176338)',
              color: '#fff',
            }}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
