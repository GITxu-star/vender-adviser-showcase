﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿import { memo, useEffect, useRef, useState, useCallback } from 'react';
import { useStore } from '../store/useStore';
import { callLLM, type ProcessTrail } from '../data/llm';
import { extractCardPlan } from '../data/processor';
import { StepCardRenderer } from './StepCardRenderer';
import { ConfirmModal } from './ConfirmModal';
import type { ChatMessage } from '../data/schema';

// ============== 暴露给外部的自动触发 API ==============
let _externalTrigger: ((msg: string) => void) | null = null;
// 还没有 AiChat 实例挂载时（手机上抽屉刚点开、还没渲染完），先把消息存起来，挂载后补发
const _pendingTriggers: string[] = [];

/** 外部（比如 ScreenRoute）调用这个让 AI 自动说一句话 */
export function triggerAi(msg: string) {
  if (_externalTrigger) _externalTrigger(msg);
  else _pendingTriggers.push(msg);
}

interface AiChatProps {
  onClose?: () => void;
  compact?: boolean;
}

// 每步填完的「预期收获」
const STEP_HARVEST: Record<number, { title: string; harvest: string[] }> = {
  1: {
    title: '第 1 步 · 你的摊',
    harvest: ['知道你卖什么、在哪卖', 'AI 建立你的摊位画像'],
  },
  2: {
    title: '第 2 步 · 顾客反应',
    harvest: ['知道顾客走到你摊前一般做什么', 'AI 开始判断问题出在哪'],
  },
  3: {
    title: '第 3 步 · AI 诊断',
    harvest: ['AI 告诉你最该改什么', '给你多个方向的具体建议'],
  },
  4: {
    title: '第 4 步 · 今天就做',
    harvest: ['一个具体到动作的方案', '成本 + 退路都算好'],
  },
  5: {
    title: '第 5 步 · 测量',
    harvest: ['一句话能数出有没有用', '不是感觉，是数字'],
  },
  6: {
    title: '第 6 步 · 打卡',
    harvest: ['今天做完记一笔', '明天回来看结果'],
  },
  7: {
    title: '第 7 步 · 回来看',
    harvest: ['AI 根据效果决定下一步', '闭环成立 → 继续推 / 换方向'],
  },
};

