import { useEffect } from 'react';
import AiChat from './AiChat';

interface AiDrawerProps {
  open: boolean;
  onClose: () => void;
}

export default function AiDrawer({ open, onClose }: AiDrawerProps) {
  // ESC 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      {/* 遮罩 */}
      <div
        className="fixed inset-0 bg-black/30 z-40"
        onClick={onClose}
      />
      {/* 抽屉：从右侧滑入 */}
      <div className="fixed top-0 right-0 bottom-0 w-[92vw] max-w-sm bg-white z-50 shadow-2xl animate-slide-in">
        <AiChat onClose={onClose} />
      </div>
    </>
  );
}
