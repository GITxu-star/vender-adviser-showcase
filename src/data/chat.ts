import type { SessionData } from './schema';

// 根据当前问卷上下文 + 用户消息生成 AI 回复（Mock）
export function chatReply(userMsg: string, session: SessionData): string {
  const msg = userMsg.trim();
  const s1 = session.screen1;
  const s2 = session.screen2;

  // 简单的意图匹配 + 结合上下文

  // 问候
  if (/^(你好|hi|hello|在吗|嗨)/i.test(msg)) {
    const greet = !s1.sellWhat
      ? '你好！我是你的地摊顾问。先把左边的基本情况填一下，我好更准地帮你。当然你也可以直接跟我聊，说什么都行。'
      : `你好！看到你在做「${s1.sellWhat}」，在${s1.whereSell || '某个地方'}卖。想聊点什么？`;
    return greet;
  }

  // 当前进度
  if (/做到哪|填完了吗|进度|现在/.test(msg)) {
    return `现在在第 ${session.screenNum} 步。${progressHint(session)}`;
  }

  // 问 AI 判断 / 建议
  if (/建议|判断|怎么办|帮我想想|我该/.test(msg)) {
    if (session.judgment) {
      return `之前给你的判断是：「${session.judgment.mainProblem}」。\n\n核心：${session.judgment.howToFix}\n\n要重新判断的话，回屏 2 改改顾客反应那边的选项，或者直接告诉我「不对，换个方向」。`;
    }
    if (!s1.sellWhat) {
      return '你现在这屏我还没看到「卖什么」。你填上卖什么、在哪卖，我马上就能判断这个组合成不成立。';
    }
    // 第 1-2 步：直接反馈这一屏看到的，而不是让你"先填完"
    const bits = [`你在${s1.whereSell || '某处'}卖${s1.sellWhat}`];
    if (s1.timeSlot) bits.push(`${s1.timeSlot}时段`);
    if (s1.myDifficulty) bits.push(`你现在的困境是「${s1.myDifficulty}」`);
    if (s2.customerAction) bits.push(`顾客一般是「${s2.customerAction}」`);
    return `${bits.join('，')}。\n\n这一步我先给你画像和定位（见上面的卡片）。你把顾客走到摊前那几项补上，我就能判断问题卡在「看见→停下→问价→下单」哪一环。`;
  }

  // 问方案
  if (/怎么做|具体做|方案|今晚做/.test(msg)) {
    if (session.solution) {
      return `今晚就做这个：\n\n${session.solution.doWhat}\n\n花费：${session.solution.costAndTime}\n退路：${session.solution.revertPlan}`;
    }
    const now = s2.customerAction
      ? `现在已看到「顾客${s2.customerAction}」——问题大概卡在"停下/问价"这一段。`
      : '现在还没看到顾客走到摊前是什么反应。';
    return `${now}\n\n顺着这条链走：第 3 步我给诊断（卡在哪一环），第 4 步才给今晚能动手的那一件具体事。`;
  }

  // 抱怨 / 诉苦
  if (/没人|生意差|卖不动|亏|难/.test(msg)) {
    const base = !s1.sellWhat ? '我理解。先告诉我你卖什么、在哪卖，咱们对症下药。' :
      `「${s1.sellWhat}」在${s1.whereSell || '...'}卖，一天${s1.dailyQty || '...'}份，确实不容易。`;
    const extra = s2.customerAction
      ? `顾客一般是「${s2.customerAction}」——这是个很关键的信号。走到第 3 步我给你拆解。`
      : '顾客走到你摊前一般什么反应？填到第 2 步那个地方，我就能帮你分析了。';
    return base + '\n\n' + extra;
  }

  // 没填就问：给出这一屏能说的
  if (!s1.sellWhat && session.screenNum === 1) {
    return '这一步我还没法给你画像——你卖什么、在哪卖？填个大概就行（比如"烤串 / 夜市街边"），我立刻给你这个组合成不成立。';
  }

  // 默认：结合当前上下文说点有用的
  const contextBits: string[] = [];
  if (s1.sellWhat) contextBits.push(`你在做「${s1.sellWhat}」`);
  if (s1.whereSell) contextBits.push(`在${s1.whereSell}`);
  if (s1.dailyQty) contextBits.push(`一天卖${s1.dailyQty}`);
  if (s2.customerAction) contextBits.push(`顾客一般${s2.customerAction}`);

  const contextLine = contextBits.length > 0
    ? `你现在这屏的情况：${contextBits.join('、')}。\n\n`
    : '';

  const generic = [
    '说说看，你现在最愁的是什么？',
    '或者你也可以问我：「我该先改什么？」「给我个今晚能做的事」。',
    '别客气，随便聊。',
  ][Math.floor(Math.random() * 3)];

  return contextLine + generic;
}

function progressHint(s: SessionData): string {
  const hints: Record<number, string> = {
    1: '填左边的基本情况（卖什么、在哪卖、卖多少）',
    2: '选顾客的反应——单选 + 多选',
    3: '看 AI 判断对不对，认了就下一步',
    4: '挑今晚要做的一件事',
    5: '记住明天怎么看效果',
    6: '点一下「我做完了」',
    7: '回来看结果，闭环',
  };
  return hints[s.screenNum] ?? '';
}

// 首次打开 AI 对话时的欢迎语
export function welcomeMessage(session: SessionData): string {
  if (session.screenNum <= 1 && !session.screen1.sellWhat) {
    return '👋 你好！我是地摊顾问。填左边的问卷我能更准地帮你，或者你也可以直接跟我聊。';
  }
  return '👋 有什么想聊的？';
}