export default function AiChat({ onClose, compact }: AiChatProps) {
  const chat = useStore(s => s.chat);
  const screenNum = useStore(s => s.screenNum);
  const update = useStore(s => s.update);

  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingStep, setLoadingStep] = useState(0); // 0=收到了,1=调画像,2=匹配方案,3=生成回复
  const [processTrail, setProcessTrail] = useState<ProcessTrail | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const STEP_LABELS = ['收到了 ✅', '正在调取你的摊位画像', '正在匹配案例库', '正在生成回复'];

  // ============ 统一发消息 ============
  const doSend = useCallback(async (rawText: string, auto = false) => {
    const text = (rawText ?? '').trim();
    if (!text || loading) return;
    const storeNow = useStore.getState();

    if (!auto) {
      const userMsg: ChatMessage = { id: 'u-' + Date.now(), role: 'user', text, ts: Date.now() };
      storeNow.update('chat', [...storeNow.chat, userMsg]);
      console.log('[AiChat] userMsg inserted:', { text, chatLen: storeNow.chat.length + 1 });
    }

    const loadingId = 'a-' + Date.now();
    setLoadingStep(0); setLoading(true); setProcessTrail(null); // 第 0 步：收到了

    let stepCard: any = null;

    try {
      setLoadingStep(2); // 第 2 步：匹配方案
      const afterUser = useStore.getState();
      const history = (auto ? afterUser.chat : [...afterUser.chat, { id: 'u', role: 'user' as const, text, ts: Date.now() }])
        .slice(-8).map(m => ({ role: m.role as 'user' | 'ai', text: m.text }));
      setLoadingStep(3); // 第 3 步：生成回复
      // 一次请求，同一份 LLM 结果：answer（右侧 AI 回复）+ stepCard（左侧 StepCard）
      // → 左右同步，不重复消耗 API
      const { answer, trail, stepCard: scFromLLM } = await callLLM(text, history, afterUser);
      stepCard = scFromLLM ?? null;
      setProcessTrail(trail ?? null); // 真实处理轨迹 → LoadingBubble 渲染

      // 一次性插入 StepCard + 完整回答 —— 打字动画由消息自己本地完成
      const s = useStore.getState();
      const batch: ChatMessage[] = [];
      if (stepCard) {
        // 把右侧 AI 这一步的卡片存进全局：左侧屏 3-6 直接显示它，保证左右同源
        const cardStep = Number(stepCard.step) || useStore.getState().screenNum || 1;
        useStore.getState().setAiCard(cardStep, stepCard);
        // 屏 4 的动作就是「真正要做的事」——同步进 solution，供屏 5/6/7 与后续对话回溯
        if (cardStep === 4) {
          const plan = extractCardPlan(stepCard);
          if (plan.length) {
            const prev = useStore.getState().solution;
            useStore.getState().update('solution', {
              doWhat: plan.join('\n'),
              costAndTime: prev?.costAndTime ?? '',
              revertPlan: prev?.revertPlan ?? '',
            });
          }
        }
        batch.push({ id: 'card-' + Date.now(), role: 'ai', text: '', ts: Date.now(), card: stepCard });
      }
      batch.push({ id: loadingId, role: 'ai', text: answer, ts: Date.now(), typing: true });
      s.update('chat', [...s.chat, ...batch]);
      // 左侧屏 3-6 直接引用这条回复，保证和右侧说的完全一致
      s.setAiAnswer(Number(stepCard?.step) || s.screenNum || 1, answer);
      setLoading(false);
    } catch {
      const errMsg: ChatMessage = {
        id: loadingId, role: 'ai', typing: false,
        text: '抱歉，刚才调用有点慢。你可以再说一遍。',
        ts: Date.now(),
        card: stepCard ?? undefined,
      };
      const s = useStore.getState();
      s.update('chat', [...s.chat, errMsg]);
    } finally {
      setLoading(false);
    }
  }, [loading]);

  useEffect(() => {
    _externalTrigger = (msg: string) => {
      if (useStore.getState().chat.length === 0) return;
      doSend(msg, true);
    };
    return () => { _externalTrigger = null; };
  }, [doSend]);

  useEffect(() => {
    const s = useStore.getState();
    if (s.chat.length === 0) {
      const step = s.screenNum || 1;
      const h = STEP_HARVEST[step] ?? STEP_HARVEST[1];
      const sellWhat = s.screen1.sellWhat;
      const whereSell = s.screen1.whereSell;

      const parts: string[] = [];
      parts.push(`🛒 地摊顾问在线！`);
      parts.push('');
      parts.push(`📌 ${h.title}`);
      parts.push(`📋 这一步填完你会得到：`);
      h.harvest.forEach(x => parts.push(`  ✅ ${x}`));
      parts.push('');
      if (sellWhat || whereSell) {
        parts.push(`我看到你在${whereSell || ''}卖${sellWhat || ''}，想聊什么直接说。`);
      } else {
        parts.push(`先填左边问卷，或者直接跟我聊也行。`);
      }

      s.update('chat', [{
        id: 'w-' + Date.now(), role: 'ai', text: parts.join('\n'), ts: Date.now(),
      }]);
    }
  }, [screenNum]);

  // 补发在 AiChat 挂载前就点下的「AI 诊断」（放在欢迎语之后，保证 chat 非空）
  useEffect(() => {
    if (!_pendingTriggers.length) return;
    const pending = _pendingTriggers.splice(0);
    pending.forEach(m => _externalTrigger?.(m));
  }, []);

  // 滚动到底部：只在新消息数量增加时滚（不在打字每帧滚！那是闪烁根因）
  const prevLenRef = useRef(chat.length);
  const rafRef = useRef<number | null>(null);
  useEffect(() => {
    const len = chat.length;
    if (len <= prevLenRef.current) return; // 不是新消息，跳过
    prevLenRef.current = len;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
      rafRef.current = null;
    });
  }, [chat.length]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(input.trim()); setInput(''); }
  };

  const [clearOpen, setClearOpen] = useState(false);
  const clear = () => setClearOpen(true);

  return (
    <div className="flex flex-col h-full bg-gradient-to-b from-white via-white/95 to-mint-50/30">
      {/* 顶栏 */}
      <div className={
        'flex items-center justify-between border-b border-mint-100/80 px-4 py-3 bg-white/90 backdrop-blur-md ' +
        (compact ? '' : 'sticky top-0')
      }>
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-2xl bg-gradient-to-br from-mint-400 to-mint-600 text-white flex items-center justify-center text-base shadow-soft">
            🛒
          </div>
          <div className="leading-tight">
            <div className="text-[14px] font-black text-gray-900 tracking-tight">地摊顾问</div>
            <div className="text-[11px] text-gray-400">
              已接入 · 第 <span className="text-mint-500 font-bold">{screenNum}</span> 步
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={clear}
            className="text-[12px] text-gray-400 hover:text-gray-600 px-2 py-1 rounded-xl hover:bg-mint-50 transition"
          >
            清空
          </button>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              className="w-8 h-8 rounded-xl hover:bg-mint-50 text-gray-500 flex items-center justify-center transition"
              aria-label="收起"
            >
              ✕
            </button>
          ) : (
            <div className="flex items-center gap-1 text-[11px] text-mint-400 px-2 font-semibold">
              ● 在线
            </div>
          )}
        </div>
      </div>

      {/* 消息列表 */}
      <div ref={listRef} className="flex-1 overflow-y-auto px-3 py-4 space-y-3">
        {chat.map(m => (
          <Message key={m.id} msg={m} />
        ))}
        {loading && <LoadingBubble step={loadingStep} labels={STEP_LABELS} trail={processTrail} />}
      </div>

      {/* 输入区 */}
      <div className="border-t border-mint-100/80 p-3 bg-white/90 backdrop-blur-sm">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={onKey}
            rows={1}
            placeholder={loading ? 'AI 正在想…' : '问一句，比如我该先改什么？'}
            disabled={loading}
            className="flex-1 resize-none rounded-2xl border border-gray-100 bg-white/80 backdrop-blur focus:border-mint-300 focus:ring-4 focus:ring-mint-100 focus:outline-none px-4 py-2.5 text-[14px] max-h-28 transition-all disabled:opacity-60 shadow-soft focus:shadow-card"
          />
          <button
            type="button"
            onClick={() => { doSend(input.trim()); setInput(''); }}
            disabled={!input.trim() || loading}
            style={{backgroundImage:'linear-gradient(to bottom right, #1f7a44, #176338)', color:'#fff'}}
            className="btn-pop w-10 h-10 rounded-2xl text-[16px] transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center shadow-pop"
            aria-label="发送"
          >
            →
          </button>
        </div>
      </div>

      {/* 清空对话确认弹窗 */}
      <ConfirmModal
        open={clearOpen}
        onClose={() => setClearOpen(false)}
        onConfirm={() => update('chat', [])}
        title="清空对话？"
        body="当前 AI 对话记录会被清空，但你的问卷数据和方案不会丢。"
        confirmText="清空"
        danger
      />
    </div>
  );
}

