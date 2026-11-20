﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿import { useNavigate } from 'react-router-dom';
import { BigButton } from '../components/BigButton';
import { ScreenHeader } from '../components/ScreenHeader';
import CustomerFlow3D from '../components/CustomerFlow3D';
import AiStepCardView from '../components/AiStepCardView';
import { triggerAi } from '../components/AiChat';
import { useStore } from '../store/useStore';

export default function Screen4() {
  const navigate = useNavigate();
  const solution = useStore(s => s.solution);
  const update = useStore(s => s.update);
  const s = solution;

  if (!s) {
    navigate('/screen/3');
    return null;
  }

  const next = () => {
    update('lastAction', s.doWhat.slice(0, 80));
    update('screenNum', 5);
    navigate('/screen/5');
  };

  const simplify = () => {
    // 真正让 AI 重出一版更简单的方案（右侧回答 + 左侧卡片同步刷新）
    // 先把步骤锁回第 4 步：从第 5 步返回时 screenNum 还是 5，AI 会误答成第 5 步
    update('screenNum', 4);
    triggerAi('只改第 4 步的方案：太难了，砍到今晚 10 分钟就能做完的一步，其他都先别管，成本尽量 0。不要进入第 5 步，也不要给测量指标。');
  };

  return (
    <div className="space-y-6">
      <ScreenHeader
        title="今晚就能做的一版"
        subtitle="挑一件，今晚就动手——别多做，就做一件。"
        aiHint="方案越简单越好，能 15 分钟搞定的就别搞 2 小时的。"
      />

      {/* 这一步的内容只来自右侧 AI（同源），还没问就提示去右边 */}
      <AiStepCardView step={4} />

      {/* 顾客动线演示（3D 版） */}
      <CustomerFlow3D />


      <div className="space-y-3 pt-4">
        <BigButton onClick={next}>
          今晚就做这个 →
        </BigButton>
        <button
          type="button"
          onClick={simplify}
          style={{backgroundImage:'linear-gradient(to bottom right, #1f7a44, #176338)', color:'#fff', borderColor:'#176338'}}
          className="btn-pop w-full py-3 rounded-2xl text-[15px] font-bold border shadow-pop transition-all active:scale-[0.99]"
        >
          太难了，砍简单点
        </button>
      </div>

      <button
        type="button"
        onClick={() => navigate('/screen/3')}
        className="w-full text-center text-sm text-gray-400 hover:text-gray-600 py-2"
      >
        ← 回去换个判断
      </button>
    </div>
  );
}

