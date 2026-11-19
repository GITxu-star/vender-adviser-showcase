﻿﻿﻿﻿﻿﻿﻿﻿﻿import { useNavigate } from 'react-router-dom';
import { BigButton } from '../components/BigButton';
import { ScreenHeader } from '../components/ScreenHeader';
import AiStepCardView from '../components/AiStepCardView';
import { useStore } from '../store/useStore';

export default function Screen5() {
  const navigate = useNavigate();
  const update = useStore(s => s.update);

  const done = () => {
    update('screenNum', 6);
    navigate('/screen/6');
  };

  return (
    <div className="space-y-6">
      <ScreenHeader
        title="明天怎么看有没有用"
        subtitle="给你一句能数得出来的话——不是感觉，是数字。"
        aiHint="别写「看看感觉怎么样」，要写「10 个路过的人里至少 4 个停」。"
      />

      {/* 测量指标只来自右侧 AI（同源），还没问就提示去右边 */}
      <AiStepCardView step={5} />

      <BigButton onClick={done}>
        好，我去准备了 →
      </BigButton>

      <button
        type="button"
        onClick={() => navigate('/screen/4')}
        className="w-full text-center text-sm text-gray-400 hover:text-gray-600 py-2"
      >
        ← 回去改改方案
      </button>
    </div>
  );
}
