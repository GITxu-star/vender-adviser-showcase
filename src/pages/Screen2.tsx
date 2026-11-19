﻿﻿﻿﻿﻿﻿﻿import { useNavigate } from 'react-router-dom';
import { OptionButton } from '../components/OptionButton';
import { BigButton } from '../components/BigButton';
import { ScreenHeader } from '../components/ScreenHeader';
import { useStore } from '../store/useStore';
import {
  CUSTOMER_ACTION_OPTIONS, CUSTOMER_LOOK_AT_OPTIONS, SELF_FEEL_WRONG_OPTIONS,
} from '../data/schema';

export default function Screen2() {
  const navigate = useNavigate();
  const s2 = useStore(s => s.screen2);
  const update = useStore(s => s.update);

  const canNext = s2.customerAction;

  const next = () => {
    update('screenNum', 3);
    navigate('/screen/3');
  };

  const toggleMulti = (key: 'customerLookAt' | 'selfFeelWrong', value: string) => {
    const arr = s2[key];
    const next = arr.includes(value)
      ? arr.filter(v => v !== value)
      : [...arr, value];
    update('screen2', { ...s2, [key]: next });
  };

  return (
    <div className="space-y-8">
      <ScreenHeader
        title="顾客是什么反应"
        subtitle="说你能看见的事就行——不用猜顾客心里怎么想。"
        aiHint="「看一眼就走」和「停下来看了」差别很大，选最常见的那个。"
      />

      <Question
        label="顾客走到你摊前，一般是……"
        hint="单选，选最常见的那个"
      >
        <div className="grid gap-2">
          {CUSTOMER_ACTION_OPTIONS.map(o => (
            <OptionButton key={o} label={o} selected={s2.customerAction === o}
              onClick={() => update('screen2', { ...s2, customerAction: o })} />
          ))}
        </div>
      </Question>

      <Question
        label="顾客先看什么"
        hint="多选，勾选 1-3 个"
      >
        <div className="grid gap-2 grid-cols-2 sm:grid-cols-3">
          {CUSTOMER_LOOK_AT_OPTIONS.map(o => (
            <OptionButton key={o} label={o} selected={s2.customerLookAt.includes(o)}
              multi
              onClick={() => toggleMulti('customerLookAt', o)} />
          ))}
        </div>
      </Question>

      <Question
        label="你自己觉得哪不对"
        hint="多选，有就勾，没有就留空"
      >
        <div className="grid gap-2 grid-cols-1 sm:grid-cols-2">
          {SELF_FEEL_WRONG_OPTIONS.map(o => (
            <OptionButton key={o} label={o} selected={s2.selfFeelWrong.includes(o)}
              multi
              onClick={() => toggleMulti('selfFeelWrong', o)} />
          ))}
        </div>
      </Question>

      <div className="pt-4 space-y-3">
        <BigButton onClick={next} disabled={!canNext}>
          让 AI 看看 →
        </BigButton>
        <button
          type="button"
          onClick={() => navigate('/screen/1')}
          className="w-full text-center text-sm text-gray-500 hover:text-gray-700 py-2"
        >
          ← 回去改改
        </button>
      </div>
    </div>
  );
}

function Question({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2">
        <div className="text-[14px] font-semibold text-gray-800">{label}</div>
        {hint && <div className="text-[11.5px] text-gray-400 mt-0.5">{hint}</div>}
      </div>
      {children}
    </div>
  );
}
