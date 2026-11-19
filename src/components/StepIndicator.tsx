import { useNavigate } from 'react-router-dom';
import { useStore } from '../store/useStore';

const TOTAL = 7;

export default function StepIndicator() {
  const navigate = useNavigate();
  const current = useStore(s => s.screenNum);

  const go = (n: number) => {
    if (n <= current) navigate(`/screen/${n}`);
  };

  return (
    <div className="bg-white/85 backdrop-blur-md border-b border-gray-100 sticky top-0 z-30">
      <div className="px-4 sm:px-8 py-3 flex items-center gap-4">
        {/* STEP X / 7 */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-[10px] font-black tracking-[0.18em] text-mint-500 uppercase">STEP</span>
          <span className="text-lg font-black text-gray-900 tabular-nums">{current}</span>
          <span className="text-xs text-gray-300 font-medium">/</span>
          <span className="text-xs text-gray-400 font-medium">{TOTAL}</span>
        </div>

        {/* 小圆点进度 */}
        <div className="flex items-center gap-2 flex-1 justify-end">
          {Array.from({ length: TOTAL }).map((_, i) => {
            const n = i + 1;
            const isDone = n < current;
            const isCurrent = n === current;
            const clickable = n <= current;

            return (
              <button
                key={n}
                type="button"
                onClick={() => go(n)}
                disabled={!clickable}
                className={
                  'transition-all duration-300 rounded-full ' +
                  (isCurrent
                    ? 'w-6 h-2.5 bg-gradient-to-r from-mint-500 to-mint-400 shadow-sm'
                    : isDone
                      ? 'w-2.5 h-2.5 bg-mint-400 cursor-pointer hover:scale-125'
                      : 'w-2 h-2 bg-gray-200' + (clickable ? ' cursor-pointer hover:bg-mint-300 hover:scale-110' : ''))
                }
                aria-label={`第 ${n} 步`}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
