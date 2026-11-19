import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../store/useStore';

const CACHE_PREFIX = 'vendor-advisor:vis3:';

type Product = { name: string; icon: string; shape?: string; img?: string };
type Layout = { pyramid: boolean; front_bias: number; sign_scale: number; rows: number };
type Scene = {
  base_image?: string;
  products: Product[];
  layout: Layout;
  before_layout: Layout;
  sign_text: string;
  price_text: string;
  tips: string[];
};

const SIZE = 1024;

export default function VisualSim() {
  const [scene, setScene] = useState<Scene | null>(null);
  const [mode, setMode] = useState<'before' | 'after'>('after');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const didRunRef = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const navigate = useNavigate();
  const screen1 = useStore(s => s.screen1);
  const API_BASE = (import.meta as any).env?.VITE_API_BASE || 'http://localhost:8000/api';

  const stallFilled = !!(screen1.stallType && screen1.stallType !== '未填' && !screen1.stallType.startsWith('未填'));
  const sellFilled = !!(screen1.sellWhat && screen1.sellWhat !== '未填' && screen1.sellWhat.length >= 2);
  const canGenerate = stallFilled && sellFilled;

  const generate = async (force = false) => {
    if (!canGenerate) return;

    const currentInput = JSON.stringify({
      sw: screen1.sellWhat, ws: screen1.whereSell,
      st: screen1.stallType, ts: screen1.timeSlot, we: screen1.weather,
    });
    const cachedRaw = localStorage.getItem(CACHE_PREFIX + 'last-input');
    const cachedScene = localStorage.getItem(CACHE_PREFIX + 'last-scene');
    if (!force && cachedRaw === currentInput && cachedScene) {
      try {
        setScene(JSON.parse(cachedScene));
        return;
      } catch { /* 缓存坏了就重新生成 */ }
    }

    setLoading(true);
    setError(null);
    try {
      const storeNow = useStore.getState();
      const res = await fetch(`${API_BASE}/visualize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: storeNow }),
      });
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(`${res.status}: ${detail.slice(0, 120)}`);
      }
      const data = await res.json();
      const s: Scene = {
        base_image: data.base_image || data.image_url,
        products: data.products || [{ name: screen1.sellWhat, icon: '🍢' }],
        layout: data.layout || { pyramid: true, front_bias: 0.8, sign_scale: 1.25, rows: 3 },
        before_layout: data.before_layout || { pyramid: false, front_bias: 0.3, sign_scale: 0.85, rows: 1 },
        sign_text: data.sign_text || '',
        price_text: data.price_text || '',
        tips: data.tips || [],
      };
      setScene(s);
      try {
        localStorage.setItem(CACHE_PREFIX + 'last-input', currentInput);
        localStorage.setItem(CACHE_PREFIX + 'last-scene', JSON.stringify(s));
      } catch { /* 超出配额就不缓存 */ }
    } catch (e: any) {
      setError(e.message || '生成失败');
    } finally {
      setLoading(false);
    }
  };

  // 进入屏 3 → 自动触发一次
  useEffect(() => {
    if (!canGenerate) return;
    if (didRunRef.current) return;
    didRunRef.current = true;
    const t = setTimeout(() => generate(), 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen1.stallType, screen1.sellWhat]);

  // 场景 / 视角变化 → 重绘（纯 Canvas 示意图，不再依赖底图）
  useEffect(() => {
    if (scene) draw(canvasRef.current, scene, mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, mode]);

  const download = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = `摊位示意-${mode === 'before' ? '改前' : '改后'}.png`;
    a.click();
  };

  // 缺字段时不要整块消失（PC 上填过、手机上没填时会像"功能没了"），改为说清楚缺什么
  if (!canGenerate) {
    const missing = [
      !sellFilled ? '「卖什么」' : '',
      !stallFilled ? '「你的摊属于哪种情形」' : '',
    ].filter(Boolean).join('、');
    return (
      <div className="mt-5 rounded-3xl bg-gradient-to-br from-mint-50 to-white p-5 border border-mint-100 shadow-sm">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-lg">🎨</span>
          <span className="font-semibold text-mint-800">摊位改造示意图</span>
        </div>
        <p className="text-[13px] text-gray-500 leading-relaxed">
          还差 {missing} 没填（在屏 1 的「摊位情形 / 时段 / 困境」折叠区里），填完这里会自动画出「改前 / 改后」的摆法示意。
        </p>
        <button
          type="button"
          onClick={() => navigate('/screen/1')}
          className="mt-3 text-[13px] font-bold px-4 py-2 rounded-xl text-white shadow-pop active:scale-95 transition"
          style={{ backgroundImage: 'linear-gradient(to bottom right, #1f7a44, #176338)' }}
        >
          去补齐
        </button>
      </div>
    );
  }

  return (
    <div className="mt-5 rounded-3xl bg-gradient-to-br from-mint-50 to-white p-5 border border-mint-100 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-lg">🎨</span>
          <span className="font-semibold text-mint-800">摊位改造示意图</span>
        </div>
        <button
          onClick={() => generate(true)}
          disabled={loading}
          className="text-xs px-3 py-1 rounded-full bg-mint-100 text-mint-700 hover:bg-mint-200 disabled:opacity-50"
        >
          {loading ? '生成中...' : '🔁 重算示意'}
        </button>
      </div>

      {loading && (
        <div className="aspect-square rounded-2xl bg-white border border-mint-100 flex items-center justify-center overflow-hidden">
          <div className="flex flex-col items-center gap-3">
            <div className="w-10 h-10 rounded-full border-3 border-mint-200 border-t-mint-600 animate-spin" />
            <span className="text-sm text-mint-700">在按你的方案算摆法…</span>
            <span className="text-xs text-mint-500">招牌、商品位置、价格牌都会标出来</span>
          </div>
        </div>
      )}

      {error && !loading && (
        <div className="aspect-square rounded-2xl bg-white border border-red-200 flex flex-col items-center justify-center gap-2 p-6 text-center">
          <span className="text-3xl">😅</span>
          <span className="text-sm text-red-600">生成失败</span>
          <span className="text-xs text-gray-500 break-all">{error}</span>
          <button
            onClick={() => generate(true)}
            className="mt-2 px-4 py-1.5 rounded-full bg-mint-600 text-white text-sm hover:bg-mint-700"
          >
            再试一次
          </button>
        </div>
      )}

      {scene && !loading && !error && (
        <div>
          <div className="flex items-center gap-2 mb-2">
            {(['before', 'after'] as const).map(k => (
              <button
                key={k}
                type="button"
                onClick={() => setMode(k)}
                style={
                  mode === k
                    ? { backgroundImage: 'linear-gradient(to bottom right, #1f7a44, #176338)', color: '#fff' }
                    : { background: '#f1f5f3', color: '#4b5563' }
                }
                className="flex-1 py-1.5 rounded-full text-[12px] font-bold transition-all active:scale-[0.98]"
              >
                {k === 'before' ? '改前：现在这样' : '改后：按方案摆'}
              </button>
            ))}
          </div>

          <canvas
            ref={canvasRef}
            width={SIZE}
            height={SIZE}
            className="w-full rounded-2xl shadow-md border border-mint-100 bg-white"
          />

          <div className="mt-2 flex items-center justify-between">
            <span className="text-[11px] text-gray-400">
              {mode === 'before'
                ? '现在：东西散着、靠后、招牌小'
                : '照着图摆：① 招牌 ② 商品位置 ③ 价格牌'}
            </span>
            <button
              type="button"
              onClick={download}
              className="text-[11px] px-2.5 py-1 rounded-full bg-mint-100 text-mint-700"
            >
              ⬇️ 保存这张
            </button>
          </div>

          {scene.tips.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              <span className="text-[11px] text-gray-500 mr-1">AI 建议的陈列：</span>
              {scene.tips.map((t, i) => (
                <span key={i} className="text-[11px] px-2 py-0.5 rounded-full bg-mint-50 text-mint-600 border border-mint-100">
                  ✓ {t}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ============ 绘制：等距示意图（不用照片贴图） ============

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const CN_FONT = '"PingFang SC","Microsoft YaHei","Heiti SC",sans-serif';
const EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';

function draw(canvas: HTMLCanvasElement | null, s: Scene, m: 'before' | 'after') {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const isAfter = m === 'after';
  const L = isAfter ? s.layout : s.before_layout;

  ctx.clearRect(0, 0, SIZE, SIZE);
  drawBackground(ctx);
  drawSignPost(ctx, L.sign_scale, isAfter);
  drawCounter(ctx);
  drawPriceBoard(ctx, s.price_text, isAfter);
  drawProducts(ctx, s.products, L, isAfter);
  drawSign(ctx, s.sign_text, s.price_text, L.sign_scale, isAfter);
  if (isAfter) drawAnnotations(ctx, s, L);
  drawCaption(ctx, s, isAfter);
}

function drawBackground(ctx: CanvasRenderingContext2D) {
  const g = ctx.createLinearGradient(0, 0, 0, SIZE);
  g.addColorStop(0, '#faf6ee');
  g.addColorStop(0.58, '#f0e7d6');
  g.addColorStop(1, '#ded0b8');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, SIZE, SIZE);

  // 远处街道横带
  ctx.fillStyle = 'rgba(160,148,128,0.20)';
  ctx.fillRect(0, 470, SIZE, 46);
  ctx.fillStyle = 'rgba(120,110,95,0.14)';
  for (let i = 0; i < 7; i++) {
    const x = 60 + i * 150;
    ctx.fillRect(x, 470, 8, 46);
  }

  // 地面透视横线（越近越疏）
  ctx.strokeStyle = 'rgba(130,112,90,0.13)';
  ctx.lineWidth = 2;
  for (let i = 1; i <= 6; i++) {
    const t = i / 7;
    const y = 520 + t * t * 470;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(SIZE, y);
    ctx.stroke();
  }
  // 摊位脚下阴影
  const sh = ctx.createRadialGradient(SIZE / 2, 812, 40, SIZE / 2, 812, 470);
  sh.addColorStop(0, 'rgba(80,62,44,0.30)');
  sh.addColorStop(1, 'rgba(80,62,44,0)');
  ctx.fillStyle = sh;
  ctx.beginPath();
  ctx.ellipse(SIZE / 2, 818, 470, 78, 0, 0, Math.PI * 2);
  ctx.fill();
}

/** 台面几何：远窄近宽，模拟等距透视 */
const TOP = { farY: 556, nearY: 706, farL: 296, farR: 728, nearL: 164, nearR: 860 };

function drawCounter(ctx: CanvasRenderingContext2D) {
  const { farY, nearY, farL, farR, nearL, nearR } = TOP;

  // 桌面前立面（木板）
  const g = ctx.createLinearGradient(0, nearY, 0, nearY + 150);
  g.addColorStop(0, '#a06a3f');
  g.addColorStop(0.55, '#8a5530');
  g.addColorStop(1, '#5d371d');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(nearL, nearY);
  ctx.lineTo(nearR, nearY);
  ctx.lineTo(nearR - 14, nearY + 148);
  ctx.lineTo(nearL + 14, nearY + 148);
  ctx.closePath();
  ctx.fill();

  // 桌面板厚（前沿）
  ctx.fillStyle = '#c08a55';
  roundRect(ctx, nearL - 8, nearY - 10, (nearR - nearL) + 16, 26, 8);
  ctx.fill();

  // 桌面（梯形，越远越窄）
  const gt = ctx.createLinearGradient(0, farY, 0, nearY);
  gt.addColorStop(0, '#e2bc8b');
  gt.addColorStop(1, '#d0a273');
  ctx.fillStyle = gt;
  ctx.beginPath();
  ctx.moveTo(farL, farY);
  ctx.lineTo(farR, farY);
  ctx.lineTo(nearR, nearY);
  ctx.lineTo(nearL, nearY);
  ctx.closePath();
  ctx.fill();

  // 桌面木纹（沿透视方向）
  ctx.strokeStyle = 'rgba(120,80,45,0.18)';
  ctx.lineWidth = 2;
  for (let i = 1; i <= 3; i++) {
    const t = i / 4;
    const x1 = farL + (farR - farL) * t;
    const x2 = nearL + (nearR - nearL) * t;
    ctx.beginPath();
    ctx.moveTo(x1, farY);
    ctx.lineTo(x2, nearY);
    ctx.stroke();
  }
}

/** 招牌后立柱 */
function drawSignPost(ctx: CanvasRenderingContext2D, scale: number, isAfter: boolean) {
  const w = Math.min(SIZE * 0.46 * scale, SIZE * 0.82);
  const x = (SIZE - w) / 2;
  const bottom = isAfter ? TOP.farY + 6 : TOP.farY - 10;
  ctx.fillStyle = '#8a6a4a';
  [x + w * 0.18, x + w * 0.82].forEach(px => {
    ctx.fillRect(px - 9, 210, 18, Math.max(40, bottom - 210));
  });
}

function drawSign(ctx: CanvasRenderingContext2D, signText: string, priceText: string, scale: number, isAfter: boolean) {
  if (!signText) return;
  const bw = Math.min(SIZE * 0.46 * scale, SIZE * 0.82);
  const bh = Math.min(150 * scale, 190);
  const x = (SIZE - bw) / 2;
  const y = 104;

  ctx.save();
  ctx.shadowColor = 'rgba(60,40,25,0.30)';
  ctx.shadowBlur = 22;
  ctx.shadowOffsetY = 8;
  roundRect(ctx, x, y, bw, bh, 16);
  ctx.fillStyle = '#fffaf0';
  ctx.fill();
  ctx.restore();

  ctx.lineWidth = isAfter ? 8 : 5;
  ctx.strokeStyle = isAfter ? '#b45309' : '#9ca3af';
  roundRect(ctx, x, y, bw, bh, 16);
  ctx.stroke();

  const text = signText.replace(/\s*\n\s*/g, ' ').trim();
  const maxW = bw - 34;
  const hasPrice = !!priceText && priceText !== text;
  let fs = bh * (hasPrice ? 0.42 : 0.5);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = isAfter ? '#7c2d12' : '#4b5563';
  const fontOf = (n: number) => `900 ${Math.round(n)}px ${CN_FONT}`;
  do {
    ctx.font = fontOf(fs);
    fs -= 2;
  } while (ctx.measureText(text).width > maxW && fs > 22);

  ctx.fillText(text, x + bw / 2, y + bh * (hasPrice ? 0.4 : 0.5));
  if (hasPrice) {
    ctx.font = fontOf(bh * 0.26);
    ctx.fillStyle = isAfter ? '#b45309' : '#6b7280';
    ctx.fillText(priceText, x + bw / 2, y + bh * 0.76);
  }
}

/** 桌面上的小价格牌 */
function drawPriceBoard(ctx: CanvasRenderingContext2D, priceText: string, isAfter: boolean) {
  if (!priceText) return;
  const w = isAfter ? 176 : 118;
  const h = isAfter ? 118 : 86;
  const cx = isAfter ? 792 : 806;
  const cy = isAfter ? 606 : 622;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-0.1);
  ctx.shadowColor = 'rgba(60,40,25,0.28)';
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 6;
  roundRect(ctx, -w / 2, -h / 2, w, h, 10);
  ctx.fillStyle = '#fffdf6';
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-0.1);
  ctx.lineWidth = 4;
  ctx.strokeStyle = isAfter ? '#16a34a' : '#9ca3af';
  roundRect(ctx, -w / 2, -h / 2, w, h, 10);
  ctx.stroke();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = isAfter ? '#15803d' : '#4b5563';
  ctx.font = `900 ${Math.round(h * 0.4)}px ${CN_FONT}`;
  ctx.fillText(priceText.length > 6 ? priceText.slice(0, 6) : priceText, 0, 0);
  ctx.restore();
}

function drawProducts(ctx: CanvasRenderingContext2D, products: Product[], L: Layout, isAfter: boolean) {
  if (!products.length) return;
  const { farY, nearY, farL, farR, nearL, nearR } = TOP;

  const rows = isAfter ? Math.max(2, Math.min(3, L.rows)) : 1;
  const rowYs = rows === 1 ? [nearY - 58] : [farY + 40, (farY + nearY) / 2 + 6, nearY - 30];
  const rowSize = rows === 1 ? [66] : [62, 78, 94];

  for (let r = rows - 1; r >= 0; r--) {
    const y = rowYs[r];
    const size = (rowSize[r] || 70) * (0.92 + L.front_bias * 0.16);
    const t = (y - farY) / (nearY - farY);
    const l = farL + (nearL - farL) * t;
    const rr = farR + (nearR - farR) * t;
    const span = (rr - l) * (isAfter ? 0.78 : 0.5);
    const count = isAfter ? Math.max(2, 5 - r) : 3;
    const step = count > 1 ? span / (count - 1) : 0;

    for (let i = 0; i < count; i++) {
      const x = count > 1 ? (SIZE / 2 - span / 2) + i * step : SIZE / 2;
      const p = products[(i + r) % products.length];

      // 桌面投影
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(x, y + size * 0.36, size * 0.40, size * 0.12, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(70,48,28,0.30)';
      ctx.fill();
      ctx.restore();

      drawProductIcon(ctx, x, y, size, p);
    }
  }
}

/** 统一风格的品类插画：emoji + 底托，不用实拍照片 */
function drawProductIcon(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, p: Product) {
  const icon = p.icon || '🥡';
  // 小托盘
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(x, y + s * 0.26, s * 0.42, s * 0.13, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#f8f3e8';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(150,110,70,0.45)';
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `${Math.round(s)}px ${EMOJI_FONT}`;
  ctx.fillText(icon, x, y - s * 0.12);
  ctx.restore();
}

/** 编号说明：图上不再到处拉线，统一放在底部说明条，避免挡住商品 */
function drawAnnotations(ctx: CanvasRenderingContext2D, s: Scene, L: Layout) {
  const sell = (s.products[0]?.name || s.sign_text || '你的招牌货').slice(0, 8);
  const lines: [string, string][] = [
    ['1', `招牌：写清「${sell}」，字要 20 步外能看清`],
    ['2', '商品：往前推 30cm，堆成金字塔（前低后高）'],
    ['3', '价格牌：朝外摆，数字写大，别用手写小字'],
  ];

  const boxX = 24;
  const boxY = 824;
  const boxW = Math.min(704, SIZE - 48);
  const lineH = 52;
  const padY = 22;
  const boxH = lines.length * lineH + padY * 2;

  ctx.save();
  ctx.shadowColor = 'rgba(20,60,35,0.18)';
  ctx.shadowBlur = 16;
  ctx.shadowOffsetY = 5;
  roundRect(ctx, boxX, boxY, boxW, boxH, 18);
  ctx.fillStyle = 'rgba(255,255,255,0.97)';
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(22,163,74,0.5)';
  roundRect(ctx, boxX, boxY, boxW, boxH, 18);
  ctx.stroke();

  lines.forEach(([num, text], i) => {
    const cy = boxY + padY + lineH * i + lineH / 2;
    ctx.beginPath();
    ctx.arc(boxX + 40, cy, 19, 0, Math.PI * 2);
    ctx.fillStyle = '#16a34a';
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 24px ${CN_FONT}`;
    ctx.fillText(num, boxX + 40, cy + 1);

    ctx.fillStyle = '#14532d';
    ctx.textAlign = 'left';
    ctx.font = `700 24px ${CN_FONT}`;
    let str = text;
    while (ctx.measureText(str).width > boxW - 92 && str.length > 6) {
      str = str.slice(0, -2);
    }
    ctx.fillText(str, boxX + 74, cy + 1);
  });
  ctx.restore();
  void L;
}

function drawCaption(ctx: CanvasRenderingContext2D, s: Scene, isAfter: boolean) {
  const label = isAfter ? `按方案摆 · ${s.products.map(p => p.name).slice(0, 2).join(' / ')}` : '现在这样';
  ctx.save();
  ctx.font = `700 24px ${CN_FONT}`;
  const tw = ctx.measureText(label).width;
  roundRect(ctx, 24, 24, tw + 34, 48, 24);
  ctx.fillStyle = 'rgba(17,24,39,0.72)';
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 41, 49);

  ctx.font = `500 20px ${CN_FONT}`;
  ctx.fillStyle = 'rgba(90,80,68,0.75)';
  ctx.textAlign = 'right';
  ctx.fillText('示意图，不是实拍', SIZE - 26, 48);
  ctx.restore();
}
