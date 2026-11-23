import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BigButton } from '../components/BigButton';
import { ScreenHeader } from '../components/ScreenHeader';
import { OptionButton } from '../components/OptionButton';
import { CelebrateModal } from '../components/CelebrateModal';
import { useStore } from '../store/useStore';
import { extractCardPlan } from '../data/processor';
import { saveRound } from '../data/history';
import type { EffectResult } from '../data/schema';
import { EFFECT_OPTIONS } from '../data/schema';

export default function Screen7() {
  const navigate = useNavigate();
  const solution = useStore(s => s.solution);
  const lastAction = useStore(s => s.lastAction);
  const card4 = useStore(s => s.aiCards?.[4]);
  const effect = useStore(s => s.effect);
  const s1 = useStore(s => s.screen1);
  const update = useStore(s => s.update);
  const reset = useStore(s => s.reset);
  // 回溯顺序：屏 4 AI 卡片的真实动作 → 同步过的方案 → 本地记录
  const planFromCard = extractCardPlan(card4);
  const planFromSolution = (solution?.doWhat || '')
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);
  const action = (planFromCard.length ? planFromCard : planFromSolution).join('\n') || lastAction || '';
  const [modalOpen, setModalOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [afterShare, setAfterShare] = useState<null | (() => void)>(null);
  const [sharedCase, setSharedCase] = useState<null | { title: string; text: string }>(null);
  const [shareLoading, setShareLoading] = useState(false);
  const [shareMissed, setShareMissed] = useState(false);
  // 分享载荷快照：在「完成」那一刻固化下来，避免后续清空会话导致空数据被后端拒收
  const shareSnapRef = useRef<any>(null);

  // 本轮收尾：先问一次匿名分享，再走原来的去向
  const finishRound = () => {
    const cb = afterShare;
    setAfterShare(null);
    setShareOpen(false);
    setSharedCase(null);
    setShareLoading(false);
    setShareMissed(false);
    if (cb) cb();
  };

  const agreeShare = async () => {
    const st = useStore.getState();
    const snap = shareSnapRef.current;
    const src = snap || {
      sell_what: st.screen1.sellWhat,
      where_sell: st.screen1.whereSell,
      competitors: st.screen1.competitors,
      my_difficulty: st.screen1.myDifficulty,
      effect: st.effect,
      judgment: st.judgment,
      solution: st.solution,
    };
    const base = (import.meta as any).env?.VITE_API_BASE || '/api';
    setShareLoading(true);
    try {
      const res = await fetch(`${base}/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sell_what: src.sell_what,
          where_sell: src.where_sell,
          competitors: src.competitors,
          my_difficulty: src.my_difficulty,
          effect: src.effect,
          judgment: src.judgment,
          solution: src.solution,
        }),
      });
      const data = await res.json().catch(() => null);
      const ref = data && data.reference;
      if (ref && ref.text) {
        setSharedCase({ title: ref.title || '同行业案例', text: ref.text });
      } else {
        setShareMissed(true);
      }
    } catch {
      setShareMissed(true);
    } finally {
      setShareLoading(false);
    }
  };

  const pick = (v: EffectResult) => update('effect', v);

  const done = () => {
    if (!effect) return;
    const st0 = useStore.getState();
    shareSnapRef.current = {
      sell_what: st0.screen1.sellWhat,
      where_sell: st0.screen1.whereSell,
      competitors: st0.screen1.competitors,
      my_difficulty: st0.screen1.myDifficulty,
      effect: st0.effect,
      judgment: st0.judgment,
      solution: st0.solution,
    };
    // 这一轮结束：先存档，历史记录里能翻到
    saveRound(useStore.getState());
    setModalOpen(true);
  };

  // 带着这一轮的对话记录继续下一轮：问卷和 chat 都留着，只清掉每一步的旧结论
  const continueRound = () => {
    const st = useStore.getState();
    st.update('judgment', null);
    st.update('solution', null);
    st.update('measureTip', null);
    st.update('done', false);
    st.update('lastAction', null);
    st.update('effect', null);
    st.update('screenNum', 1);
    useStore.setState({ aiCards: {}, aiAnswers: {}, aiFingerprint: '' });
    setModalOpen(false);
    navigate('/screen/1');
  };

  const canDone = !!effect;

  // 判断：效果差 + 点位/竞争/困境匹配 → 给换点位建议
  const shouldSuggestMove = (() => {
    if (!effect) return false;
    if (effect !== 'none' && effect !== 'worse') return false;
    const d = s1.myDifficulty || '';
    const s = s1.spotType || '';
    const c = s1.competitors || '';
    return (
      d.includes('顾客越来越少') || d.includes('迷茫') ||
      s.includes('老片区') || c.includes('竞争激烈')
    );
  })();

  const moveSpot = () => {
    reset();
    update('screen1', {
      sellWhat: s1.sellWhat || '',
      price: s1.price || '',
      priceMin: s1.priceMin || '',
      priceMax: s1.priceMax || '',
      whereSell: '', dailyQty: '', stallFixed: '', dailyHours: '',
      stallType: '', timeSlot: '', weather: '', competitors: '',
      spotType: '', myDifficulty: '',
    });
    update('screenNum', 1);
    navigate('/screen/1');
  };

  return (
    <div className="space-y-6">
      <ScreenHeader
        title="回来看结果"
        subtitle="做完了，看看效果——实诚点答，AI 才好帮你。"
        aiHint="有用就往前推，没用就换方向。答得越实，建议越准。"
      />

      {/* 上次做的事 */}
      <div className="bg-gradient-to-br from-mint-50 to-white rounded-2xl border border-mint-100 p-4 shadow-soft">
        <div className="text-[11.5px] text-gray-500 mb-1 font-semibold">上次你做了</div>
        <p className="text-gray-800 text-[14px] whitespace-pre-line leading-relaxed">
          {action || '这一步还没让 AI 给方案——在下面问一句，我帮你补齐。'}
        </p>
      </div>

      {/* 效果选择 */}
      <div>
        <div className="text-[15px] font-semibold text-gray-900 mb-3">有效果吗？</div>
        <div className="grid gap-2 grid-cols-2">
          {EFFECT_OPTIONS.map(o => (
            <OptionButton
              key={o.value}
              label={o.label}
              selected={effect === o.value}
              onClick={() => pick(o.value)}
            />
          ))}
        </div>
      </div>

      {effect && <ResultHint effect={effect} shouldMove={shouldSuggestMove} onMove={moveSpot} />}

      <div className="pt-4">
        <BigButton onClick={done} disabled={!canDone}>
          {effect === 'good' || effect === 'some'
            ? '再往前推一步 →'
            : effect === 'none' || effect === 'worse'
              ? '换个方向 →'
              : '完成'}
        </BigButton>
      </div>

      {/* 庆祝/换方向弹窗 */}
      <CelebrateModal
        open={modalOpen}
        session={useStore.getState()}
        onPrimary={() => {
          setModalOpen(false);
          setAfterShare(() => () => { reset(); navigate('/screen/1'); });
          setShareOpen(true);
        }}
        onContinue={() => {
          setModalOpen(false);
          setAfterShare(() => () => continueRound());
          setShareOpen(true);
        }}
        onClose={() => setModalOpen(false)}
      />

      {shareOpen && (
        <SharePrompt
          caseRef={sharedCase}
          loading={shareLoading}
          missed={shareMissed}
          onAgree={agreeShare}
          onSkip={finishRound}
          onClose={finishRound}
        />
      )}
    </div>
  );
}

function SharePrompt({ caseRef, loading, missed, onAgree, onSkip, onClose }: {
  caseRef: { title: string; text: string } | null;
  loading: boolean;
  missed: boolean;
  onAgree: () => void; onSkip: () => void; onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[90] flex items-end sm:items-center justify-center px-4"
      style={{
        background: 'rgba(17,24,39,0.45)',
        backdropFilter: 'blur(2px)',
        paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 96px)',
      }}
    >
      <div
        style={{
          background: '#fff', borderRadius: 20, width: '100%', maxWidth: 420,
          boxShadow: '0 20px 60px -20px rgba(0,0,0,0.35)',
          maxHeight: '78vh', overflowY: 'auto',
        }}
        className="p-5"
      >
        {loading ? (
          <div className="py-8 flex flex-col items-center gap-2">
            <div className="w-8 h-8 rounded-full border-2 border-gray-200 border-t-mint-600 animate-spin" />
            <span className="text-[13px] text-gray-500">正在找同行业的脱敏案例…</span>
          </div>
        ) : caseRef ? (
          <>
            <div className="text-[15px] font-bold text-gray-900">给你一条同行业的脱敏参考案例</div>
            <div className="mt-3 rounded-xl bg-gray-50 border border-gray-100 p-3 max-h-56 overflow-y-auto">
              <div className="text-[12px] font-bold text-mint-700 mb-1">{caseRef.title}</div>
              <p className="text-[12.5px] text-gray-600 leading-relaxed whitespace-pre-line">{caseRef.text}</p>
            </div>
            <p className="mt-2 text-[11px] text-gray-400">
              案例已去掉店名、地址和联系方式，只保留做法与结果。
            </p>
            <button
              type="button"
              onClick={onClose}
              style={{ backgroundImage: 'linear-gradient(to bottom right, #1f7a44, #176338)', color: '#fff' }}
              className="mt-4 w-full py-3 rounded-2xl text-[14px] font-bold active:scale-[0.98] transition"
            >
              继续 →
            </button>
          </>
        ) : missed ? (
          <>
            <div className="text-[15px] font-bold text-gray-900">这次暂时没找到同行业的脱敏案例</div>
            <p className="mt-2 text-[13px] text-gray-600 leading-relaxed">
              分享已经记下了。你这一行的案例库还在积累，下次再来看看。
            </p>
            <button
              type="button"
              onClick={onClose}
              style={{ backgroundImage: 'linear-gradient(to bottom right, #1f7a44, #176338)', color: '#fff' }}
              className="mt-4 w-full py-3 rounded-2xl text-[14px] font-bold active:scale-[0.98] transition"
            >
              继续 →
            </button>
          </>
        ) : (
          <>
            <div className="text-[15px] font-bold text-gray-900">愿意匿名分享这次诊断吗？</div>
            <p className="mt-2 text-[13px] text-gray-600 leading-relaxed">
              只提交这次的品类、诊断结论和方案，<b>不含对话记录、不含身份信息</b>，
              用来积累更多摊位案例。同意的话，会顺便给你看一条同行业的脱敏参考案例。
            </p>
            <div className="mt-4 grid gap-2">
              <button
                type="button"
                onClick={onAgree}
                style={{ backgroundImage: 'linear-gradient(to bottom right, #1f7a44, #176338)', color: '#fff' }}
                className="w-full py-3 rounded-2xl text-[14px] font-bold active:scale-[0.98] transition"
              >
                愿意匿名分享
              </button>
              <button
                type="button"
                onClick={onSkip}
                style={{ background: '#f3f4f6', color: '#4b5563' }}
                className="w-full py-3 rounded-2xl text-[14px] font-bold active:scale-[0.98] transition"
              >
                不用，继续使用
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ResultHint({ effect, shouldMove, onMove }: {
  effect: EffectResult; shouldMove: boolean; onMove: () => void;
}) {
  const map: Record<EffectResult, { emoji: string; text: string }> = {
    good:  { emoji: '🎉', text: '不错！继续往前推，下一小步就能更明显。' },
    some:  { emoji: '👍', text: '有变化了！再坚持一下，或者再加一点力度。' },
    none:  { emoji: '🤔', text: '看来这个方向不对——换个思路试试。' },
    worse: { emoji: '😅', text: '没事，那就退回来，换一个完全不同的方向。' },
  };
  const { emoji, text } = map[effect];
  return (
    <div className="space-y-3">
      {/* 通用提示 */}
      <div className="bg-white/90 backdrop-blur-sm rounded-2xl border border-mint-100 p-5 flex gap-3 items-center shadow-card">
        <div className="text-3xl flex-shrink-0 animate-float-slow">{emoji}</div>
        <p className="text-[14px] text-gray-700 leading-relaxed">{text}</p>
      </div>

      {/* 换点位建议（仅效果差 + 困境匹配时显示） */}
      {shouldMove && (
        <div className="bg-gradient-to-br from-amber-50 via-orange-50 to-white rounded-2xl border border-amber-200 p-5 shadow-card">
          <div className="flex gap-3 items-start">
            <div className="text-3xl flex-shrink-0">🏃</div>
            <div className="flex-1 min-w-0">
              <div className="text-[14px] font-bold text-gray-800 mb-1.5">
                我怀疑不是你做得不够，是这个点位本身的问题
              </div>
              <p className="text-[13px] text-gray-600 leading-relaxed mb-3">
                你之前说这片顾客越来越少 / 竞争太激烈 —— 我同意。
                与其在红海里继续熬，不如找个新点位重新诊断一遍。
                你已经知道怎么卖了，换个地方说不定立刻就不一样。
              </p>
              <button
                type="button"
                onClick={onMove}
                className="inline-flex items-center gap-1.5 bg-gradient-to-br from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white text-[13px] font-bold px-4 py-2 rounded-xl shadow-soft transition-all active:scale-[0.98]"
              >
                🔄 保留品类，换个点位重新开始
              </button>
              <p className="text-[11px] text-gray-400 mt-2">
                （会保留你卖什么，其他问卷让你重新填）
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
