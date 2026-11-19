﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BigButton } from '../components/BigButton';
import { ScreenHeader } from '../components/ScreenHeader';
import { OptionButton } from '../components/OptionButton';
import VisualSim from '../components/VisualSim';
import AiStepCardView from '../components/AiStepCardView';
import { triggerAi } from '../components/AiChat';
import { useStore } from '../store/useStore';
import { generateJudgment, regenerateJudgment, generateSolution, generateMeasureTip } from '../data/ai';
import { DISAGREE_REASONS } from '../data/schema';

export default function Screen3() {
  const navigate = useNavigate();
  const store = useStore(); // generateJudgment 需要整个 store 传参，保留
  const judgment = useStore(s => s.judgment);
  const solution = useStore(s => s.solution);
  const measureTip = useStore(s => s.measureTip);
  const update = useStore(s => s.update);

  // 首次进入时生成 AI 判断
  const initialJudgment = useMemo(() => {
    return judgment ?? generateJudgment(store);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 如果 judgment 还没存，存一下
  if (!judgment) {
    update('judgment', initialJudgment);
  }

  const j = judgment ?? initialJudgment;
  const [showDisagree, setShowDisagree] = useState(false);

  const agree = () => {
    // 预生成屏 4 和屏 5 的内容
    const sol = solution ?? generateSolution({ ...store, judgment: j });
    const tip = measureTip ?? generateMeasureTip({ ...store, judgment: j });
    update('solution', sol);
    update('measureTip', tip);
    update('screenNum', 4);
    navigate('/screen/4');
  };

  const disagree = (reason: string) => {
    const newJ = regenerateJudgment(store, reason);
    update('judgment', newJ);
    setShowDisagree(false);
    // 让 AI 真的重新诊断一次（否则左侧卡片还是上一次的判断）
    triggerAi(`我不同意这个判断。${reason ? '因为：' + reason : ''} 换个方向重新帮我诊断，别重复上一次的结论`);
  };

  return (
    <div className="space-y-6">
      <ScreenHeader
        title="我看出来了"
        subtitle="先看看对不对，不对就说不对——我听你的。"
        aiHint="AI 给的是方向判断，不是圣旨。认了就往下走，不认就告诉我哪不对。"
      />

      {/* 诊断内容只来自右侧 AI（同源），还没问就提示去右边 */}
      <AiStepCardView step={3} />

      <VisualSim />

      {!showDisagree ? (
        <div className="space-y-3 pt-4">
          <BigButton onClick={agree}>
            ✅ 就是这么回事
          </BigButton>
          <button
            type="button"
            onClick={() => setShowDisagree(true)}
            className="btn-pop w-full py-3 rounded-2xl text-[15px] font-medium text-gray-600 bg-white/80 hover:bg-mint-50 border border-gray-100 transition-all active:scale-[0.99] shadow-soft"
          >
            不对，换一个
          </button>
        </div>
      ) : (
        <div className="space-y-3 pt-4">
          <p className="text-sm text-gray-500 text-center">哪不对？告诉我原因</p>
          <div className="grid gap-2 grid-cols-2">
            {DISAGREE_REASONS.map(r => (
              <OptionButton key={r} label={r} onClick={() => disagree(r)} />
            ))}
          </div>
          <button
            type="button"
            onClick={() => setShowDisagree(false)}
            className="w-full text-center text-sm text-gray-400 hover:text-gray-600 py-2"
          >
            算了，还是认了
          </button>
        </div>
      )}

      <button
        type="button"
        onClick={() => navigate('/screen/2')}
        className="w-full text-center text-sm text-gray-500 hover:text-gray-700 py-2"
      >
        ← 回去改改
      </button>
    </div>
  );
}

