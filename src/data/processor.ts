// Step Processor — 前端调用后端 /api/process 获取每步的结构化中间产物卡
// 后端挂了 → 降级到本地 local_mlp，永远有 StepCard

import { localProcessStep } from './local_mlp';
import type { SessionData } from './schema';

export interface Section {
  title: string;
  type: 'kv' | 'list' | 'tag' | 'confidence' | 'tree';
  items: any[];
}

export interface StepCard {
  card_type: string;
  step: number;
  title: string;
  emoji: string;
  summary: string;
  sections: Section[];
  tags: string[];
  knowledge_refs: string[];
}

const API_BASE = import.meta.env.VITE_API_BASE || '/api';

/** 占位/兜底文案，不能当成"真正要做的事" */
const PLACEHOLDER_RE = /按方案执行|砍到只剩一件事|其他都先别管|先填完诊断|还没有执行方案/;

function normalizeItem(it: any): string {
  if (it == null) return '';
  if (Array.isArray(it)) return it.length >= 2 ? `${it[0]}：${it[1]}` : String(it[0] ?? '');
  if (typeof it === 'object') return String(it.text || it.action || it.metric || '');
  return String(it);
}

/** 从卡片里抽出这一屏的全部真实动作（过滤占位文案） */
export function extractCardPlan(card?: StepCard | null): string[] {
  if (!card) return [];
  const sec = (card.sections || []).find(s => /今天|动作|要做|执行清单/.test(s.title || ''));
  const fromSection = (sec?.items || [])
    .map(normalizeItem)
    .map(s => s.trim())
    .filter(s => s && !PLACEHOLDER_RE.test(s));
  if (fromSection.length) return fromSection;
  // 段落标题没命中时退回卡片摘要，避免下游拿写死的本地模板当「上次做的事」
  const summary = (card.summary || '').trim();
  return summary ? [summary] : [];
}

/**
 * 从卡片里抽出「今天就做这一件」的具体动作。
 * 屏 7 回溯、prev_solution 同步都用它，避免退回写死模板。
 */
export function extractCardAction(card?: StepCard | null): string {
  return extractCardPlan(card)[0] || '';
}

/**
 * 主入口：获取第 step 步的 StepCard
 *   - 后端 /api/process 可通 → 用后端（含 RAG 增强 + 知识库引用）
 *   - 后端挂了 → 本地 local_mlp（纯特征工程，无 RAG）
 *   - 永远不会返回 null
 */
export async function callProcessor(step: number, session: SessionData): Promise<StepCard> {
  // 先尝试后端
  try {
    const resp = await fetch(`${API_BASE}/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '', history: [], context: session, step }),
      signal: AbortSignal.timeout?.(2500), // 2.5s 超时就放弃
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data.card) return data.card as StepCard;
    }
  } catch {
    // 后端不可用 → 降级
  }

  // 降级到本地 MLP（永远有结果）
  return localProcessStep(step, session);
}
