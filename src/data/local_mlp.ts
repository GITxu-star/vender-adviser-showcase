/**
 * 前端本地 Step Processor（轻量 MLP）
 *
 * 和后端 backend/processor.py 同构但去掉 RAG 依赖：
 *   - 特征工程（关键词匹配）：和后端完全一致
 *   - 7 步 handler：结构一致，知识库引用留空（前端没向量库）
 *
 * 触发时机：
 *   1. 后端 /api/process 可通 → 用后端结果（含 RAG 增强）
 *   2. 后端挂了 → 降级到这里（永远不会没 StepCard）
 */

import type { StepCard, Section } from './processor';
import type { SessionData } from './schema';

// ============================================================
// 1. 特征工程（和后端 _extract_features 完全同构）
// ============================================================

function extractFeatures(s: SessionData): Record<string, string> {
  const f: Record<string, string> = {};

  // 品类
  const sell = s.screen1.sellWhat || '';
  if (['烤串','炸','串','烧烤','肉'].some(k => sell.includes(k))) f.category = '小吃-烧烤类';
  else if (['水果','菜','蔬'].some(k => sell.includes(k))) f.category = '生鲜果蔬';
  else if (['奶茶','饮','水'].some(k => sell.includes(k))) f.category = '饮品';
  else if (['衣','饰','杂货','百货'].some(k => sell.includes(k))) f.category = '日用百货';
  else f.category = '其他';

  // 位置
  const where = s.screen1.whereSell || '';
  if (['夜市','夜'].some(k => where.includes(k))) f.location = '夜市';
  else if (['早市','菜市场'].some(k => where.includes(k))) f.location = '早市/菜市场';
  else if (['学校','大学'].some(k => where.includes(k))) f.location = '学校周边';
  else if (['街边','路'].some(k => where.includes(k))) f.location = '街边流动';
  else if (['商场','广场'].some(k => where.includes(k))) f.location = '商业广场';
  else f.location = '其他';

  // 时段
  const ts = s.screen1.timeSlot || '';
  if (['早','晨','早餐'].some(k => ts.includes(k))) f.time_slot = '早市';
  else if (['午','中','午餐'].some(k => ts.includes(k))) f.time_slot = '午间';
  else if (['夜','晚','晚餐'].some(k => ts.includes(k))) f.time_slot = '夜市';
  else if (['全天','都摆'].some(k => ts.includes(k))) f.time_slot = '全天候';
  else f.time_slot = f.location;

  // 天气/场地
  const w = s.screen1.weather || '';
  if (['露天','外面','户外'].some(k => w.includes(k))) f.venue = '露天';
  else if (['遮阳','棚'].some(k => w.includes(k))) f.venue = '有遮阳棚';
  else if (['室内','商场'].some(k => w.includes(k))) f.venue = '室内';
  else f.venue = '不确定';

  // 竞争
  const comp = s.screen1.competitors || '';
  if (['独门','唯一','没有'].some(k => comp.includes(k))) f.competitors = '独门生意';
  else if (['不多','少'].some(k => comp.includes(k))) f.competitors = '竞争少';
  else if (['多','好多','一堆'].some(k => comp.includes(k))) f.competitors = '竞争激烈';
  else f.competitors = '未填';

  // 价格带
  const p = parseFloat((s.screen1.price || '0').replace('元','').trim());
  if (!isNaN(p)) {
    if (p <= 5) f.price_band = '5元以下';
    else if (p <= 10) f.price_band = '5-10元';
    else f.price_band = '10元以上';
  } else f.price_band = '未填';

  // 招牌/摆法（基于 stall_type）
  const stall = s.screen1.stallType || '';
  if (['什么也不摆','靠老板吆喝','一张桌子上面放商品'].some(k => stall.includes(k))) f.has_sign = '无招牌';
  else if (['旁边放个广告牌','旁边安个大喇叭','价目表'].some(k => stall.includes(k))) f.has_sign = '有辅助广告';
  else f.has_sign = '有招牌';

  if (['四周被挡着看不见','什么也不摆'].some(k => stall.includes(k))) f.visibility = '商品不易看见';
  else f.visibility = '商品清楚可见';

  // 点位溢价
  const spot = s.screen1.spotType || '';
  if (['斑马线','路口转角','公园转角'].some(k => spot.includes(k))) f.location_premium = '⭐ 天然流量红利（转角 = 360° 人流）';
  else if (spot.includes('老片区')) f.location_premium = '⚠️ 存量萎缩（老片区住户在减少）';
  else if (spot.includes('热门街区')) f.location_premium = '🔥 流量充裕但竞争白热化';
  else if (spot.includes('校门口')) f.location_premium = '⏰ 强时段红利（上下学 1 小时窗口）';
  else if (spot.includes('地铁旁')) f.location_premium = '🚇 通勤流红利';
  else f.location_premium = '未判断';

  // 供需压力
  if (comp === '竞争激烈') f.supply_pressure = '🔴 供给过剩（你多我就少）';
  else if (comp === '竞争少') f.supply_pressure = '🟡 有空间';
  else if (comp === '独门生意') f.supply_pressure = '🟢 独占红利';
  else f.supply_pressure = '未判断';

  // 时间窗口
  if (spot.includes('校门口')) f.crowd_timing = '上学 7:00-8:30 / 放学 16:30-18:00';
  else if (spot.includes('地铁旁') || f.time_slot === '早市') f.crowd_timing = '通勤早高峰 7:00-9:00';
  else if (f.time_slot === '夜市') f.crowd_timing = '傍晚 17:30-20:30';
  else f.crowd_timing = f.time_slot;

  // 困境
  f.reasoning_input = s.screen1.myDifficulty ? `老板自述困境：${s.screen1.myDifficulty}` : '';

  return f;
}

