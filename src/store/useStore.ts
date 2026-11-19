import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { emptySession, type SessionData } from '../data/schema';

interface Store extends SessionData {
  /** 每一步 AI 给出的卡片（屏 3-6 左侧展示，唯一来源是右侧 AI 返回） */
  aiCards: Record<number, any>;
  /** 每一步右侧 AI 的完整回复（T-agent 约束后的结构化文本），左侧优先显示它 */
  aiAnswers: Record<number, string>;
  /** 生成这些 AI 结果时对应的问卷指纹：问卷变了才清空 AI 结果 */
  aiFingerprint: string;
  setAiCard: (step: number, card: any) => void;
  setAiAnswer: (step: number, answer: string) => void;
  update: <K extends keyof SessionData>(key: K, value: SessionData[K]) => void;
  setScreen: (n: number) => void;
  reset: () => void;
  setData: (patch: Partial<SessionData>) => void;
}

/** 问卷指纹：只跟"影响 AI 判断的答案"有关 */
export function ctxFingerprint(s: SessionData): string {
  const a: any = s.screen1 || {};
  const b: any = s.screen2 || {};
  return [
    a.sellWhat, a.whereSell, a.price, a.dailyQty, a.stallFixed, a.dailyHours,
    a.stallType, a.timeSlot, a.weather, a.competitors, a.spotType, a.myDifficulty,
    b.customerAction, (b.customerLookAt || []).join(','), b.detailMismatch,
  ].map(v => (v == null ? '' : String(v))).join('|');
}

export const useStore = create<Store>()(
  persist(
    (set) => ({
      ...emptySession,
      createdAt: Date.now(),
      aiCards: {},
      aiAnswers: {},
      aiFingerprint: '',

      setAiCard: (step, card) => set((state) => ({
        aiCards: { ...state.aiCards, [step]: card },
        aiFingerprint: ctxFingerprint(state),
      })),

      setAiAnswer: (step, answer) => set((state) => ({
        aiAnswers: { ...state.aiAnswers, [step]: answer },
        aiFingerprint: ctxFingerprint(state),
      })),

      update: (key, value) => set((state) => ({ ...state, [key]: value })),

      setScreen: (n) => set({ screenNum: n }),

      setData: (patch) => set((state) => ({ ...state, ...patch })),

      reset: () => set({ ...emptySession, aiCards: {}, aiAnswers: {}, aiFingerprint: '', createdAt: Date.now() }),
    }),
    {
      name: 'vendor-advisor-session',
      version: 3,
      // v2 → v3：保留问卷，不清空任何数据
      migrate: (persisted: any) => persisted,
      // AI 卡片/回复/对话都保留：刷新后还原，不丢设计
      // 只有「问卷答案变了」才清空（按指纹判断），避免旧结论对不上新问卷
      merge: (persisted: any, current) => {
        const merged: any = { ...current, ...(persisted || {}) };
        const fp = ctxFingerprint(merged);
        if (merged.aiFingerprint && merged.aiFingerprint !== fp) {
          merged.aiCards = {};
          merged.aiAnswers = {};
          merged.chat = [];
          merged.aiFingerprint = '';
        }
        merged.chat = (merged.chat || []).map((m: any) => ({ ...m, typing: false }));
        return merged as Store;
      },
    }
  )
);
