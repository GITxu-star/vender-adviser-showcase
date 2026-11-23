import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { BigButton } from '../components/BigButton';
import { useStore } from '../store/useStore';

const EXAMPLE = {
  screen1: {
    sellWhat: '烤串', whereSell: '夜市', priceMin: '5', priceMax: '5', price: '5', dailyQty: '20-50',
    stallFixed: '固定', dailyHours: '4-8 小时', stallType: '1. 商品放地上，什么也不摆',
    timeSlot: '夜市', weather: '露天', competitors: '竞争激烈',
    spotType: '热门街区（摊多但流量也大）', myDifficulty: '摊位太多，分到的顾客越来越少',
  },
  screen2: {
    customerAction: '看一眼就走',
    customerLookAt: ['招牌', '没看清'],
    selfFeelWrong: ['看不清卖什么', '旁边比我便宜'],
  },
};

type InfoKey = 'diagnose' | 'plan' | 'loop';

/** 首页底部三个说明按钮的显示开关：暂时隐藏，改回 true 即恢复 */
const SHOW_HOME_FEATURE_CARDS = false;

const INFO: Record<InfoKey, {
  emoji: string; label: string; title: string; intro: string;
  blocks: { h: string; items: string[] }[];
}> = {
  diagnose: {
    emoji: '🔍', label: 'AI 诊断', title: 'AI 是怎么诊断的',
    intro: '不是凭感觉给结论，每一步都有依据：先看清你的摊，再找相似案例，最后用规则判断根因。',
    blocks: [
      {
        h: '诊断流程',
        items: [
          '① 提取摊位特征：品类、点位、时段、天气、竞争强度、你的困境',
          '② 检索相似案例：把你的问题换个问法展开 4 次，在案例库里做向量检索',
          '③ 多路结果融合排序（RRF），越像的案例排得越前',
          '④ 规则图谱判根因：品类 + 时段 + 困境 + 竞争 + 点位 五个维度交叉匹配',
          '⑤ 输出结论并给把握度，把握低的不会说死',
        ],
      },
      {
        h: '诊断标准',
        items: [
          '信息完整度：问卷没填够，我不会给核心结论，先追问',
          '案例相似度：和你情况越接近的案例，权重越高',
          '规则命中度：命中的规则越多、越具体，把握度越高',
          '顾客证据：你填的顾客动作、看哪里、哪里觉得不对，是硬证据',
          '前后一致：和上一轮结论冲突时会被降权，避免来回变',
        ],
      },
    ],
  },
  plan: {
    emoji: '💡', label: '具体方案', title: '方案是怎么算出来的',
    intro: '方案不是模板套话，是从诊断结论倒推出来的，并且只保留你今天真能做完的事。',
    blocks: [
      {
        h: '走哪几步',
        items: [
          '第 1 步 · 摊位画像：你卖什么、在哪卖、卖多少钱',
          '第 2 步 · 顾客行为：顾客走到摊前看什么、做什么',
          '第 3 步 · 问题诊断：卡在哪一环、根因是什么',
          '第 4 步 · 具体方案：今天就做的那一件（或两件）事',
          '第 5 步 · 测量指标：明天怎么数，怎么判断有没有用',
          '第 6 步 · 执行清单：一条条能勾掉的待办',
          '第 7 步 · 闭环复盘：效果如何，下一步往哪走',
        ],
      },
      {
        h: '依据什么',
        items: [
          '诊断出的根因——先解决卡点，不做无关动作',
          '相似案例里真正有效的做法，而不是通用话术',
          '成本低：优先 0 成本或几块钱能做的',
          '时间短：10-15 分钟能做完，不耽误你出摊',
          '能落地：你一个人就能干，不需要帮手和设备',
          '不重复：和你以前做过、没效果的动作会降权',
          '有退路：做坏了能马上撤回，不会亏本',
        ],
      },
    ],
  },
  loop: {
    emoji: '📈', label: '闭环复盘', title: '可以一轮轮接着聊',
    intro: '这是一个能陪你多轮打磨的顾问，不是一次性问答。同一份问卷也能反复深挖。',
    blocks: [
      {
        h: '能新开多轮对话',
        items: [
          '点「重新开始」= 全新一轮：问卷清空，我从头按新情况判断，不背旧结论',
          '点「继续上次的 · 第 N 步」= 接着这一轮往下走，之前的诊断、方案、指标都还在',
          '走完第 7 步后，可以保留品类只换点位，重新开一轮对比',
        ],
      },
      {
        h: '也能在原对话上继续深化',
        items: [
          '在第 4-6 步的 AI 对话框里直接追问，比如「太难了，换一个」「成本再压一点」',
          '追问时 AI 带着本轮的问卷、诊断、方案、指标和执行记录回答，不用重讲一遍',
          '方案不满意可以反复让它换，它会避开已经给过、你说不行的方向',
        ],
      },
    ],
  },
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-[13px] font-bold text-gray-800 mb-1.5">{title}</div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function Item({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-2">
      <span style={{ color: '#1f7a44' }} className="text-[12px] flex-shrink-0">•</span>
      <span className="text-[12.5px] text-gray-600 leading-relaxed">{children}</span>
    </div>
  );
}

