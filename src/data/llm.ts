import type { SessionData } from './schema';
import type { StepCard } from './processor';

// API 基址：
//  - 本地开发：走 vite proxy → '/api/chat' → localhost:8000
//  - 生产环境（Netlify）：打 Render 后端 → VITE_API_BASE
const API_BASE = import.meta.env.VITE_API_BASE || '/api';

// 是否启用真实后端：
//  - 本地 DEV：是（用 vite proxy）
//  - 生产且配置了 VITE_API_BASE：是（打 Render）
//  - 生产没配 API_BASE：否 → fallback 到本地 Mock
const ENABLE_BACKEND = import.meta.env.DEV || !!import.meta.env.VITE_API_BASE;

// Mock 兜底（后端不可用时自动 fallback）
import { chatReply as mockReply } from './chat';

export interface ProcessTrail {
  category_kw: string;
  category_group: string;
  filled_fields: number;
  total_fields: number;
  kg_firing_rules: string[];
  kg_valid: string[];
  kg_invalid: string[];
  kg_root_causes?: string[];
  similar_case_hit: boolean;
  similar_case_title: string;
  rag_chunks: number;
  candidates_count: number;
  top_direction: string;
  top_score: number;
}

export interface ChatResponse {
  answer: string;
  query_rewritten: string;
  sub_queries: string[];
  knowledge_used: Array<{ source: string; title: string; content: string }>;
  recommended: { action: string; direction: string; scores: Record<string, number> } | null;
  alternatives: Array<{ action: string; direction: string }>;
  pipeline_debug: {
    num_sub_queries: number;
    num_candidates: number;
    num_knowledge_chunks: number;
    top_final_score: number;
    step_gated?: boolean;
    step_card?: StepCard;
    process_trail?: ProcessTrail;
  };
}

export async function callLLM(
  userMsg: string,
  history: { role: 'user' | 'ai'; text: string }[],
  session: SessionData,
): Promise<{ answer: string; trail?: ProcessTrail; stepCard?: StepCard }> {
  if (!ENABLE_BACKEND) {
    return { answer: mockReply(userMsg, session) };
  }

  try {
    const payload = {
      message: userMsg,
      history,
      context: session,
    };
    const resp = await fetch(`${API_BASE}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data: ChatResponse = await resp.json();

    let answer = data.answer;

    if (data.recommended?.scores && import.meta.env.VITE_SHOW_DEBUG === 'true') {
      const s = data.recommended.scores;
      const top3 = (data.alternatives || []).slice(0, 2);
      const extra = [
        '',
        `---`,
        `📋 Pipeline 调试：`,
        `· 改写后：${data.query_rewritten}`,
        `· 展开 ${data.pipeline_debug.num_sub_queries} 个子 query，检索到 ${data.pipeline_debug.num_knowledge_chunks} 条知识`,
        `· 生成 ${data.pipeline_debug.num_candidates} 个方案 → RRF 融合取最优`,
        `· 推荐方案得分：${Object.entries(s).map(([k, v]) => `${k}:${v.toFixed(1)}`).join(' / ')}`,
      ];
      if (top3.length > 0) {
        extra.push(`· 备选：${top3.map(a => a.action).join(' ｜ ')}`);
      }
      answer = answer + '\n' + extra.join('\n');
    }

    return { answer, trail: data.pipeline_debug?.process_trail, stepCard: data.pipeline_debug?.step_card };
  } catch (err) {
    console.warn('[Backend] 请求失败，fallback Mock:', err);
    return {
      answer:
        '⚠️ AI 服务暂时没连上（网络或额度问题），下面是规则版建议，不是 AI 回答：\n\n' +
        mockReply(userMsg, session),
    };
  }
}