// ============================================================
// 2. 每步独立 handler（7 步）
// ============================================================

function step1(s: SessionData, f: Record<string, string>): StepCard {
  const data_rows: [string, string][] = [
    ['品类', f.category],
    ['位置', f.location],
    ['价格带', f.price_band],
    ['竞争', f.competitors],
  ];
  if (s.screen1.spotType) data_rows.push(['点位', s.screen1.spotType.split('（')[0]]);
  if (s.screen1.myDifficulty) data_rows.push(['困境', s.screen1.myDifficulty.split('（')[0]]);

  const reasoning: string[] = [];
  if (f.location_premium !== '未判断') reasoning.push(`📍 点位判断：${f.location_premium}`);
  if (f.supply_pressure !== '未判断') reasoning.push(`⚖️ 供需压力：${f.supply_pressure}`);
  if (f.crowd_timing !== '未填') reasoning.push(`⏰ 顾客窗口：${f.crowd_timing}`);
  if (f.has_sign === '无招牌') reasoning.push('🔍 摆法问题：没招牌 → 路过的人 3 秒内判断"这是什么"的概率极低');
  if (f.visibility === '商品不易看见') reasoning.push('👀 陈列问题：商品被挡 → 第一眼吸引力不够');

  const direction: string[] = [];
  if (f.supply_pressure.startsWith('🔴')) direction.push('🔥 先别急加新品类，核心矛盾是"摊多客少"→ 想怎么从 10 家里让路人选你');
  else if (f.location_premium.startsWith('⚠️')) direction.push('🏃 老片区在萎缩 → 每周去 1-2 个新点位试试');
  else if (f.location_premium.startsWith('⭐') || f.supply_pressure.startsWith('🟢')) direction.push('🚀 有天然红利 → 趁摊位还没涌进来，把品牌标识立起来');
  if (f.has_sign === '无招牌' || f.visibility === '商品不易看见') direction.push('👁️ 第一件事：让路过的人一眼看见你卖什么（A4 纸手写招牌也行）');
  if (f.reasoning_input) direction.push(`💬 ${f.reasoning_input.replace('老板自述困境：','')} → 记下了`);
  if (!direction.length) direction.push('下一步看看顾客反应，就能更精准判断');

  const sections: Section[] = [
    { title: '📊 我看到的数据', type: 'kv', items: data_rows },
    { title: '🧠 我的推理（为什么这么判断）', type: 'tree', items: reasoning.length ? reasoning : ['你没填太多，先记下已有信息了'] },
    { title: '✅ 给你的初步方向', type: 'list', items: direction },
  ];

  return {
    card_type: 'vendor_profile', step: 1,
    title: '摊位画像 + 推理', emoji: '🛒',
    summary: `你在${f.location}卖${f.category}，推理见下方`,
    sections, tags: Object.values(f).slice(0, 4), knowledge_refs: [],
  };
}

function step2(s: SessionData, _f: Record<string, string>): StepCard {
  const a = s.screen2.customerAction || '';
  const l = s.screen2.customerLookAt || '';

  const links: Array<{problem:string, confidence:number}> = [];
  if (a.includes('看一眼就走') || a.includes('不看')) links.push({problem:'视觉吸引力不足', confidence:0.85});
  if (a.includes('走得快') || a.includes('路过')) links.push({problem:'没有停步理由', confidence:0.75});
  if (a.includes('看了又走') || a.includes('犹豫')) links.push({problem:'价格/品质不确定', confidence:0.70});
  if (a.includes('看手机')) links.push({problem:'被注意力分散', confidence:0.50});
  if (!links.length) links.push({problem:'观察不够', confidence:0.30});

  return {
    card_type: 'customer_graph', step: 2,
    title: '顾客行为图谱', emoji: '👀',
    summary: `顾客${a || '行为待观察'}，注意力在${l || '不明'}`,
    sections: [
      { title: '顾客行为', type: 'kv', items: [['典型动作', a || '未填'], ['一般先看', l || '未填']] },
      { title: '可能的问题方向', type: 'confidence', items: links },
    ],
    tags: links.slice(0,2).map(x=>x.problem), knowledge_refs: [],
  };
}

