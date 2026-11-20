/**
 * CelebrateModal —— 闭环结束用的庆祝弹窗
 * 展示这次会话的全部交付物（诊断 / 方案 / 测量 / 执行 / 复盘）
 */
import { useEffect, type ReactNode } from 'react';
import type { SessionData } from '../data/schema';

interface Props {
  open: boolean;
  session: SessionData;
  onPrimary: () => void;
  /** 保留本轮对话记录，继续开下一轮 */
  onContinue?: () => void;
}

export function CelebrateModal({ open, session, onPrimary, onContinue }: Props) {
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  if (!open) return null;

  const { judgment, solution, measureTip, lastAction, effect, screen1 } = session;

  // 交付物条目列表
  const items: Array<{ icon: string; label: string; value: string | ReactNode; color: string }> = [];

  if (screen1.sellWhat || screen1.whereSell) {
    items.push({
      icon: '🛒', label: '你的摊位画像',
      value: `${screen1.sellWhat || '卖…'} · ${screen1.whereSell || '…'}`,
      color: 'from-mint-500 to-mint-600',
    });
  }
  if (judgment?.mainProblem) {
    items.push({
      icon: '🔍', label: 'AI 诊断',
      value: judgment.mainProblem,
      color: 'from-sky-400 to-sky-500',
    });
  }
  if (judgment?.howToFix) {
    items.push({
      icon: '💡', label: '怎么解决',
      value: judgment.howToFix,
      color: 'from-amber-400 to-amber-500',
    });
  }
  if (solution?.doWhat) {
    items.push({
      icon: '🎯', label: '今天要做',
      value: solution.doWhat,
      color: 'from-rose-400 to-rose-500',
    });
  }
  if (solution?.costAndTime) {
    items.push({
      icon: '💰', label: '成本 / 退路',
      value: solution.costAndTime + (solution.revertPlan ? ` ｜ 退路：${solution.revertPlan}` : ''),
      color: 'from-purple-400 to-purple-500',
    });
  }
  if (measureTip) {
    items.push({
      icon: '📏', label: '明天怎么量',
      value: measureTip,
      color: 'from-teal-400 to-teal-500',
    });
  }
  if (lastAction) {
    items.push({
      icon: '✅', label: '已执行',
      value: lastAction,
      color: 'from-emerald-400 to-emerald-500',
    });
  }
  if (effect) {
    const map: Record<string, { emoji: string; label: string }> = {
      good:  { emoji: '🎉', label: '明显好一些' },
      some:  { emoji: '👍', label: '好像有点' },
      none:  { emoji: '🤔', label: '没变化' },
      worse: { emoji: '😅', label: '更差了' },
    };
    const v = map[effect];
    items.push({
      icon: v.emoji, label: '效果复盘',
      value: v.label,
      color: effect === 'good' || effect === 'some'
        ? 'from-emerald-400 to-emerald-500'
        : 'from-gray-400 to-gray-500',
    });
  }

  const isWin = effect === 'good' || effect === 'some';
  const gradientTop = isWin
    ? 'from-mint-100 via-mint-50 to-white'
    : 'from-amber-100 via-amber-50 to-white';
  const emoji = isWin ? '🏆' : '🔄';
  const title = isWin ? '恭喜你！闭环完成 ✨' : '换个方向，重新来';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-card-in">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div className="relative w-full max-w-md bg-white rounded-3xl shadow-float border border-mint-100 overflow-hidden max-h-[90vh] flex flex-col">
        {/* 渐变顶部 + emoji */}
        <div className={`h-28 bg-gradient-to-br ${gradientTop} flex items-center justify-center relative overflow-hidden flex-shrink-0`}>
          {/* 装饰性小圆点 */}
          <span className="absolute top-3 right-6 w-8 h-8 rounded-full bg-mint-200/40" />
          <span className="absolute bottom-3 left-8 w-5 h-5 rounded-full bg-mint-300/30" />
          <span className="text-5xl animate-float-slow drop-shadow-sm relative z-10">{emoji}</span>
        </div>

        {/* 标题 */}
        <div className="px-6 pt-4 pb-2 text-center flex-shrink-0">
          <h3 className="text-[18px] font-black text-gray-900 tracking-tight">{title}</h3>
          <p className="mt-1 text-[12.5px] text-gray-500">
            {isWin ? '这次你交付了这些东西：' : '没事，地摊就是要边摆边试。'}
          </p>
        </div>

        {/* 交付物清单 —— 可滚动 */}
        <div className="px-5 pb-2 flex-1 overflow-y-auto">
          {items.length > 0 ? (
            <div className="space-y-2">
              {items.map((it, idx) => (
                <div
                  key={idx}
                  className="flex gap-3 bg-gradient-to-br from-gray-50/80 to-white border border-gray-100 rounded-2xl px-3 py-2.5 animate-card-in"
                  style={{ animationDelay: `${idx * 60}ms` }}
                >
                  <div className={`w-8 h-8 flex-shrink-0 rounded-xl bg-gradient-to-br ${it.color} text-white text-sm flex items-center justify-center shadow-sm`}>
                    {it.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] font-black tracking-wider text-gray-400 uppercase">{it.label}</div>
                    <div className="text-[13px] text-gray-800 leading-snug line-clamp-3">
                      {it.value}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center text-gray-400 py-6 text-[13px]">
              还没有产出，开始新一轮吧
            </div>
          )}
        </div>

        {/* 底部按钮 */}
        <div className="px-5 pt-2 pb-4 flex-shrink-0">
          <button
            type="button"
            onClick={onPrimary}
            style={{backgroundImage:'linear-gradient(to bottom right, #1f7a44, #176338)', color:'#fff'}}
            className="btn-pop w-full py-3 rounded-2xl text-white text-[15px] font-bold shadow-pop active:scale-[0.98]"
          >
            {isWin ? '🚀 开新一轮，更上一层' : '🔄 重新开始'}
          </button>
          {onContinue && (
            <button
              type="button"
              onClick={onContinue}
              style={{ background: '#f0faf3', color: '#176338', border: '1px solid #d1fae5' }}
              className="mt-2 w-full py-3 rounded-2xl text-[14px] font-bold active:scale-[0.98] transition"
            >
              📎 带着这轮记录，继续下一轮
            </button>
          )}
          <p className="mt-2 text-center text-[11px] text-gray-400">
            本轮已存进历史记录，随时能翻回来看
          </p>
        </div>
      </div>
    </div>
  );
}
