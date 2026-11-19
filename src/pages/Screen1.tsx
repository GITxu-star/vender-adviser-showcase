﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { OptionButton } from '../components/OptionButton';
import { BigButton } from '../components/BigButton';
import { ScreenHeader } from '../components/ScreenHeader';
import { useStore } from '../store/useStore';
import {
  WHERE_SELL_OPTIONS, DAILY_QTY_OPTIONS, STALL_FIXED_OPTIONS,
  DAILY_HOURS_OPTIONS, STALL_TYPE_OPTIONS,
  TIME_SLOT_OPTIONS, VENUE_OPTIONS, COMPETITORS_OPTIONS,
  SPOT_TYPE_OPTIONS, MY_DIFFICULTY_OPTIONS,
} from '../data/schema';

export default function Screen1() {
  const navigate = useNavigate();
  const s1 = useStore(s => s.screen1);
  const update = useStore(s => s.update);
  const [open, setOpen] = useState(false);

  // 「在哪卖」支持多选，字符串用「、」拼接，后端不用改
  const whereList = (s1.whereSell || '').split('、').map(t => t.trim()).filter(Boolean);
  const isOtherOn = whereList.some(t => t.startsWith('其他'));
  const [otherInput, setOtherInput] = useState(
    (whereList.find(t => t.startsWith('其他')) || '').replace(/^其他[：:]?/, '')
  );

  const toggleWhere = (o: string) => {
    let list = [...whereList];
    if (o === '其他') {
      if (isOtherOn) {
        list = list.filter(t => !t.startsWith('其他'));
        setOtherInput('');
      } else {
        list = [...list, '其他'];
      }
    } else {
      list = list.includes(o) ? list.filter(t => t !== o) : [...list, o];
    }
    update('screen1', { ...s1, whereSell: list.join('、') });
  };

  const setOtherWhere = (v: string) => {
    setOtherInput(v);
    const rest = whereList.filter(t => !t.startsWith('其他'));
    const entry = v.trim() ? `其他：${v.trim()}` : '其他';
    update('screen1', { ...s1, whereSell: [...rest, entry].join('、') });
  };

  // 「点位类型」「当前困境」选到"其他"时也允许自己填
  const isSpotOther = (s1.spotType || '').startsWith('其他');
  const isDiffOther = (s1.myDifficulty || '').startsWith('其他');
  const [spotInput, setSpotInput] = useState((s1.spotType || '').replace(/^其他[：:]?/, ''));
  const [diffInput, setDiffInput] = useState((s1.myDifficulty || '').replace(/^其他[：:]?/, ''));

  const setSpot = (o: string) => {
    if (o === '其他' && isSpotOther) {
      setSpotInput('');
      update('screen1', { ...s1, spotType: '' });
      return;
    }
    update('screen1', { ...s1, spotType: o });
  };

  const setSpotOther = (v: string) => {
    setSpotInput(v);
    update('screen1', { ...s1, spotType: v.trim() ? `其他：${v.trim()}` : '其他' });
  };

  const setDifficulty = (o: string) => {
    if (o === '其他' && isDiffOther) {
      setDiffInput('');
      update('screen1', { ...s1, myDifficulty: '' });
      return;
    }
    update('screen1', { ...s1, myDifficulty: o });
  };

  const setDiffOther = (v: string) => {
    setDiffInput(v);
    update('screen1', { ...s1, myDifficulty: v.trim() ? `其他：${v.trim()}` : '其他' });
  };

  // 价格拆成「最低 / 最高」两个字段；price 只是拼给后端的兼容值
  const legacyNums = (s1.price || '').match(/\d+(?:\.\d+)?/g) || [];
  // 用 ?? 而不是 ||：空字符串代表「用户主动清空」，不能再从旧 price 反填，否则清不掉
  const priceMinVal = s1.priceMin ?? legacyNums[0] ?? '';
  const priceMaxVal = s1.priceMax ?? legacyNums[1] ?? legacyNums[0] ?? '';

  const setPriceRange = (min: string, max: string) => {
    const lo = min.trim(), hi = max.trim();
    const price = lo && hi ? (lo === hi ? lo : `${lo}-${hi}`) : (lo || hi);
    update('screen1', { ...s1, priceMin: min, priceMax: max, price });
  };

  const canNext = s1.sellWhat.trim() && s1.whereSell && s1.dailyQty;

  // 折叠区如果有任何一个已选 → 默认展开
  const hasAnyInFold = s1.stallFixed || s1.dailyHours || s1.stallType ||
    s1.timeSlot || s1.weather || s1.spotType || s1.myDifficulty;

  const next = () => {
    update('screenNum', 2);
    navigate('/screen/2');
  };

  return (
    <div className="space-y-7">
      <ScreenHeader
        title="你现在的情况"
        subtitle="先让我认识认识你的摊——不用填太多，填你有把握的。"
        aiHint="卖什么、在哪卖是最关键的两个信号，其他填个大概就行。"
      />

      {/* ========== 必填区（前 5 个） ========== */}
      <Field label="你卖什么" required>
        <input
          type="text"
          value={s1.sellWhat}
          onChange={e => update('screen1', { ...s1, sellWhat: e.target.value })}
          placeholder="比如：烤串 / 炒面 / 手机贴膜"
          className="w-full px-4 py-3 rounded-2xl border border-gray-100 bg-white/80 backdrop-blur focus:border-mint-300 focus:ring-4 focus:ring-mint-100 focus:outline-none text-[15px] transition-all shadow-soft focus:shadow-card"
        />
      </Field>

      <Field label="在哪卖（可多选）">
        <div className="grid gap-2 grid-cols-2 sm:grid-cols-3">
          {WHERE_SELL_OPTIONS.map(o => (
            <OptionButton key={o} label={o}
              selected={o === '其他' ? isOtherOn : whereList.includes(o)}
              onClick={() => toggleWhere(o)} />
          ))}
        </div>
        {isOtherOn && (
          <input
            type="text"
            value={otherInput}
            onChange={e => setOtherWhere(e.target.value)}
            placeholder="自己填地点，比如：老菜场后门 / 工地门口"
            className="mt-2 w-full px-4 py-3 rounded-2xl border border-mint-200 bg-white/90 focus:border-mint-300 focus:ring-4 focus:ring-mint-100 focus:outline-none text-[14px] transition-all"
          />
        )}
        <p className="text-[11.5px] text-gray-400 mt-1.5">可以选多个，比如白天早市、晚上夜市。</p>
      </Field>

      <Field label="卖多少钱（元）">
        <div className="flex items-center gap-2">
          <input
            type="number" inputMode="decimal"
            value={priceMinVal}
            onChange={e => setPriceRange(e.target.value, priceMaxVal)}
            placeholder="最低 8"
            className="w-full px-4 py-3 rounded-2xl border border-gray-100 bg-white/80 backdrop-blur focus:border-mint-300 focus:ring-4 focus:ring-mint-100 focus:outline-none text-[15px] transition-all shadow-soft focus:shadow-card"
          />
          <span className="text-gray-400 text-[15px] flex-shrink-0">~</span>
          <input
            type="number" inputMode="decimal"
            value={priceMaxVal}
            onChange={e => setPriceRange(priceMinVal, e.target.value)}
            placeholder="最高 15"
            className="w-full px-4 py-3 rounded-2xl border border-gray-100 bg-white/80 backdrop-blur focus:border-mint-300 focus:ring-4 focus:ring-mint-100 focus:outline-none text-[15px] transition-all shadow-soft focus:shadow-card"
          />
        </div>
        <p className="text-[11.5px] text-gray-400 mt-1.5">只卖一个价就两格填一样；不同款不同价，填最低和最高。</p>
      </Field>

      <Field label="一天大概卖多少份">
        <div className="grid gap-2 grid-cols-2">
          {DAILY_QTY_OPTIONS.map(o => (
            <OptionButton key={o} label={o} selected={s1.dailyQty === o}
              onClick={() => update('screen1', { ...s1, dailyQty: o })} />
          ))}
        </div>
      </Field>

      <Field label="周边竞争怎么样">
        <div className="grid gap-2 grid-cols-1 sm:grid-cols-3">
          {COMPETITORS_OPTIONS.map(o => (
            <OptionButton key={o} label={o} selected={s1.competitors === o}
              onClick={() => update('screen1', { ...s1, competitors: o })} />
          ))}
        </div>
      </Field>

      {/* ========== 可填区（默认折叠） ========== */}
      <div className="rounded-2xl border border-mint-100 bg-gradient-to-br from-mint-50/40 to-white overflow-hidden shadow-soft">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="w-full px-5 py-3 flex items-center justify-between text-left hover:bg-mint-50/60 transition"
        >
          <div className="flex items-center gap-2.5">
            <span className="w-6 h-6 rounded-full bg-gradient-to-br from-mint-100 to-mint-200 flex items-center justify-center text-[11px] font-bold text-mint-600">
              选填
            </span>
            <div>
              <div className="text-[13.5px] font-bold text-gray-800">
                摊位情形 / 时段 / 困境 —— 选一个最接近的就行
              </div>
              <div className="text-[11.5px] text-gray-500 mt-0.5">
                填了 AI 诊断更准，不填也能走
                {hasAnyInFold && <span className="text-mint-500 ml-2">（你已经填了一些，继续补完也可以）</span>}
              </div>
            </div>
          </div>
          <span className={`text-mint-500 transition-transform duration-200 text-lg ${open ? 'rotate-180' : ''}`}>
            ▾
          </span>
        </button>

        {open && (
          <div className="px-5 pb-5 space-y-5 border-t border-mint-100 bg-white/70">
            <Field label="摊位固定吗">
              <div className="grid gap-2 grid-cols-2">
                {STALL_FIXED_OPTIONS.map(o => (
                  <OptionButton key={o} label={o} selected={s1.stallFixed === o}
                    onClick={() => update('screen1', { ...s1, stallFixed: o })} />
                ))}
              </div>
            </Field>

            <Field label="每天摆多久">
              <div className="grid gap-2 grid-cols-2">
                {DAILY_HOURS_OPTIONS.map(o => (
                  <OptionButton key={o} label={o} selected={s1.dailyHours === o}
                    onClick={() => update('screen1', { ...s1, dailyHours: o })} />
                ))}
              </div>
            </Field>

            <Field label="你的摊属于哪种情形">
              <div className="grid gap-2 grid-cols-1 sm:grid-cols-2">
                {STALL_TYPE_OPTIONS.map(o => (
                  <OptionButton key={o} label={o} selected={s1.stallType === o}
                    onClick={() => update('screen1', { ...s1, stallType: o })} />
                ))}
              </div>
            </Field>

            <Field label="主要在哪个时段摆">
              <div className="grid gap-2 grid-cols-2 sm:grid-cols-4">
                {TIME_SLOT_OPTIONS.map(o => (
                  <OptionButton key={o} label={o} selected={s1.timeSlot === o}
                    onClick={() => update('screen1', { ...s1, timeSlot: o })} />
                ))}
              </div>
            </Field>

            <Field label="场地情况（天气影响）">
              <div className="grid gap-2 grid-cols-2 sm:grid-cols-3">
                {VENUE_OPTIONS.map(o => (
                  <OptionButton key={o} label={o} selected={s1.weather === o}
                    onClick={() => update('screen1', { ...s1, weather: o })} />
                ))}
              </div>
            </Field>

            <Field label="你的点位属于哪种">
              <div className="grid gap-2 grid-cols-1 sm:grid-cols-2">
                {SPOT_TYPE_OPTIONS.map(o => (
                  <OptionButton key={o} label={o}
                    selected={o === '其他' ? isSpotOther : s1.spotType === o}
                    onClick={() => setSpot(o)} />
                ))}
              </div>
              {isSpotOther && (
                <input
                  type="text"
                  value={spotInput}
                  onChange={e => setSpotOther(e.target.value)}
                  placeholder="自己填点位，比如：菜市场出口 / 学校后门"
                  className="mt-2 w-full px-4 py-3 rounded-2xl border border-mint-200 bg-white/90 focus:border-mint-300 focus:ring-4 focus:ring-mint-100 focus:outline-none text-[14px] transition-all"
                />
              )}
            </Field>

            <Field label="你现在最大的困境是什么">
              <div className="grid gap-2 grid-cols-1 sm:grid-cols-2">
                {MY_DIFFICULTY_OPTIONS.map(o => (
                  <OptionButton key={o} label={o}
                    selected={o === '其他' ? isDiffOther : s1.myDifficulty === o}
                    onClick={() => setDifficulty(o)} />
                ))}
              </div>
              {isDiffOther && (
                <input
                  type="text"
                  value={diffInput}
                  onChange={e => setDiffOther(e.target.value)}
                  placeholder="自己填困境，比如：老顾客被隔壁新摊抢走了"
                  className="mt-2 w-full px-4 py-3 rounded-2xl border border-mint-200 bg-white/90 focus:border-mint-300 focus:ring-4 focus:ring-mint-100 focus:outline-none text-[14px] transition-all"
                />
              )}
            </Field>
          </div>
        )}
      </div>

      <div className="pt-4">
        <BigButton onClick={next} disabled={!canNext}>
          下一步 →
        </BigButton>
        {!canNext && (
          <p className="text-xs text-gray-400 text-center mt-2">
            「卖什么」「在哪卖」「卖多少」这几个得先填上
          </p>
        )}
      </div>
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[13.5px] font-semibold text-gray-700 mb-2">
        {label}
        {required && <span className="text-mint-500 ml-1">*</span>}
      </label>
      {children}
    </div>
  );
}