export default function Home() {
  const navigate = useNavigate();
  const screenNum = useStore(s => s.screenNum);
  const sellWhat = useStore(s => s.screen1.sellWhat);
  const reset = useStore(s => s.reset);
  const setData = useStore(s => s.setData);
  const hasSession = screenNum > 1 || sellWhat;
  const [infoKey, setInfoKey] = useState<InfoKey | null>(null);

  // 反馈弹层
  const [fbOpen, setFbOpen] = useState(false);
  const [fbText, setFbText] = useState('');
  const [fbState, setFbState] = useState<'idle' | 'sending' | 'done'>('idle');
  const [legalOpen, setLegalOpen] = useState(false);

  const openFeedback = () => {
    setFbText('');
    setFbState('idle');
    setFbOpen(true);
  };

  const submitFeedback = async () => {
    const text = fbText.trim();
    if (!text || fbState === 'sending') return;
    setFbState('sending');
    try {
      const base = import.meta.env.VITE_API_BASE || '/api';
      const resp = await fetch(`${base}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, page: 'home' }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    } catch {
      // 后端不可用时先存在本地，至少不丢
      try {
        const KEY = 'vendor-advisor-feedback-local';
        const old = JSON.parse(localStorage.getItem(KEY) || '[]');
        localStorage.setItem(KEY, JSON.stringify([...old, { text, ts: Date.now() }]));
      } catch {
        // ignore
      }
    }
    setFbState('done');
  };

  const startFresh = () => { reset(); navigate('/screen/1'); };
  const continueSession = () => { navigate(`/screen/${screenNum}`); };
  const tryExample = () => {
    reset();
    setData({ ...EXAMPLE, screenNum: 3, createdAt: Date.now() });
    navigate('/screen/3');
  };

  return (
    <div className="relative flex flex-col min-h-full overflow-hidden">
      {/* 右上角：历史记录 / 反馈（等宽等高圆形按钮 + 小字标签） */}
      <div className="absolute top-14 right-3 z-30 flex flex-col items-center gap-2.5">
        <div className="flex flex-col items-center gap-1">
          <button
            type="button"
            onClick={() => navigate('/history')}
            aria-label="历史记录"
            title="历史记录"
            style={{
              width: 46, height: 46, borderRadius: 9999,
              background: 'rgba(255,255,255,0.92)', border: '1px solid #d1fae5',
            }}
            className="flex items-center justify-center text-[20px] leading-none shadow-soft active:scale-95 transition"
          >
            🕘
          </button>
          <span className="text-[10px] leading-none text-gray-500 font-semibold whitespace-nowrap">历史</span>
        </div>
        <div className="flex flex-col items-center gap-1">
          <button
            type="button"
            onClick={openFeedback}
            aria-label="反馈"
            title="反馈"
            style={{
              width: 46, height: 46, borderRadius: 9999,
              background: 'rgba(255,255,255,0.92)', border: '1px solid #e5e7eb',
            }}
            className="flex items-center justify-center text-[20px] leading-none shadow-soft active:scale-95 transition"
          >
            💬
          </button>
          <span className="text-[10px] leading-none text-gray-500 font-semibold whitespace-nowrap">反馈</span>
        </div>
      </div>

      {/* 装饰性光晕 */}
      <div className="bg-blob bg-mint-200 w-72 h-72 -top-20 -left-20" />
      <div className="bg-blob bg-mint-100 w-80 h-80 top-40 -right-20" />
      <div className="bg-blob bg-mint-300/60 w-56 h-56 -bottom-20 left-1/3" />

      <div className="flex-1 flex items-center justify-center py-12 px-4 relative z-10">
        <div className="w-full max-w-sm">
          {/* Logo + 标题 */}
          <div className="text-center mb-12 animate-gentle-float">
            <div className="w-20 h-20 mx-auto mb-6 rounded-3xl bg-gradient-to-br from-mint-400 via-mint-500 to-mint-600 text-white flex items-center justify-center text-4xl shadow-float animate-float-slow border-4 border-white">
              🛒
            </div>
            <h1 className="text-[32px] font-black text-gray-900 tracking-tight">
              地摊顾问
            </h1>
            <p className="mt-2 text-[14px] text-gray-500">帮你把生意盘活的 AI 顾问</p>
          </div>

          {/* 按钮区 */}
          <div className="space-y-3 animate-card-in">
            {hasSession && (
              <BigButton onClick={continueSession} variant="primary">
                继续上次的 · 第 {screenNum} 步
              </BigButton>
            )}

            <BigButton onClick={startFresh} variant={hasSession ? 'secondary' : 'primary'}>
              {hasSession ? '重新开始' : '开始诊断'}
            </BigButton>

            <button
              type="button"
              onClick={tryExample}
              style={{backgroundImage:'linear-gradient(to bottom right, #1f7a44, #176338)', color:'#fff', borderColor:'#176338'}}
              className="btn-pop w-full py-3 rounded-2xl text-[14px] font-bold border border-mint-600 shadow-pop transition-all active:scale-[0.99]"
            >
              🎯 一键体验（看看效果）
            </button>
          </div>

          {/* 功能亮点（可点击，看这台机器怎么干活）
              暂时隐藏：把 SHOW_HOME_FEATURE_CARDS 改回 true 即可恢复，代码与弹层逻辑都保留 */}
          {SHOW_HOME_FEATURE_CARDS && (
            <div className="mt-10 grid grid-cols-3 gap-3">
              {(Object.keys(INFO) as InfoKey[]).map(k => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setInfoKey(k)}
                  className="text-center py-3 rounded-2xl bg-white/60 backdrop-blur-sm border border-mint-100 shadow-soft transition-all active:scale-[0.98] hover:bg-white"
                >
                  <div className="text-2xl mb-1">{INFO[k].emoji}</div>
                  <div className="text-[12px] text-gray-500 font-medium">{INFO[k].label}</div>
                </button>
              ))}
            </div>
          )}

          {/* 底部说明 */}
          <p className="mt-8 text-center text-[11px] text-gray-400">
            你的摊位数据只存在本机；对话会发给 AI 处理，不存档
          </p>
          <button
            type="button"
            onClick={() => setLegalOpen(true)}
            className="mt-2 w-full text-center text-[11.5px] text-mint-600 underline underline-offset-2"
            style={{ color: '#1f7a44' }}
          >
            请阅读应用说明与用户隐私说明
          </button>
        </div>
      </div>

      {/* 反馈弹层 */}
      {fbOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center px-4 pb-4 sm:pb-0"
          style={{ background: 'rgba(17,24,39,0.45)', backdropFilter: 'blur(2px)' }}
          onClick={() => setFbOpen(false)}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: '#fff', borderRadius: 20, width: '100%', maxWidth: 460,
              boxShadow: '0 20px 60px -20px rgba(0,0,0,0.35)',
            }}
            className="p-5"
          >
            <div className="text-[15px] font-bold text-gray-900">💬 说说哪里不好用</div>
            <p className="mt-1.5 text-[12.5px] text-gray-500 leading-relaxed">
              卡在哪一步、哪句话看不懂、想要什么功能，都可以写。我看到会改。
            </p>

            {fbState === 'done' ? (
              <div className="mt-4 py-6 text-center text-[14px] text-mint-600" style={{ color: '#1f7a44' }}>
                ✅ 收到了，谢谢老板！
              </div>
            ) : (
              <textarea
                value={fbText}
                onChange={e => setFbText(e.target.value)}
                rows={4}
                placeholder="比如：屏 5 的指标看不懂 / 手机上找不到历史记录…"
                className="mt-3 w-full resize-none rounded-2xl border border-gray-200 bg-gray-50/60 px-4 py-3 text-[14px] leading-relaxed focus:outline-none focus:border-mint-300 focus:ring-4 focus:ring-mint-100"
              />
            )}

            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => setFbOpen(false)}
                className="flex-1 py-3 rounded-2xl text-[14px] font-bold text-gray-500 bg-gray-50"
              >
                {fbState === 'done' ? '关闭' : '取消'}
              </button>
              {fbState !== 'done' && (
                <button
                  type="button"
                  onClick={submitFeedback}
                  disabled={!fbText.trim() || fbState === 'sending'}
                  style={{ backgroundImage: 'linear-gradient(to bottom right, #1f7a44, #176338)', color: '#fff' }}
                  className="flex-[1.4] py-3 rounded-2xl text-[14px] font-bold disabled:opacity-40 active:scale-[0.99] transition"
                >
                  {fbState === 'sending' ? '发送中…' : '提交反馈'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 应用说明 / 隐私说明弹层 */}
      {legalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center px-4 pb-4 sm:pb-0"
          style={{ background: 'rgba(17,24,39,0.45)', backdropFilter: 'blur(2px)' }}
          onClick={() => setLegalOpen(false)}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: '#fff', borderRadius: 20, width: '100%', maxWidth: 460,
              maxHeight: '82vh', overflowY: 'auto',
              boxShadow: '0 20px 60px -20px rgba(0,0,0,0.35)',
            }}
            className="p-5"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="text-[15px] font-bold text-gray-900">📄 应用说明与用户隐私说明</div>
              <button
                type="button"
                onClick={() => setLegalOpen(false)}
                aria-label="关闭"
                style={{ background: '#f3f4f6', color: '#6b7280', borderRadius: 999, width: 28, height: 28, flexShrink: 0 }}
                className="flex items-center justify-center text-[15px] leading-none"
              >
                ×
              </button>
            </div>

            <div className="mt-4 space-y-4">
              <Section title="一、这是什么">
                <Item>「地摊顾问」是给摆摊老板用的 AI 顾问：按你填的摊位情况，给出问题诊断和今天就能做的动作，第 7 步再回来看效果，形成一轮闭环。</Item>
                <Item>不需要注册账号，凭访问码进入。</Item>
              </Section>

              <Section title="二、怎么用">
                <Item>填问卷（卖什么、在哪卖、顾客什么反应）→ 点「AI 诊断」看判断 → 挑一件今天做 → 明天回来报效果。</Item>
                <Item>建议来自 AI 与案例库，不保证一定涨生意；涉及城管、食品安全、经营许可等，以当地规定为准。</Item>
              </Section>

              <Section title="三、你的数据存在哪">
                <Item>问卷、诊断、方案、对话记录、历史记录：只存在你这台手机的浏览器里（localStorage），不上传云端保存。换手机、清缓存或卸载浏览器数据会一起丢失。</Item>
                <Item>点「AI 诊断」时，你填的问卷和最近几轮对话会发送到本应用服务器，并转给 AI 模型服务（DeepSeek）做推理；服务器不建会话数据库，仅在内存里做临时缓存。</Item>
                <Item>检索案例时，问题文本会发给向量化服务（硅基流动）计算相似度，只用于匹配案例库。</Item>
                <Item>你在「反馈」里主动提交的内容会保存到服务器，用于改进产品；反馈不包含你的问卷和对话。</Item>
                <Item>一轮结束后会问你一次「愿意匿名分享吗」：点「愿意」只会提交这次的品类、诊断结论、方案和效果，不含对话记录、不含身份信息；同意后会给你看一条同行业的脱敏参考案例（已去掉店名、地址、联系方式）；不分享也完全不影响使用，不会默认勾选。</Item>
              </Section>

              <Section title="四、我们不做什么">
                <Item>不出售、不共享你的数据给广告商。</Item>
                <Item>不收集通讯录、位置、相册等与功能无关的信息。</Item>
              </Section>

              <Section title="五、怎么删除">
                <Item>历史记录页可以删除单条或清空全部。</Item>
                <Item>清除浏览器本站数据，即可删除本机保存的全部内容；云端不保留你的会话。</Item>
              </Section>
            </div>

            <button
              type="button"
              onClick={() => setLegalOpen(false)}
              style={{ backgroundImage: 'linear-gradient(to bottom right, #1f7a44, #176338)', color: '#fff' }}
              className="mt-5 w-full py-3 rounded-2xl text-[14px] font-bold"
            >
              我知道了
            </button>
          </div>
        </div>
      )}

      {/* 说明弹层 */}
      {infoKey && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center px-4 pb-4 sm:pb-0"
          style={{ background: 'rgba(17,24,39,0.45)', backdropFilter: 'blur(2px)' }}
          onClick={() => setInfoKey(null)}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: '#fff', borderRadius: 20, width: '100%', maxWidth: 460,
              maxHeight: '82vh', overflowY: 'auto',
              boxShadow: '0 20px 60px -20px rgba(0,0,0,0.35)',
            }}
          >
            <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-3">
              <div>
                <div className="text-[15px] font-bold text-gray-900">
                  {INFO[infoKey].emoji} {INFO[infoKey].title}
                </div>
                <p className="mt-1.5 text-[12.5px] text-gray-500 leading-relaxed">
                  {INFO[infoKey].intro}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setInfoKey(null)}
                aria-label="关闭"
                style={{ background: '#f3f4f6', color: '#6b7280', borderRadius: 999, width: 28, height: 28, flexShrink: 0 }}
                className="flex items-center justify-center text-[15px] leading-none"
              >
                ×
              </button>
            </div>

            <div className="px-5 pb-5 space-y-4">
              {INFO[infoKey].blocks.map(b => (
                <div key={b.h}>
                  <div className="text-[13px] font-bold text-gray-800 mb-1.5">{b.h}</div>
                  <div className="space-y-1.5">
                    {b.items.map(it => (
                      <div key={it} className="flex gap-2">
                        <span className="text-mint-600 text-[12px] flex-shrink-0" style={{ color: '#1f7a44' }}>•</span>
                        <span className="text-[12.5px] text-gray-600 leading-relaxed">{it}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div className="px-5 pb-5">
              <button
                type="button"
                onClick={() => setInfoKey(null)}
                style={{ backgroundImage: 'linear-gradient(to bottom right, #1f7a44, #176338)', color: '#fff' }}
                className="w-full py-3 rounded-2xl text-[14px] font-bold"
              >
                知道了
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
