import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { loadHistory, deleteRound, clearHistory, formatTime } from '../data/history';

const EFFECT_LABEL: Record<string, string> = {
  good: '🎉 明显好一些',
  some: '👍 好像有点',
  none: '🤔 没变化',
  worse: '😅 更差了',
};

export default function History() {
  const navigate = useNavigate();
  const [list, setList] = useState(() => loadHistory());
  const [openId, setOpenId] = useState<string | null>(null);

  const refresh = () => setList(loadHistory());

  const remove = (id: string) => {
    deleteRound(id);
    if (openId === id) setOpenId(null);
    refresh();
  };

  const clearAll = () => {
    if (!list.length) return;
    if (!window.confirm('清空所有历史记录？清空后无法恢复。')) return;
    clearHistory();
    setOpenId(null);
    refresh();
  };

  return (
    <div className="mx-auto w-full max-w-xl px-5 py-8 space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[24px] font-black text-gray-900 tracking-tight">历史记录</h1>
          <p className="mt-1 text-[12.5px] text-gray-500">每一轮诊断都会存一份，只存在这台手机/浏览器里，不上传。</p>
        </div>
        <button
          type="button"
          onClick={() => navigate('/')}
          className="flex-shrink-0 whitespace-nowrap text-[13px] text-gray-500 px-3 py-1.5 rounded-xl hover:bg-white/70 transition"
        >
          ← 返回
        </button>
      </div>

      {list.length === 0 ? (
        <div className="bg-white/80 border border-mint-100 rounded-2xl p-6 text-center text-[13.5px] text-gray-500">
          还没有历史记录。走完一轮第 7 步后，这里会自动留下一条。
        </div>
      ) : (
        <>
          <div className="space-y-3">
            {list.map(r => {
              const open = openId === r.id;
              return (
                <div key={r.id} className="bg-white rounded-2xl border border-mint-100 shadow-soft overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setOpenId(open ? null : r.id)}
                    className="w-full text-left px-4 py-3 flex items-start gap-3 active:bg-mint-50/50 transition"
                  >
                    <span className="text-xl flex-shrink-0 mt-0.5">🛒</span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-[14.5px] font-bold text-gray-900 truncate">
                        {r.sellWhat || '未填品类'}{r.whereSell ? ` · ${r.whereSell}` : ''}
                      </span>
                      <span className="block text-[11.5px] text-gray-400 mt-0.5">
                        {formatTime(r.createdAt)}
                        {r.effect ? ` · ${EFFECT_LABEL[r.effect] || r.effect}` : ''}
                        {r.chat.length ? ` · ${r.chat.length} 条对话` : ''}
                      </span>
                      {!open && r.mainProblem && (
                        <span className="block text-[12.5px] text-gray-600 mt-1 line-clamp-1">
                          {r.mainProblem}
                        </span>
                      )}
                    </span>
                    <span className="text-gray-300 flex-shrink-0 text-[12px]">{open ? '▲' : '▼'}</span>
                  </button>

                  {open && (
                    <div className="px-4 pb-4 space-y-3">
                      {r.spotType && (
                        <Block label="点位" text={`${r.spotType}${r.myDifficulty ? ` · ${r.myDifficulty}` : ''}`} />
                      )}
                      {r.mainProblem && <Block label="AI 诊断" text={r.mainProblem} />}
                      {r.doWhat && <Block label="这一轮做的" text={r.doWhat} />}
                      {r.measureTip && <Block label="怎么量" text={r.measureTip} />}

                      {r.chat.length > 0 && (
                        <div>
                          <div className="text-[11px] font-black tracking-wider text-gray-400 mb-1.5">对话记录</div>
                          <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
                            {r.chat.map((m, i) => (
                              <div
                                key={i}
                                className={
                                  m.role === 'user'
                                    ? 'text-[12.5px] leading-relaxed rounded-xl px-3 py-2 bg-mint-50 text-gray-700'
                                    : 'text-[12.5px] leading-relaxed rounded-xl px-3 py-2 bg-gray-50 text-gray-600'
                                }
                              >
                                <span className="font-bold text-gray-500 mr-1">{m.role === 'user' ? '我' : 'AI'}</span>
                                {m.text}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      <button
                        type="button"
                        onClick={() => remove(r.id)}
                        className="text-[12px] text-red-500 px-2 py-1 rounded-lg hover:bg-red-50 transition"
                      >
                        删除这条记录
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <button
            type="button"
            onClick={clearAll}
            className="w-full py-2.5 rounded-2xl text-[13px] text-gray-500 bg-white/70 border border-gray-100 active:scale-[0.99] transition"
          >
            清空全部历史
          </button>
        </>
      )}
    </div>
  );
}

function Block({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <div className="text-[11px] font-black tracking-wider text-gray-400 mb-1">{label}</div>
      <p className="text-[13px] text-gray-800 leading-relaxed whitespace-pre-line">{text}</p>
    </div>
  );
}