function LoadingBubble({ step, labels, trail }: { step: number; labels: string[]; trail: ProcessTrail | null }) {
  const total = labels.length;
  const currentLabel = labels[Math.min(step, total - 1)];
  // 伪进度条：基于 step + 每 300ms 自动涨 2%（拉满 90% 等后端返回）
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    const target = Math.min(90, Math.round(((step + 1) / total) * 100));
    setProgress(target);
    const timer = setInterval(() => {
      setProgress((p) => (p < 90 ? Math.min(90, p + 2) : p));
    }, 300);
    return () => clearInterval(timer);
  }, [step, total]);

  // ===== 有 trail → 渲染真实处理过程卡片 =====
  if (trail) {
    const {
      category_kw, category_group, filled_fields,
      kg_firing_rules, kg_valid, kg_invalid,
      similar_case_hit, similar_case_title, rag_chunks,
      candidates_count, top_direction, top_score,
    } = trail;

    const checked = () => (
      <span style={{ color: '#1f7a44', marginRight: 4 }}>✅</span>
    );

    return (
      <div className="flex gap-2 justify-start">
        <Avatar ai />
        <div
          style={{
            background: 'linear-gradient(135deg, #f0faf3, #e2f3e8)',
            borderRadius: '16px 16px 16px 4px',
            padding: '12px 16px',
            minWidth: '240px',
            border: '1px solid #d4ecd9',
            boxShadow: '0 2px 8px rgba(31,122,68,0.06)',
            fontSize: '12.5px',
            lineHeight: 1.7,
          }}
        >
          <div style={{ fontSize: '13px', color: '#1f7a44', fontWeight: 600, marginBottom: '8px' }}>
            🔍 我是怎么判断的
          </div>

          {/* ① 品类识别 */}
          <div>
            {checked()}
            识别品类：
            <strong style={{ color: '#1f7a44' }}>{category_kw || '未填'}</strong>
            {category_group && <span style={{ color: '#7fa58c', marginLeft: 4 }}>（{category_group}）</span>}
          </div>

          {/* ② 规则引擎命中 */}
          {kg_firing_rules.length > 0 && (
            <div>
              {checked()}
              规则引擎命中 <strong>{kg_firing_rules.length}</strong> 条
              {kg_valid.length > 0 && (
                <span style={{ color: '#1f7a44', marginLeft: 6 }}>
                  → 有效：{kg_valid.slice(0, 4).join('、')}
                  {kg_valid.length > 4 ? '…' : ''}
                </span>
              )}
              {kg_invalid.length > 0 && (
                <span style={{ color: '#d95f5f', marginLeft: 6 }}>
                  禁：{kg_invalid.join('、')}
                </span>
              )}
            </div>
          )}

          {/* ③ 案例库 */}
          <div>
            {checked()}
            案例库：
            {similar_case_hit
              ? `命中相似摊主（${similar_case_title || '标题未返回'}）`
              : filled_fields < 2
                ? `跳过（只填了 ${filled_fields} 项，避免照搬案例）`
                : '无足够相似案例'}
          </div>

          {/* ④ RAG + 候选方案 */}
          {candidates_count > 0 && (
            <>
              <div>{checked()}RAG 检索到 <strong>{rag_chunks}</strong> 条知识</div>
              <div>
                {checked()}
                生成 <strong>{candidates_count}</strong> 个候选方案
                {top_direction && (
                  <span style={{ marginLeft: 6 }}>
                    → Top: <strong style={{ color: '#1f7a44' }}>{top_direction}</strong>
                    <span style={{ color: '#7fa58c', marginLeft: 4 }}>
                      （综合分 {top_score.toFixed(1)}）
                    </span>
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  // ===== 无 trail → 显示动画进度条（拉满 90% 等后端返回 trail =====
  return (
    <div className="flex gap-2 justify-start">
      <Avatar ai />
      <div
        style={{
          background: 'linear-gradient(135deg, #f0faf3, #e2f3e8)',
          borderRadius: '16px 16px 16px 4px',
          padding: '10px 16px',
          minWidth: '220px',
          border: '1px solid #d4ecd9',
          boxShadow: '0 2px 8px rgba(31,122,68,0.06)',
        }}
      >
        <div style={{ fontSize: '13px', color: '#1f7a44', fontWeight: 500, marginBottom: '6px' }}>
          {currentLabel}
        </div>
        {/* 进度条（连续） */}
        <div
          style={{
            width: '100%',
            height: '6px',
            background: '#d4ecd9',
            borderRadius: '9999px',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${progress}%`,
              height: '100%',
              background: 'linear-gradient(90deg, #1f7a44, #3aa56a)',
              borderRadius: '9999px',
              transition: 'width 0.35s ease-out',
            }}
          />
        </div>
        <div style={{ fontSize: '10.5px', color: '#7fa58c', marginTop: '4px', textAlign: 'right' }}>
          {progress < 90 ? `${progress}%` : '快好了…'}
        </div>
      </div>
    </div>
  );
}

function Avatar({ ai }: { ai?: boolean }) {
  return (
    <div className={
      'w-7 h-7 rounded-2xl flex items-center justify-center text-[12px] font-black flex-shrink-0 mt-1 shadow-soft ' +
      (ai
        ? 'bg-gradient-to-br from-mint-400 to-mint-600 text-white'
        : 'bg-gradient-to-br from-gray-300 to-gray-400 text-white')
    }>
      {ai ? 'AI' : '我'}
    </div>
  );
}

// ============ 结构化消息渲染 ============

const Message = memo(function Message({ msg }: { msg: ChatMessage & { typing?: boolean } }) {
  // 有 card → 只渲染卡片
  if (msg.card) {
    return (
      <div className="flex gap-2 justify-start">
        <Avatar ai />
        <div className="flex-1 min-w-0">
          <StepCardRenderer card={msg.card} />
        </div>
      </div>
    );
  }

  const isAi = msg.role === 'ai';

  if (!isAi) {
    const displayText = (msg.text ?? '').trim() || '(空消息)';
    if (!msg.text) console.warn('[AiChat] user bubble has empty text:', msg);
    return (
      <div className="flex gap-2 justify-end">
        <div
          className="max-w-[82%] rounded-2xl rounded-tr-sm px-4 py-2.5 text-[13.5px] leading-relaxed whitespace-pre-line shadow-pop"
          style={{
            background: 'linear-gradient(135deg, #1f7a44, #176338)',
            color: '#ffffff',
            WebkitTextStroke: '0px',
          }}
        >
          {displayText}
        </div>
        <Avatar />
      </div>
    );
  }

  return (
    <div className="flex gap-2 justify-start">
      <Avatar ai />
      <div className="flex-1 min-w-0">
        <TypedText full={msg.text} typing={msg.typing} msgId={msg.id} />
      </div>
    </div>
  );
});

/**
 * 打字展示：布局在第 0 帧就按完整文本定型，之后只裁剪可见字符。
 * 1) 结构由 full 决定，打字过程中绝不会切换渲染分支（这是之前一闪一闪的根因）
 * 2) 用一份透明的完整文本撑住最终高度，逐字增长不再引起任何布局变化
 * 3) 动画跑在组件本地 rAF，全程不写全局 store / localStorage
 */
const TypedText = memo(function TypedText({
  full, typing, msgId,
}: { full: string; typing?: boolean; msgId: string }) {
  const [n, setN] = useState(typing ? 0 : full.length);
  const doneRef = useRef(false);

  useEffect(() => {
    if (!typing) {
      setN(full.length);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const speed = Math.max(90, full.length / 4); // 字/秒，长回答约 4 秒打完

    const tick = (t: number) => {
      const chars = Math.min(full.length, Math.floor(((t - start) / 1000) * speed));
      setN(chars);
      if (chars < full.length) {
        raf = requestAnimationFrame(tick);
      } else if (!doneRef.current) {
        doneRef.current = true;
        // 只写一次：标记这条消息打完
        const s = useStore.getState();
        s.update('chat', s.chat.map(m => (m.id === msgId ? { ...m, typing: false } : m)));
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [full, typing, msgId]);

  const visible = full.slice(0, n);
  const revealing = n < full.length;

  return (
    <div className="relative">
      {/* 高度占位：完整文本，不可见，保证整个打字过程零布局抖动 */}
      <div className="invisible select-none" aria-hidden>
        <StructuredText visible={full} full={full} revealing={false} />
      </div>
      {/* 可见层：只画已打出的字符 */}
      <div className="absolute inset-0 overflow-visible">
        <StructuredText visible={visible} full={full} revealing={revealing} />
      </div>
    </div>
  );
});

const StructuredText = memo(function StructuredText({
  visible, full, revealing,
}: { visible: string; full: string; revealing: boolean }) {
  const cursor = revealing
    ? <span className="inline-block w-1.5 h-4 ml-0.5 bg-mint-500 animate-pulse align-middle rounded-full" />
    : null;

  // 分支永远按「完整文本」判定 —— 打字中途不会换结构
  const fullLines = full.split('\n');
  const hasCards = fullLines.some(l => l.startsWith('📦'));
  const hasStructured = fullLines.some(l => l.startsWith('★') || l.startsWith('🏆'));

  const lines = visible.split('\n');

  if (hasCards) {
    const blocks: Array<{ title?: string; body: string }> = [];
    let current: { title?: string; body: string[] } = { body: [] };

    for (const line of lines) {
      if (line.startsWith('📦')) {
        if (current.title || current.body.length > 0) {
          blocks.push({ title: current.title, body: current.body.join('\n') });
        }
        current = { title: line.replace('📦', '').trim(), body: [] };
      } else {
        current.body.push(line);
      }
    }
    if (current.title || current.body.length > 0) {
      blocks.push({ title: current.title, body: current.body.join('\n') });
    }
    const last = blocks.length - 1;

    return (
      <div className="max-w-[92%] space-y-2">
        {blocks.map((b, i) => b.title ? (
          <Card key={i} title={b.title}>
            <RichBody text={b.body} />
            {i === last ? cursor : null}
          </Card>
        ) : (
          <div key={i} className="rounded-2xl rounded-tl-sm bg-gradient-to-br from-mint-50 to-white border border-mint-100 text-gray-800 px-4 py-2.5 text-[13.5px] leading-relaxed shadow-soft">
            <RichBody text={b.body} />
            {i === last ? cursor : null}
          </div>
        ))}
      </div>
    );
  }

  if (hasStructured) {
    return (
      <div className="max-w-[82%] rounded-2xl rounded-tl-sm bg-gradient-to-br from-mint-50 to-white border border-mint-100 text-gray-800 px-4 py-2.5 text-[13.5px] leading-relaxed shadow-soft">
        <RichBody text={visible} />
        {cursor}
      </div>
    );
  }

  return (
    <div className="max-w-[82%] rounded-2xl rounded-tl-sm bg-gradient-to-br from-mint-50 to-white border border-mint-100 text-gray-800 px-4 py-2.5 text-[13.5px] leading-relaxed whitespace-pre-line shadow-soft">
      {visible}
      {cursor}
    </div>
  );
});

const Card = memo(function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-mint-100 bg-white shadow-soft overflow-hidden">
      <div className="px-4 py-2 bg-gradient-to-r from-mint-50 to-white border-b border-mint-100">
        <span className="text-[11px] font-black tracking-[0.15em] text-mint-500 uppercase">{title}</span>
      </div>
      <div className="px-4 py-2.5 text-[13.5px] text-gray-800 leading-relaxed">{children}</div>
    </div>
  );
});

const RichBody = memo(function RichBody({ text }: { text: string }) {
  const lines = text.split('\n').filter(l => l.trim().length > 0);
  return (
    <div className="space-y-1.5">
      {lines.map((line, i) => {
        if (line === '---') {
          return <div key={i} className="border-t border-mint-100 my-1.5" />;
        }
        if (line.startsWith('★')) {
          return (
            <div key={i} className="flex gap-2">
              <span className="text-mint-500 flex-shrink-0 font-bold">✓</span>
              <span>{line.slice(1).trim()}</span>
            </div>
          );
        }
        if (line.startsWith('🏆')) {
          const match = line.slice(1).match(/\s*([^:：]+)[:：]\s*(\d+(?:\.\d+)?)/);
          if (match) {
            const name = match[1].trim();
            const score = Math.min(10, Math.max(0, parseFloat(match[2])));
            return <ScoreBar key={i} name={name} score={score} />;
          }
        }
        return <div key={i}>{line}</div>;
      })}
    </div>
  );
});

function ScoreBar({ name, score }: { name: string; score: number }) {
  const pct = (score / 10) * 100;
  const color =
    score >= 8 ? 'bg-gradient-to-r from-mint-500 to-mint-400' :
    score >= 5 ? 'bg-gradient-to-r from-mint-300 to-mint-200' :
    'bg-gray-200';
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span className="text-[12px] text-gray-500 w-14 flex-shrink-0 font-medium">{name}</span>
      <div className="flex-1 h-2 bg-mint-50 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full transition-all duration-500`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[11px] font-bold text-gray-600 w-6 text-right">{score.toFixed(1)}</span>
    </div>
  );
}