function step3(s: SessionData, f: Record<string, string>): StepCard {
  const j = s.judgment?.mainProblem || '';
  const tree = j ? j.split('\n').map(l=>l.trim()).filter(l=>l.length>3) : [`可能是${f.category}在${f.location}吸引力不够`];

  return {
    card_type: 'diagnosis_report', step: 3,
    title: '诊断报告', emoji: '🔍',
    summary: `主要问题：${tree[0]}`,
    sections: [
      { title: '问题树（根因分析）', type: 'tree', items: tree },
      { title: '诊断依据', type: 'list', items: [`摊位：${f.category} @ ${f.location}`, `摆法：${f.has_sign} / ${f.visibility}`] },
    ],
    tags: tree.slice(0,2), knowledge_refs: [],
  };
}

function step4(s: SessionData, f: Record<string, string>): StepCard {
  const sol = s.solution?.doWhat || '';
  const actions = sol ? sol.split('\n').map(l=>l.trim()).filter(l=>l.length>2 && l.length<50).slice(0,3) : ['先填完诊断，AI 才能给具体方案'];
  const cost = f.competitors === '竞争激烈' ? '50-100 元' : (f.category.includes('烧烤') ? '20-50 元' : '10-30 元');
  const time = f.location === '夜市' ? '15-30 分钟' : '20 分钟';

  return {
    card_type: 'solution_crafted', step: 4,
    title: '方案加工', emoji: '📦',
    summary: `今晚花${cost}，${time}做完`,
    sections: [
      { title: '今晚就做这一件', type: 'list', items: actions },
      { title: '成本预估', type: 'kv', items: [['花费', cost], ['耗时', time], ['退路', '大不了收摊，没库存风险']] },
    ],
    tags: actions.slice(0,2), knowledge_refs: [],
  };
}

function step5(_s: SessionData, f: Record<string, string>): StepCard {
  let metrics: string[] = [];
  if (f.category.includes('烧烤') || f.category.includes('小吃'))
    metrics = ['数 5 分钟内看一眼就走的人', '数停下来问的人', '数成交单数'];
  else if (f.category.includes('饮品'))
    metrics = ['数路过不停的人', '数停下来看菜单的', '数成交杯数'];
  else
    metrics = ['数路过的人', '数停下来看的', '数买的人'];

  return {
    card_type: 'measure_metric', step: 5,
    title: '测量指标', emoji: '📏',
    summary: '明天数 3 个数，就知道有没有用',
    sections: [
      { title: '明天要数这几个', type: 'list', items: metrics },
      { title: '判断有用没用', type: 'list', items: ['✅ 停下来看的多了 → 有用', '❌ 看一眼就走还是那么多 → 没用'] },
    ],
    tags: metrics.slice(0,2), knowledge_refs: [],
  };
}

function step6(_s: SessionData, _f: Record<string, string>): StepCard {
  return {
    card_type: 'action_log', step: 6,
    title: '执行记录', emoji: '✅',
    summary: '做完勾一下，明儿回来看效果',
    sections: [
      { title: '做完了吗？', type: 'list', items: ['点下面「我做完了」按钮 → 系统会记下来', '明天看屏 7 回来看结果'] },
    ],
    tags: [], knowledge_refs: [],
  };
}

function step7(_s: SessionData, f: Record<string, string>): StepCard {
  return {
    card_type: 'effect_review', step: 7,
    title: '效果复盘', emoji: '📊',
    summary: '有用就加深，没用就换方向',
    sections: [
      { title: '复盘逻辑', type: 'list', items: [
        '停下来的人多了 → 方案有效 → 继续加深',
        '看一眼就走还是那么多 → 方案无效 → 换方向',
        '买的人多但利润没涨 → 定价/成本有问题',
      ] },
      { title: '你的摊位', type: 'list', items: [`${f.category} @ ${f.location}`] },
    ],
    tags: [], knowledge_refs: [],
  };
}

// ============================================================
// 主入口
// ============================================================

const handlers: Record<number, (s: SessionData, f: Record<string, string>) => StepCard> = {
  1: step1, 2: step2, 3: step3, 4: step4, 5: step5, 6: step6, 7: step7,
};

export function localProcessStep(step: number, session: SessionData): StepCard {
  const features = extractFeatures(session);
  const h = handlers[step] || step1;
  return h(session, features);
}
