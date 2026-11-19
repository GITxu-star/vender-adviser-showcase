import { useEffect, useState } from 'react';
import AiChat, { triggerAi } from './AiChat';

interface AiSheetProps {
  expanded: boolean;
  onExpandedChange: (v: boolean) => void;
  /** 当前屏的「诊断」引导语；点「诊断」按钮时手动发给 AI */
  hint?: string;
}

const HINT_KEY = 'va_diag_hint_seen_v1';

/**
 * 移动端专用：底部常驻输入条 + 展开后的半屏对话
 * 桌面端不渲染本组件（右侧常驻面板保持不变）
 */
export default function AiSheet({ expanded, onExpandedChange, hint }: AiSheetProps) {
  // 首次进入时给「AI 诊断」按钮一个气泡提示，点过就再也不出现
  const [showHint, setShowHint] = useState(false);

  useEffect(() => {
    if (!hint || expanded) {
      setShowHint(false);
      return;
    }
    try {
      if (localStorage.getItem(HINT_KEY)) return;
    } catch {
      // 隐私模式下 localStorage 可能不可用，忽略即可
    }
    setShowHint(true);
  }, [hint, expanded]);

  const dismissHint = () => {
    setShowHint(false);
    try {
      localStorage.setItem(HINT_KEY, '1');
    } catch {
      // ignore
    }
  };

  const diagnose = () => {
    if (!hint) return;
    dismissHint();
    onExpandedChange(true);
    triggerAi(hint);
  };

  return (
    <div className="md:hidden fixed inset-x-0 bottom-0 z-40">
      {expanded ? (
        <div className="h-[55vh] flex flex-col bg-white rounded-t-3xl border-t border-mint-100 shadow-[0_-8px_30px_-12px_rgba(0,0,0,0.25)] overflow-hidden">
          {/* 拖动条：点一下收起 */}
          <button
            type="button"
            onClick={() => onExpandedChange(false)}
            className="w-full py-2 flex justify-center flex-shrink-0"
            aria-label="收起对话"
          >
            <span className="w-10 h-1.5 rounded-full bg-gray-200" />
          </button>
          <div className="flex-1 min-h-0">
            <AiChat compact onClose={() => onExpandedChange(false)} />
          </div>
        </div>
      ) : (
        <div className="relative mx-3 mb-3 flex items-center gap-2 bg-white rounded-2xl border border-mint-100 shadow-float px-3 py-2.5">
          {hint && showHint && (
            <button
              type="button"
              onClick={dismissHint}
              className="absolute -top-11 right-1 z-10 bg-gray-900/95 text-white text-[12px] leading-snug px-3 py-1.5 rounded-xl shadow-lg whitespace-nowrap active:scale-[0.98] transition"
            >
              点「AI 诊断」，我帮你看这一步 👇
            </button>
          )}
          <button
            type="button"
            onClick={() => onExpandedChange(true)}
            className="flex-1 flex items-center gap-2 text-left active:scale-[0.99] transition"
          >
            <span className="text-base">💬</span>
            <span className="text-[14px] text-gray-400">问 AI：我该先改什么？</span>
          </button>
          {hint && (
            <button
              type="button"
              onClick={diagnose}
              style={{backgroundImage:'linear-gradient(to bottom right, #1f7a44, #176338)', color:'#fff'}}
              className={`flex-shrink-0 text-[13px] font-bold px-3 py-1.5 rounded-xl shadow-pop active:scale-95 transition ${showHint ? 'animate-pulse' : ''}`}
            >
              AI 诊断
            </button>
          )}
        </div>
      )}
    </div>
  );
}
