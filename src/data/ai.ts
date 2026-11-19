import type { AiJudgment, AiSolution, SessionData } from './schema';

// ===== Mock AI：根据用户填的数据生成屏 3-5 的内容 =====
// 真实产品这里会调 LLM API

export function generateJudgment(d: SessionData): AiJudgment {
  const s1 = d.screen1;
  const s2 = d.screen2;

  // 根据顾客反应推断核心问题
  let mainProblem = '';
  if (s2.customerAction === '看一眼就走' || s2.customerAction === '压根没走近') {
    mainProblem = '路过的人根本注意不到你在卖什么——招牌/展示没吸住人';
  } else if (s2.customerAction === '问价就走') {
    mainProblem = '顾客在价格这一步打退堂鼓——要么贵了，要么觉得不值';
  } else if (s2.customerAction === '停下来看了' || s2.customerAction === '直接买') {
    mainProblem = '有人停，但停得不够久——让人多停 3 秒就能多卖几份';
  } else {
    mainProblem = '先搞清楚为什么没人来——从「路过的人」的视角重新审视你的摊位';
  }

  // 次要矛盾：把用户多选的「觉得哪不对」列进去
  const secondary = s2.selfFeelWrong.length > 0
    ? `（次要矛盾：${s2.selfFeelWrong.join('、')}）`
    : '';

  // 为什么是它
  const whyParts: string[] = [];
  whyParts.push(`你说顾客「${s2.customerAction || '没填'}」`);
  if (s2.customerLookAt.length > 0) {
    whyParts.push(`顾客先看的是${s2.customerLookAt.join('、')}`);
  }
  whyParts.push(`你自己觉得${s2.selfFeelWrong.join('、') || '还需要再观察一下'}`);
  whyParts.push(`现在一份 ${s1.price || '?'} 元、一天卖 ${s1.dailyQty || '?'}，${s1.stallFixed || '摊位状态未知'}`);

  // 怎么解决
  let howToFix = '';
  if (mainProblem.includes('注意不到')) {
    howToFix = '把「一眼看明白你卖什么」的视觉信号放大 3 倍——招牌、实物展示、价格牌，今晚就能动起来';
  } else if (mainProblem.includes('价格')) {
    howToFix = '价格不变，但让顾客觉得「值」——把食材、做法、份量摆出来说清楚';
  } else {
    howToFix = '让停下的人多站一会儿、多看一下——他看得越久，掏钱的概率越高';
  }

  // 从哪些方面解决
  let angles = '';
  if (mainProblem.includes('注意不到')) {
    angles = '招牌文字大小 / 锅里或摊上的实物展示 / 价签是否醒目';
  } else if (mainProblem.includes('价格')) {
    angles = '价签上写清楚「为什么值这个价」/ 实物展示份量 / 旁边摆一个小份做对比';
  } else {
    angles = '出餐速度 / 顾客拿在手里的体验 / 是否有试吃或小赠品';
  }

  // 先别管什么
  const skipForNow = '品牌名、Logo、精美海报——这些得等基础人流问题解决了才有用';

  return {
    mainProblem: mainProblem + secondary,
    why: whyParts.join('；'),
    howToFix,
    angles,
    skipForNow,
  };
}

// 根据屏 3 判断生成屏 4 方案
export function generateSolution(d: SessionData): AiSolution {
  const j = d.judgment;
  if (!j) return { doWhat: '', costAndTime: '', revertPlan: '' };

  const p = j.mainProblem;

  if (p.includes('注意不到')) {
    const item = (d.screen1?.sellWhat || '').trim() || '你卖的东西';
    return {
      doWhat: `找一张大纸（A3 以上），用马克笔写清楚：你在卖${item}。字要大到 20 步外能看清，贴在摊位正上方或正前方。\n再把今天最拿得出手的那份${item}摆到最前面，让路过的人一眼看到你在卖什么。`,
      costAndTime: '纸 + 马克笔 = 5-10 元；15 分钟搞定',
      revertPlan: '不想贴了就撕下来，纸扔了就行，摊位位置随时推回去',
    };
  }

  if (p.includes('价格')) {
    return {
      doWhat: '找一张纸写清楚：「为什么值这个价」。比如烤串就写「当天鲜肉 · 现烤现做 · 不隔夜」；炒饭就写「3 两米 · 两个蛋 · 足量」。贴在价签旁边。',
      costAndTime: '纸 + 马克笔 = 5 元；10 分钟搞定',
      revertPlan: '撕下来就行',
    };
  }

  return {
    doWhat: '先做一件小事：出一份餐的时候，跟顾客多说一句「要不要加点辣？」或者「要不要再来一份带走？」，看看会不会有人多要。',
    costAndTime: '0 元；就是改一下说话的习惯',
    revertPlan: '不说就行，随时停',
  };
}

// 屏 5：给一句能数得出来的话
export function generateMeasureTip(d: SessionData): string {
  const j = d.judgment;
  if (!j) return '看看今晚顾客是不是停下来了';

  const p = j.mainProblem;

  if (p.includes('注意不到')) {
    return '10 个路过的人里，至少 4 个停下来看一眼招牌或你的摊位';
  }
  if (p.includes('价格')) {
    return '10 个问价的人里，至少 3 个愿意停下来听你说两句再决定';
  }
  return '今天卖出的份数，比昨天多 5 份就算有变化';
}

// 屏 3 用户不认时重新生成（换个方向）
export function regenerateJudgment(d: SessionData, reason: string): AiJudgment {
  const original = generateJudgment(d);
  // 简单换说法，模拟 AI 重新判断
  const prefixMap: Record<string, string> = {
    '不是这个问题': '换个方向——也许核心问题根本不是这个。',
    '太贵了': '那先不花钱，换一个零成本的方向。',
    '做不到': '好，收一收，来一个你今晚一定能做成的。',
    '看不懂': '说人话版本——',
  };
  const prefix = prefixMap[reason] || '换一个角度——';
  return {
    ...original,
    mainProblem: prefix + original.mainProblem,
  };
}
