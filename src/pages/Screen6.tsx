﻿﻿﻿﻿﻿﻿﻿﻿﻿import { useNavigate } from 'react-router-dom';
import { BigButton } from '../components/BigButton';
import { ScreenHeader } from '../components/ScreenHeader';
import AiStepCardView from '../components/AiStepCardView';
import { useStore } from '../store/useStore';

export default function Screen6() {
  const navigate = useNavigate();
  const update = useStore(s => s.update);

  const markDone = () => {
    update('done', true);
    update('screenNum', 7);
    navigate('/screen/7');
  };

  return (
    <div className="space-y-6">
      <ScreenHeader
        title="记一笔"
        subtitle="把你今晚要做的事存着——做完点一下，明天回来看。"
        aiHint="这个按钮相当于你的打卡器，做完一定要点，明天才能闭环。"
      />

      {/* 执行清单只来自右侧 AI（同源），还没问就提示去右边 */}
      <AiStepCardView step={6} />

      {/* 打卡按钮区 */}
      <div className="bg-gradient-to-br from-mint-50 to-white border border-mint-100 rounded-2xl p-5 text-center shadow-soft">
        <div className="text-2xl mb-2">⏰</div>
        <p className="text-[14px] text-mint-600 font-semibold">做完一定要点下面这个按钮</p>
        <p className="text-[11.5px] text-gray-500 mt-1">明天回来看效果的时候要用</p>
      </div>

      <div className="space-y-3 pt-4">
        <BigButton onClick={markDone}>
          ✅ 我做完了
        </BigButton>
      </div>
    </div>
  );
}
