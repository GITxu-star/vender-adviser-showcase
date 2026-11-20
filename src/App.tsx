import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, useNavigate, useParams, useLocation } from 'react-router-dom';
import Home from './pages/Home';
import Screen1 from './pages/Screen1';
import Screen2 from './pages/Screen2';
import Screen3 from './pages/Screen3';
import Screen4 from './pages/Screen4';
import Screen5 from './pages/Screen5';
import Screen6 from './pages/Screen6';
import Screen7 from './pages/Screen7';
import History from './pages/History';
import { useStore } from './store/useStore';
import AiChat, { triggerAi } from './components/AiChat';
import AiSheet from './components/AiSheet';
import { AccessGate } from './components/AccessGate';
import StepIndicator from './components/StepIndicator';

const SCREEN_MAP: Record<number, React.FC> = {
  1: Screen1, 2: Screen2, 3: Screen3, 4: Screen4,
  5: Screen5, 6: Screen6, 7: Screen7,
};

const STEP_AI_HINTS: Record<number, string> = {
  1: '我填完基本情况了，你对我的摊位有什么判断？',
  2: '顾客的反应我也填了，问题出在哪？',
  3: '给我一个今天就能做的具体方案。',
  4: '好，我准备今天就做，帮我确认一下成本和退路。',
  5: '帮我定一个简单的测量方法，明天看有没有用。',
  6: '我做完了，记一笔。',
  7: '结果出来了，接下来我该怎么走？',
};

// 是否手机/窄屏：窄屏隐藏右侧常驻面板，改用底部输入条 + 半屏对话
function useIsMobile() {
  const [mobile, setMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const onChange = () => setMobile(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return mobile;
}

// ============ 路由页面（轻量、无状态、可重建） ============
function HomeRoute() {
  return <Home />;
}

function ScreenRoute() {
  const { num } = useParams();
  const navigate = useNavigate();
  const n = parseInt(num ?? '0', 10);
  const Page = SCREEN_MAP[n];
  const update = useStore(s => s.update);

  // 路由就是当前步骤的唯一真相：返回上一步时把 screenNum 同步回来，
  // 否则 AI 会拿旧的步骤上下文回答（比如屏 4 点「砍简单点」却答成第 5 步）
  useEffect(() => {
    if (n >= 1 && n <= 7) update('screenNum', n);
  }, [n, update]);

  if (!Page) {
    navigate('/');
    return null;
  }

  return (
    <>
      <StepIndicator />
      <div className="mx-auto w-full max-w-xl px-8 py-10">
        <Page />
        {/* 移动端不用这个按钮：底部输入条常驻，进屏还会自动诊断一次 */}
        <div className="pt-6 hidden md:block">
          <button
            type="button"
            onClick={() => triggerAi(STEP_AI_HINTS[n])}
            style={{backgroundImage:'linear-gradient(to bottom right, #1f7a44, #176338)', color:'#fff'}}
            className="btn-pop w-full text-white text-[15px] font-bold px-6 py-3.5 rounded-2xl shadow-pop transition-all active:scale-[0.98]"
          >
            🛒 点我让 AI 诊断一下
          </button>
          <p className="text-[11px] text-gray-400 text-center mt-2">
            右边 AI 面板会自动开始分析
          </p>
        </div>
      </div>
    </>
  );
}

// ============ Shell：唯一的 BrowserRouter 子组件（只 mount 一次） ============
function Shell() {
  const location = useLocation();
  const [sheetExpanded, setSheetExpanded] = useState(false);
  const isMobile = useIsMobile();
  const isHome = !location.pathname.startsWith('/screen/');
  const num = parseInt(location.pathname.split('/').pop() ?? '0', 10);
  const hint = STEP_AI_HINTS[num];

  return (
    <div className="min-h-screen relative">
      {/* 装饰背景（PC 端显示） */}
      <div className="bg-blob bg-mint-100 w-96 h-96 -top-40 -left-40 hidden md:block absolute" />
      <div className="bg-blob bg-mint-50 w-80 h-80 top-1/3 -right-32 hidden md:block absolute" />

      {/* ============ 路由区：唯一一份 Routes ============ */}
      <div className="relative z-10 flex h-screen">
        {/* 左：路由渲染区（含 Home + Screen1-7），会跟着路由重建，轻量无状态 */}
        <div className="flex-1 overflow-y-auto pb-24 md:pb-0">
          <Routes>
            <Route path="/" element={<HomeRoute />} />
            <Route path="/history" element={<History />} />
            <Route path="/screen/:num" element={<ScreenRoute />} />
          </Routes>
        </div>

        {/* 右：AI 对话面板 —— 和 Routes 平级，只 mount 一次！永不重建！
            窄屏不渲染，改用底部 AiSheet 里的那一份对话 */}
        {!isHome && !isMobile && (
          <aside className="w-[420px] xl:w-[460px] flex-shrink-0 border-l border-gray-100 bg-white/90 backdrop-blur-sm h-screen sticky top-0 shadow-[0_0_40px_-20px_rgba(45,138,83,0.15)]">
            <AiChat compact />
          </aside>
        )}
      </div>

      {/* ============ 移动端：底部输入条 + 半屏对话 ============ */}
      {!isHome && isMobile && (
        <AiSheet expanded={sheetExpanded} onExpandedChange={setSheetExpanded} hint={hint} />
      )}

    </div>
  );
}

function App() {
  return (
    <BrowserRouter>
      <AccessGate>
        <Shell />
      </AccessGate>
    </BrowserRouter>
  );
}

export default App;
