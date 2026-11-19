import { useMemo, useRef, useState } from 'react';
import { useStore } from '../store/useStore';

// ============ 画布坐标系 ============
const W = 400;
const H = 300;

type Pt = { x: number; y: number };
type DragKey = 'stall' | 'from' | 'to' | null;

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

/** 摊位形状（按 stallType 数字推断） */
function stallShape(stallType: string): 'rect' | 'cart' | 'table' | 'mat' {
  const n = stallType.split('（')[0].trim();
  if (['4', '5', '6', '7'].includes(n)) return 'cart';
  if (['2', '3'].includes(n)) return 'table';
  if (n === '9') return 'mat';
  return 'rect';
}

interface Action {
  tone: 'good' | 'warn' | 'bad';
  title: string;
  detail: string;
}

export default function CustomerFlow() {
  const screen1 = useStore(s => s.screen1);
  const judgment = useStore(s => s.judgment);
  const solution = useStore(s => s.solution);

  // 三个可拖动点
  const [from, setFrom] = useState<Pt>({ x: 50, y: 110 });
  const [to, setTo] = useState<Pt>({ x: 350, y: 110 });
  const [stall, setStall] = useState<Pt>({ x: 200, y: 190 });
  const [paused, setPaused] = useState(false);

  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<DragKey>(null);
  const [active, setActive] = useState<DragKey>(null);

  const shape = stallShape(screen1.stallType || '');

  const toLocal = (e: React.PointerEvent): Pt => {
    const svg = svgRef.current!;
    const r = svg.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * W,
      y: ((e.clientY - r.top) / r.height) * H,
    };
  };

  const onDown = (which: Exclude<DragKey, null>) => (e: React.PointerEvent<SVGGElement>) => {
    dragRef.current = which;
    setActive(which);
    svgRef.current?.setPointerCapture(e.pointerId);
  };

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!dragRef.current) return;
    const p = toLocal(e);
    const next = { x: clamp(p.x, 28, W - 28), y: clamp(p.y, 60, H - 22) };
    if (dragRef.current === 'from') setFrom(next);
    else if (dragRef.current === 'to') setTo(next);
    else setStall(next);
  };

  const onUp = (e: React.PointerEvent<SVGSVGElement>) => {
    dragRef.current = null;
    setActive(null);
    svgRef.current?.releasePointerCapture(e.pointerId);
  };

  // 摊位左右微调（手机上拖不准的兜底）
  const nudge = (dx: number) =>
    setStall(s => ({ ...s, x: clamp(s.x + dx, 28, W - 28) }));

  // ============ 纯几何推理 ============
  const analysis = useMemo(() => {
    const dir: 1 | -1 = to.x >= from.x ? 1 : -1; // 1: 左→右
    const comeFrom = dir === 1 ? '左边' : '右边';
    const lo = Math.min(from.x, to.x);
    const hi = Math.max(from.x, to.x);
    const width = Math.max(hi - lo, 1);

    // 是否落在人流线上（左右容差 16px ≈ 半个摊宽）
    const offLeft = Math.max(0, lo - 16 - stall.x);
    const offRight = Math.max(0, stall.x - (hi + 16));
    const offset = Math.max(offLeft, offRight);

    // 在人流线上的相对位置：0 = 起点（上游），1 = 终点（下游）
    const ratio = clamp((stall.x - lo) / width, 0, 1);

    const actions: Action[] = [];

    // ① 位置
    if (offset > 0) {
      const steps = Math.max(1, Math.round(offset / 14));
      const toward = offLeft > 0 ? '右' : '左';
      actions.push({
        tone: 'bad',
        title: `你不在人流线上，往${toward}挪 ${steps} 步`,
        detail: `顾客从${comeFrom}走过来，走的是图上那条虚线。你现在偏在线外 ${Math.round(offset)} 个格，路过的人几乎不会拐过来。`,
      });
    } else if (ratio > 0.72) {
      actions.push({
        tone: 'warn',
        title: '你在人流的末段，往上游挪一半',
        detail: '人走到这个位置已经逛得差不多了、手上也拎满了。挪到人流前半段，看到的还是"刚好想买"的人。',
      });
    } else {
      actions.push({
        tone: 'good',
        title: '位置对了：就站在这条人流线上',
        detail: `你处在人流前半段，从${comeFrom}来的人第一眼就能看见你。别挪走。`,
      });
    }

    // ② 招牌朝向
    actions.push({
      tone: 'good',
      title: `招牌正对${comeFrom}`,
      detail: `人是${dir === 1 ? '从左往右' : '从右往左'}走的，招牌要迎着头顶视线。挂高一点、别平放桌面。`,
    });

    // ③ 价签与主打品的手边
    actions.push({
      tone: 'good',
      title: `价签和主打品放在${comeFrom}这一侧（你的${dir === 1 ? '左' : '右'}手边）`,
      detail: '顾客走近先看到招牌 → 再看到价格 → 伸手就拿。这一侧放最想卖的那一款，别藏在摊子后半截。',
    });

    return { dir, comeFrom, offset, ratio, actions };
  }, [from, to, stall]);

  const dirLabel = analysis.dir === 1 ? '左 → 右' : '右 → 左';

  // ============ AI 建议关键词提取 ============
  // 把 AI 诊断文本里提到的"招牌/摆放/挪位"关键词转成布尔标记，用于 SVG 可视化
  const aiText = (judgment?.howToFix ?? '') + ' ' + (judgment?.angles ?? '') + ' ' + (solution?.doWhat ?? '');
  const aiHasSignAdvice = /招牌|标牌|牌子/.test(aiText);
  const aiHasLayoutAdvice = /摆|摆放|陈列|主打|展示/.test(aiText);
  const aiHasMoveAdvice = /挪|移|换|往前|往后|往前|上游|下游|偏/.test(aiText);

  const toneCls: Record<Action['tone'], string> = {
    good: 'border-mint-200 bg-mint-50/70',
    warn: 'border-amber-200 bg-amber-50/70',
    bad: 'border-red-200 bg-red-50/70',
  };
  const toneIcon: Record<Action['tone'], string> = {
    good: '✓', warn: '!', bad: '×',
  };
  const toneIconCls: Record<Action['tone'], string> = {
    good: 'bg-mint-600 text-white',
    warn: 'bg-amber-500 text-white',
    bad: 'bg-red-500 text-white',
  };

  return (
    <div className="bg-white/90 backdrop-blur-sm rounded-2xl border border-mint-100 p-5 shadow-card">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <span className="w-7 h-7 rounded-xl bg-gradient-to-br from-mint-400 to-mint-500 text-white text-xs font-black flex items-center justify-center shadow-sm">🎯</span>
          <div>
            <div className="text-[12px] font-black text-gray-900 tracking-tight">顾客动线 · 自己标一遍</div>
            <div className="text-[11px] text-gray-500">拖三个点，看清你该站哪</div>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setPaused(p => !p)}
            className="text-[11px] px-2.5 py-1 rounded-full bg-mint-50 text-mint-600 hover:bg-mint-100 transition font-semibold"
          >
            {paused ? '▶ 走起来' : '⏸ 暂停'}
          </button>
          <button
            type="button"
            onClick={() => { setFrom({ x: 50, y: 110 }); setTo({ x: 350, y: 110 }); setStall({ x: 200, y: 190 }); }}
            className="text-[11px] px-2.5 py-1 rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200 transition font-semibold"
          >
            重置
          </button>
        </div>
      </div>

      <p className="text-[11.5px] text-gray-500 mb-2.5 leading-relaxed">
        把 <b className="text-gray-800">🚶 顾客</b> 拖到他从哪走过来，<b className="text-gray-800">🏁 终点</b> 拖到他往哪去，再拖 <b className="text-mint-700">你的摊</b> 到你现在的位置。
      </p>

      <div className="rounded-xl border border-gray-100 bg-gradient-to-br from-gray-50 to-mint-50/40 overflow-hidden">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="w-full h-auto touch-none select-none cursor-grab active:cursor-grabbing"
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        >
          <defs>
            <pattern id="cf-grid" width="20" height="20" patternUnits="userSpaceOnUse">
              <path d="M 20 0 L 0 0 0 20" fill="none" stroke="#e5e7eb" strokeWidth="0.5" />
            </pattern>
            <marker id="cf-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#1f7a44" opacity="0.6" />
            </marker>
            {/* AI 建议层的彩色箭头 */}
            <marker id="cf-ai-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 1 L 9 5 L 0 9 z" fill="#1f7a44" />
            </marker>
            <marker id="cf-ai-arrow-warn" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 1 L 9 5 L 0 9 z" fill="#f59e0b" />
            </marker>
            <marker id="cf-ai-arrow-bad" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 1 L 9 5 L 0 9 z" fill="#ef4444" />
            </marker>
            {/* 小人步态：多部件协调动画 */}
            <style>{`
              /* 身体颠簸：走路时中心上下起伏 */
              .cf-body-bob { animation: bob 0.5s ease-in-out infinite; transform-origin: center; }
              @keyframes bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-1.2px); } }
              /* 头部独立微摆 */
              .cf-head-tilt { animation: headtilt 1s ease-in-out infinite; transform-origin: center bottom; }
              @keyframes headtilt { 0% { transform: rotate(-1.5deg) translateY(0); } 50% { transform: rotate(1.5deg) translateY(-0.3px); } 100% { transform: rotate(-1.5deg) translateY(0); } }
              /* 暂停态 */
              .cf-paused .cf-body-bob, .cf-paused .cf-head-tilt { animation-play-state: paused; }
            `}</style>
          </defs>
          <rect width={W} height={H} fill="url(#cf-grid)" />

          {/* 供 animateMotion 引用的隐形路径（方向自动对齐） */}
          <path
            id="cf-path"
            d={`M ${from.x} ${from.y} L ${to.x} ${to.y}`}
            fill="none" stroke="none"
          />

          {/* 人流线：两层（厚底 + 虚线箭头） */}
          <line
            x1={from.x} y1={from.y} x2={to.x} y2={to.y}
            stroke="#1f7a44" strokeOpacity="0.3" strokeWidth="10" strokeLinecap="round"
          />
          <line
            x1={from.x} y1={from.y} x2={to.x} y2={to.y}
            stroke="#1f7a44" strokeOpacity="0.55" strokeWidth="2"
            strokeDasharray="6 7" strokeLinecap="round"
            markerEnd="url(#cf-arrow)"
          />

          {/* 行人动画层：5 个多态小人，沿 from→to 人流线行走 */}
          {/* 每个小人有独立体型、步速、摆臂相位、路径微摆偏移 */}
          <g data-paused={paused} className={paused ? 'cf-paused' : ''}>
            {/* 5 个行人配置：颜色 / 步速 / 摆臂相位 / 路径侧偏 / 身高比例 / 起始延迟 */}
            {[
              { color: '#1f7a44', walkDur: '7.2s', phase: 0,   sway: 2.5, scale: 1.0, delay: 0    }, // 墨绿 · 正常步速
              { color: '#1f7a44', walkDur: '8.8s', phase: 90,  sway: -2,  scale: 0.92, delay: 1.6  }, // 墨绿 · 稍慢稍矮
              { color: '#6366f1', walkDur: '6.5s', phase: 180, sway: 1.5, scale: 1.08, delay: 3.1  }, // 靛蓝 · 快步高个
              { color: '#0ea5e9', walkDur: '8.0s', phase: 270, sway: -3,  scale: 0.98, delay: 4.6  }, // 天蓝 · 常规步速
              { color: '#f59e0b', walkDur: '9.2s', phase: 45,  sway: 3.5, scale: 0.88, delay: 5.9  }, // 琥珀 · 慢步小个
            ].map((p, i) => {
              const stepDur = 0.5; // 一个完整步态周期（秒）
              const phaseSec = (p.phase / 360) * stepDur; // 初始相位换算成秒
              const legPivotY = 2.8 * p.scale; // 髋关节 y（缩放后）
              const hipPivotX = 0; // 髋部中心 x

              return (
                <g key={paused ? `p-${i}` : `r-${i}`}>
                  {/* ========== 小人本体 ========== */}
                  <g transform={`scale(${p.scale})`}>
                    {/* 头部（独立微摆） */}
                    <g className="cf-head-tilt">
                      <circle cx={0} cy={-7.5} r={3.4} fill="white" stroke={p.color} strokeWidth={1} />
                      {/* 小眼睛点缀 */}
                      <circle cx={-1} cy={-7.8} r={0.6} fill={p.color} />
                      <circle cx={1} cy={-7.8} r={0.6} fill={p.color} />
                    </g>

                    {/* 躯干 + 四肢（整体上下颠簸） */}
                    <g className="cf-body-bob">
                      {/* 髋部：腿摆动时同步轻微转动 ±5° */}
                      <g>
                        {/* 左腿：绕髋关节 ±25° 摆动 */}
                        <line
                          x1={-1.6} y1={legPivotY} x2={-1.6} y2={legPivotY + 6}
                          stroke={p.color} strokeWidth={1.7} strokeLinecap="round"
                        >
                          <animateTransform
                            attributeName="transform" type="rotate"
                            values={`-25 ${-1.6} ${legPivotY}; 25 ${-1.6} ${legPivotY}; -25 ${-1.6} ${legPivotY}`}
                            dur={`${stepDur}s`}
                            begin={`${phaseSec}s`}
                            repeatCount="indefinite" additive="sum"
                          />
                        </line>
                        {/* 右腿：与左腿反相 */}
                        <line
                          x1={1.6} y1={legPivotY} x2={1.6} y2={legPivotY + 6}
                          stroke={p.color} strokeWidth={1.7} strokeLinecap="round"
                        >
                          <animateTransform
                            attributeName="transform" type="rotate"
                            values={`25 ${1.6} ${legPivotY}; -25 ${1.6} ${legPivotY}; 25 ${1.6} ${legPivotY}`}
                            dur={`${stepDur}s`}
                            begin={`${phaseSec}s`}
                            repeatCount="indefinite" additive="sum"
                          />
                        </line>

                        {/* 髋部整体轻微旋转（与前摆腿同方向 ±5°） */}
                        <animateTransform
                          attributeName="transform" type="rotate"
                          values={`5 ${hipPivotX} 0; -5 ${hipPivotX} 0; 5 ${hipPivotX} 0`}
                          dur={`${stepDur}s`}
                          begin={`${phaseSec}s`}
                          repeatCount="indefinite" additive="sum"
                        />
                      </g>

                      {/* 躯干主体 */}
                      <rect x={-2.4} y={-4.5} width={4.8} height={7.2} rx={1.3} fill={p.color} />

                      {/* 肩部反相旋转（与髋部反方向 ±4°，躯干扭转感） */}
                      <g transform={`translate(0, -2.5)`}>
                        <animateTransform
                          attributeName="transform" type="rotate"
                          values={`-4 0 0; 4 0 0; -4 0 0`}
                          dur={`${stepDur}s`}
                          begin={`${phaseSec}s`}
                          repeatCount="indefinite" additive="sum"
                        />
                        {/* 左臂：与右腿同相摆动（左臂配右腿） */}
                        <line
                          x1={-2.4} y1={0} x2={-2.4} y2={4.5}
                          stroke={p.color} strokeWidth={1.5} strokeLinecap="round"
                        >
                          <animateTransform
                            attributeName="transform" type="rotate"
                            values={`20 ${-2.4} 0; -20 ${-2.4} 0; 20 ${-2.4} 0`}
                            dur={`${stepDur}s`}
                            begin={`${phaseSec}s`}
                            repeatCount="indefinite" additive="sum"
                          />
                        </line>
                        {/* 右臂：与左腿同相摆动（右臂配左腿） */}
                        <line
                          x1={2.4} y1={0} x2={2.4} y2={4.5}
                          stroke={p.color} strokeWidth={1.5} strokeLinecap="round"
                        >
                          <animateTransform
                            attributeName="transform" type="rotate"
                            values={`-20 ${2.4} 0; 20 ${2.4} 0; -20 ${2.4} 0`}
                            dur={`${stepDur}s`}
                            begin={`${phaseSec}s`}
                            repeatCount="indefinite" additive="sum"
                          />
                        </line>
                      </g>
                    </g>
                  </g>

                  {/* ========== 沿路径行走 + 垂直方向微摆 ========== */}
                  {/* 主运动：沿 from→to 人流线移动，rotate=auto 自动对齐方向 */}
                  <animateMotion
                    dur={p.walkDur}
                    begin={paused ? 'indefinite' : `${p.delay}s`}
                    repeatCount="indefinite"
                    rotate="auto"
                    calcMode="linear"
                  >
                    <mpath href="#cf-path" />
                  </animateMotion>

                  {/* 路径微摆：垂直于人流线方向的小幅正弦偏移，让行人不完全走直线 */}
                  {/* 用 additive="sum" 叠加到 animateMotion 上 */}
                  {p.sway !== 0 && (
                    <animateTransform
                      attributeName="transform"
                      type="translate"
                      values={`0 0; ${p.sway} 0; 0 0; ${-p.sway} 0; 0 0`}
                      dur={`${stepDur * 2}s`}
                      begin={paused ? 'indefinite' : `${p.delay + phaseSec}s`}
                      repeatCount="indefinite"
                      additive="sum"
                    />
                  )}
                </g>
              );
            })}
          </g>

          {/* 摊位位置与动线的垂直连线（偏线时显示） */}
          {analysis.offset > 0 && (
            <line
              x1={stall.x} y1={stall.y} x2={stall.x} y2={from.y}
              stroke="#ef4444" strokeWidth="1.5" strokeDasharray="3 3" opacity="0.6"
            />
          )}

          {/* ============ AI 建议可视化层 ============
               只给摊主看的建议标记，基于纯几何推理 + AI 关键词叠加
               画在摊位之下、人流线之上 */}
          <g opacity={0.95}>
            {/* ① 招牌朝向箭头（永远给建议：招牌朝人流来向） */}
            {(() => {
              // 招牌方向：从摊位 → 指向人流来向（from 点方向）
              const dx = from.x - stall.x;
              const dy = from.y - stall.y;
              const len = Math.hypot(dx, dy) || 1;
              const nx = dx / len;
              const ny = dy / len;
              // 箭头从摊位边缘出发，画 55px 长
              const arrowStartX = stall.x + nx * 26;
              const arrowStartY = stall.y + ny * 26;
              const arrowEndX = stall.x + nx * 70;
              const arrowEndY = stall.y + ny * 70;
              // 招牌小图标位置（箭头终点偏上）
              const signX = stall.x + nx * 82;
              const signY = stall.y + ny * 82 - 6;
              return (
                <g>
                  {/* 招牌箭头 */}
                  <line
                    x1={arrowStartX} y1={arrowStartY}
                    x2={arrowEndX} y2={arrowEndY}
                    stroke="#1f7a44" strokeWidth="2.5" strokeLinecap="round"
                    markerEnd="url(#cf-ai-arrow)"
                  />
                  {/* 招牌小图标（带脉冲感） */}
                  <g transform={`translate(${signX}, ${signY})`}>
                    <rect x={-10} y={-5} width={20} height={10} rx={2}
                      fill="#1f7a44" opacity={0.18} />
                    <rect x={-9} y={-4} width={18} height={8} rx={1.5}
                      fill="none" stroke="#1f7a44" strokeWidth={1.2} strokeDasharray="2 1.5" />
                    <text x={0} y={2.5} textAnchor="middle" fontSize="6.5"
                      fontWeight="bold" fill="#1f7a44">招牌</text>
                    {/* 脉冲动画 */}
                    <animateTransform attributeName="transform" type="scale"
                      values="1;1.15;1" dur="1.8s" repeatCount="indefinite" additive="sum" />
                  </g>
                  {/* "招牌朝这" 文字 */}
                  <text
                    x={(arrowStartX + signX) / 2 + nx * 4}
                    y={(arrowStartY + signY) / 2 + ny * 4 - 6}
                    textAnchor="middle" fontSize="7" fontWeight="700" fill="#1f7a44"
                  >
                    招牌朝这
                  </text>
                </g>
              );
            })()}

            {/* ② 主打品摆放区高亮（摊位 + 招牌同侧的矩形区域） */}
            {(() => {
              const isLeft = from.x <= stall.x;
              const rectX = isLeft ? stall.x - 30 : stall.x;
              const rectW = 30;
              return (
                <g>
                  {/* 主打品半透明高亮区 */}
                  <rect
                    x={rectX} y={stall.y - 22}
                    width={rectW} height={40} rx={4}
                    fill="#fef3c7" opacity={0.45}
                    stroke="#d97706" strokeWidth={1} strokeDasharray="2 1.5"
                  />
                  {/* 小标签 */}
                  <g transform={`translate(${isLeft ? stall.x - 15 : stall.x + 15}, ${stall.y - 30})`}>
                    <rect x={-16} y={-8} width={32} height={13} rx={4}
                      fill="#f59e0b" opacity={0.85} />
                    <text x={0} y={1} textAnchor="middle" fontSize="6.5"
                      fontWeight="bold" fill="white">主打品放这</text>
                  </g>
                </g>
              );
            })()}

            {/* ③ 摊位位置建议：挪位方向指示（有问题时才画） */}
            {analysis.offset > 0 && (() => {
              // offset > 0 表示偏线，往人流线方向挪
              const steps = Math.max(1, Math.round(analysis.offset / 14));
              const targetX = analysis.dir === 1
                ? (from.x + to.x) / 2
                : (from.x + to.x) / 2;
              const targetY = stall.y;
              const toTargetX = targetX - stall.x;
              const toTargetY = targetY - stall.y;
              return (
                <g>
                  {/* 目标位置虚线框 */}
                  <rect
                    x={targetX - 32} y={targetY - 24}
                    width={64} height={48} rx={6}
                    fill="#ef4444" opacity={0.12}
                    stroke="#ef4444" strokeWidth={1.8} strokeDasharray="4 3"
                  >
                    <animate attributeName="stroke-dashoffset"
                      values="0;14" dur="1.2s" repeatCount="indefinite" />
                  </rect>
                  {/* 从当前摊位指向目标位置的箭头 */}
                  <line
                    x1={stall.x + Math.sign(toTargetX) * 32} y1={stall.y}
                    x2={targetX - Math.sign(toTargetX) * 34} y2={targetY}
                    stroke="#ef4444" strokeWidth="2" strokeDasharray="3 2"
                    markerEnd="url(#cf-ai-arrow-bad)"
                  />
                  {/* 挪位提示 */}
                  <text
                    x={(stall.x + targetX) / 2}
                    y={stall.y + Math.abs(toTargetY) + 14}
                    textAnchor="middle" fontSize="8" fontWeight="bold" fill="#ef4444"
                  >
                    往人流线挪 {steps} 步
                  </text>
                </g>
              );
            })()}

            {/* ③b 摊位在下游末段，挪上游（warn 级） */}
            {analysis.offset === 0 && analysis.ratio > 0.72 && (() => {
              const targetX = from.x + (to.x - from.x) * 0.35;
              return (
                <g>
                  <rect
                    x={targetX - 32} y={stall.y - 24}
                    width={64} height={48} rx={6}
                    fill="#f59e0b" opacity={0.12}
                    stroke="#f59e0b" strokeWidth={1.8} strokeDasharray="4 3"
                  >
                    <animate attributeName="stroke-dashoffset"
                      values="0;14" dur="1.2s" repeatCount="indefinite" />
                  </rect>
                  <line
                    x1={stall.x + (targetX > stall.x ? 32 : -32)} y1={stall.y}
                    x2={targetX + (targetX > stall.x ? -34 : 34)} y2={stall.y}
                    stroke="#f59e0b" strokeWidth="2" strokeDasharray="3 2"
                    markerEnd="url(#cf-ai-arrow-warn)"
                  />
                  <text
                    x={(stall.x + targetX) / 2}
                    y={stall.y + 2}
                    textAnchor="middle" fontSize="8" fontWeight="bold" fill="#b45309"
                  >
                    往上游挪一半
                  </text>
                </g>
              );
            })()}

            {/* ④ AI 诊断关键词匹配标记（如果 AI 明确提到了招牌/摆放/挪位） */}
            {(aiHasSignAdvice || aiHasLayoutAdvice || aiHasMoveAdvice) && (
              <g transform={`translate(${W - 90}, 14)`}>
                <rect x={0} y={0} width={86} height={aiHasSignAdvice && aiHasLayoutAdvice ? (aiHasMoveAdvice ? 42 : 28) : 14}
                  rx={4} fill="#1f7a44" opacity={0.06} />
                {aiHasSignAdvice && (
                  <text x={4} y={10} fontSize="6.5" fontWeight="700" fill="#1f7a44">
                    ✦ AI 提到：招牌朝向
                  </text>
                )}
                {aiHasLayoutAdvice && (
                  <text x={4} y={aiHasSignAdvice ? 23 : 10} fontSize="6.5" fontWeight="700" fill="#d97706">
                    ✦ AI 提到：商品摆放
                  </text>
                )}
                {aiHasMoveAdvice && (
                  <text x={4} y={aiHasSignAdvice && aiHasLayoutAdvice ? 36 : aiHasSignAdvice || aiHasLayoutAdvice ? 23 : 10} fontSize="6.5" fontWeight="700" fill="#ef4444">
                    ✦ AI 提到：摊位位置
                  </text>
                )}
              </g>
            )}
          </g>

          {/* 摊位 */}
          <g
            onPointerDown={onDown('stall')}
            className="cursor-grab active:cursor-grabbing"
            style={{ touchAction: 'none' }}
          >
            <g transform={`translate(${stall.x}, ${stall.y})`}>
              {shape === 'cart' && (
                <>
                  <rect x={-30} y={-22} width={60} height={40} rx="6" fill="#fff" stroke="#1f7a44" strokeWidth="2.5" />
                  <circle cx={-20} cy={22} r={4} fill="#374151" />
                  <circle cx={20} cy={22} r={4} fill="#374151" />
                </>
              )}
              {shape === 'table' && (
                <>
                  <rect x={-30} y={-22} width={60} height={34} rx="3" fill="#fff" stroke="#1f7a44" strokeWidth="2" />
                  <line x1={-26} y1={12} x2={-26} y2={20} stroke="#1f7a44" strokeWidth="1.5" />
                  <line x1={26} y1={12} x2={26} y2={20} stroke="#1f7a44" strokeWidth="1.5" />
                </>
              )}
              {shape === 'mat' && (
                <rect x={-30} y={-22} width={60} height={40} rx="4" fill="#fef3c7" stroke="#d97706" strokeWidth="1.5" strokeDasharray="4 3" />
              )}
              {shape === 'rect' && (
                <rect x={-30} y={-22} width={60} height={40} rx="4" fill="#fff" stroke="#1f7a44" strokeWidth="2.5" />
              )}
              <text x={0} y={2} textAnchor="middle" fontSize="9" fontWeight="bold" fill="#1f7a44">
                你的摊
              </text>
              <circle cx={0} cy={0} r="34" fill="transparent" />
              {active === 'stall' && (
                <rect x={-32} y={-24} width={64} height={46} rx="6" fill="none" stroke="#1f7a44" strokeWidth="1.5" strokeDasharray="3 3" opacity="0.8" />
              )}
            </g>
          </g>

          {/* 顾客起点 */}
          <g onPointerDown={onDown('from')} className="cursor-grab" style={{ touchAction: 'none' }}>
            <circle cx={from.x} cy={from.y} r={active === 'from' ? 17 : 15} fill="white" stroke="#1f7a44" strokeWidth="2" />
            <text x={from.x} y={from.y + 5} textAnchor="middle" fontSize="15">🚶</text>
            <text x={from.x} y={from.y - 21} textAnchor="middle" fontSize="9.5" fontWeight="700" fill="#1f7a44">从这来</text>
          </g>

          {/* 顾客终点 */}
          <g onPointerDown={onDown('to')} className="cursor-grab" style={{ touchAction: 'none' }}>
            <circle cx={to.x} cy={to.y} r={active === 'to' ? 17 : 15} fill="white" stroke="#6b7280" strokeWidth="2" />
            <text x={to.x} y={to.y + 5} textAnchor="middle" fontSize="15">🏁</text>
            <text x={to.x} y={to.y - 21} textAnchor="middle" fontSize="9.5" fontWeight="700" fill="#6b7280">往这去</text>
          </g>

          {/* 人流方向标签 */}
          <text
            x={(from.x + to.x) / 2}
            y={Math.min(from.y, to.y) - 10}
            textAnchor="middle" fontSize="10" fontWeight="700" fill="#1f7a44" opacity="0.85"
          >
            人流 {dirLabel}
          </text>
        </svg>
      </div>

      {/* 微调 */}
      <div className="mt-2 flex items-center justify-center gap-2">
        <button type="button" onClick={() => nudge(-12)} className="text-[11.5px] px-3 py-1.5 rounded-full bg-gray-100 text-gray-700 font-semibold hover:bg-gray-200 transition">
          ← 摊位往左
        </button>
        <button type="button" onClick={() => nudge(12)} className="text-[11.5px] px-3 py-1.5 rounded-full bg-gray-100 text-gray-700 font-semibold hover:bg-gray-200 transition">
          摊位往右 →
        </button>
      </div>

      {/* 结论：三个明确动作 */}
      <div className="mt-3 space-y-2">
        {analysis.actions.map((a, i) => (
          <div key={i} className={`flex items-start gap-2.5 rounded-xl border px-3 py-2.5 ${toneCls[a.tone]}`}>
            <span className={`flex-shrink-0 w-5 h-5 rounded-full text-[11px] font-black flex items-center justify-center ${toneIconCls[a.tone]}`}>
              {toneIcon[a.tone]}
            </span>
            <div className="min-w-0">
              <div className="text-[12.5px] font-bold text-gray-900 leading-snug">{a.title}</div>
              <div className="text-[11.5px] text-gray-600 leading-relaxed mt-0.5">{a.detail}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
