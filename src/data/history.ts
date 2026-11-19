import type { ChatMessage, EffectResult, SessionData } from './schema';

export interface RoundRecord {
  id: string;
  createdAt: number;
  sellWhat: string;
  whereSell: string;
  spotType: string;
  myDifficulty: string;
  effect: EffectResult | null;
  mainProblem: string;
  doWhat: string;
  measureTip: string;
  lastAction: string;
  chat: { role: 'user' | 'ai'; text: string; ts: number }[];
}

const KEY = 'vendor-advisor-history-v1';
const MAX = 30;

export function loadHistory(): RoundRecord[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** 把当前这一轮存成历史记录（每轮只存一次，最多保留 30 轮） */
export function saveRound(s: SessionData): RoundRecord | null {
  const hasAnything = !!(s.screen1.sellWhat || s.judgment || s.solution || (s.chat || []).length);
  if (!hasAnything) return null;

  const chat: { role: 'user' | 'ai'; text: string; ts: number }[] = (s.chat || [])
    .filter((m: ChatMessage) => (m.text || '').trim())
    .slice(-60)
    .map(m => ({ role: m.role, text: (m.text || '').slice(0, 2000), ts: m.ts }));

  const rec: RoundRecord = {
    id: `r-${Date.now()}`,
    createdAt: Date.now(),
    sellWhat: s.screen1.sellWhat || '',
    whereSell: s.screen1.whereSell || '',
    spotType: s.screen1.spotType || '',
    myDifficulty: s.screen1.myDifficulty || '',
    effect: s.effect ?? null,
    mainProblem: s.judgment?.mainProblem || '',
    doWhat: s.solution?.doWhat || s.lastAction || '',
    measureTip: s.measureTip || '',
    lastAction: s.lastAction || '',
    chat,
  };

  try {
    localStorage.setItem(KEY, JSON.stringify([rec, ...loadHistory()].slice(0, MAX)));
  } catch {
    // 存储满了就丢掉历史，不影响主流程
  }
  return rec;
}

export function deleteRound(id: string) {
  try {
    localStorage.setItem(KEY, JSON.stringify(loadHistory().filter(r => r.id !== id)));
  } catch {
    // ignore
  }
}

export function clearHistory() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

export function formatTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
