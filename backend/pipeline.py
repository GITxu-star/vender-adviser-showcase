"""Core RAG pipeline: QueryRewrite → MultiQuery → RAG → 多路生成 → 规则 Reranker → RRF 融合

去重升级：
  - 候选间去重：bge-m3 embedding 相似度 > 0.85 → 贪心淘汰
  - 历史回答去重：每个候选 action vs prev_solution → 相似度 > 0.8 → 扣分
  - 多样性惩罚进 RRF：候选间互相比，不相似分越高
"""
import json
import re
from typing import List, Dict, Any
from dataclasses import dataclass, field, asdict

from config import settings
from llm_client import llm
from rag import retrieve, RetrievedChunk
from embeddings import (
    deduplicate_by_similarity,
    compute_similarity_to_history,
    pairwise_cosine,
    embed,
)


# ============ 数据结构 ============

@dataclass
class SessionContext:
    """前端传来的问卷上下文"""
    sell_what: str = ''
    where_sell: str = ''
    price: str = ''
    daily_qty: str = ''
    stall_fixed: str = ''
    daily_hours: str = ''
    stall_type: str = ''
    time_slot: str = ''        # 时段：早市/午间/夜市/全天候
    weather: str = ''          # 天气影响：露天/遮阳/刮风下雨
    competitors: str = ''      # 周边竞争：多/少/独门生意
    spot_type: str = ''         # 点位类型（老板直觉分类）
    my_difficulty: str = ''     # 当前困境（老板选的）
    step: int = 1
    # 屏 2: 顾客反应
    customer_action: str = ''
    customer_look_at: str = ''
    # AI 之前给的判断/方案（如果有）
    prev_judgment: str = ''
    prev_solution: str = ''
    # 屏 7：老板选的效果结果 good/some/none/worse（不传就等于没选）
    effect_result: str = ''
    # 用户这一轮说的话（用于识别"太难了/换一个"这类意图）
    user_message: str = ''


@dataclass
class Candidate:
    """一个候选方案"""
    index: int
    direction: str           # 方向标签（视觉/价格/体验/...）
    action: str               # 具体做什么
    cost_and_time: str        # 成本
    revert_plan: str          # 退路
    # Reranker 各维度打分（0-10）
    scores: Dict[str, float] = field(default_factory=dict)
    final_score: float = 0.0  # RRF 融合后的总分


# ============ Step 1: Query Rewrite ============

def _extract_json_array(raw: str) -> list | None:
    """
    从 LLM 返回的 JSON 里提取数组。
    LLM 可能返回：[...] 或 {"queries": [...]} 或 {"value": [...]} 或 {"items": [...]}
    """
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None

    if isinstance(data, list):
        return data

    if isinstance(data, dict):
        # 常见包装键
        for key in ['queries', 'items', 'results', 'data', 'value', 'candidates', 'solutions']:
            if key in data and isinstance(data[key], list):
                return data[key]
        # 兜底：找 dict 里第一个 list
        for v in data.values():
            if isinstance(v, list):
                return v

    return None


def query_rewrite(raw_user_input: str, context: SessionContext) -> str:
    """把用户口语化/带错别字的输入改写成干净、无歧义的查询。"""
    system = [
        {'role': 'system', 'content': (
            '你是查询改写器。把用户的口语化地摊经营问题，改成干净、无歧义、适合检索的句子。'
            '不要回答问题，只改写。保持原意不变，修正错别字，补全必要的上下文。'
            '输出直接是改写后的句子，不要加引号或其他内容。'
        )},
        {'role': 'user', 'content': (
            f'用户原话：「{raw_user_input}」\n\n'
            f'补充上下文：用户在{context.where_sell or "（未知）"}卖{context.sell_what or "（未知）"}。\n\n'
            f'改写后：'
        )},
    ]
    return llm.chat(system, temperature=0.1, max_tokens=200).strip()


# ============ Step 2: Multi-Query 展开 ============

def multi_query(rewritten: str, context: SessionContext) -> List[str]:
    """从多个角度展开，生成 N 个不同的检索 query。"""
    n = settings.NUM_SUB_QUERIES
    system = [
        {'role': 'system', 'content': (
            f'你是查询展开器。针对地摊经营问题，从不同角度展开 {n} 个独立的检索 query。'
            f'每个 query 角度要不同（比如视觉展示、价格策略、顾客行为、体验优化、特色差异化）。'
            f'输出 JSON 数组，每个元素是字符串。'
        )},
        {'role': 'user', 'content': (
            f'原始改写后的查询：{rewritten}\n'
            f'摊主上下文：{context.sell_what or "未知" + " / " + (context.where_sell or "未知")}\n\n'
            f'输出 JSON 数组，{n} 个 query：'
        )},
    ]
    raw = llm.chat_json(system, temperature=0.1)
    arr = _extract_json_array(raw)
    if arr:
        return [str(q).strip() for q in arr[:n]]
    # fallback: 简单 split
    return [rewritten]


# ============ Step 3: RAG 检索 + 合并 ============

def gather_knowledge(sub_queries: List[str]) -> List[RetrievedChunk]:
    """对每个 sub_query 做检索，去重合并。"""
    seen: set = set()
    all_chunks: List[RetrievedChunk] = []
    for q in sub_queries:
        for c in retrieve(q, top_k=3):
            key = (c.source, c.title)
            if key not in seen:
                seen.add(key)
                all_chunks.append(c)
    return all_chunks


# ============ Step 4: 多路方案生成 ============

def generate_multi_candidates(
    rewritten_query: str,
    knowledge: List[RetrievedChunk],
    context: SessionContext,
    temperature: float = 0.22,
) -> List[Candidate]:
    """让 LLM 一次生成 N 个不同方向的候选方案。temperature 由 T-agent 动态决定。"""
    n = settings.NUM_CANDIDATES

    knowledge_text = '\n\n'.join(
        f'【{c.source}】{c.title}\n{c.content}' for c in knowledge
    ) if knowledge else '（暂无匹配知识）'

    system = [
        {'role': 'system', 'content': (
            '你是地摊经营顾问。根据用户的问题和知识库片段，生成多个不同方向的「今天就能做」的具体方案。\n'
            '每个方案必须：\n'
            '- 今天就能动手（不超过 2 小时准备）\n'
            '- 说人话，禁用术语\n'
            '- 有退路（没用怎么退回）\n'
            '\n'
            f'【红线】{n} 个方案必须方向完全不同（比如视觉展示 vs 价格策略 vs 体验优化 vs 特色差异化 vs 流程简化），'
            '禁止多个方案都建议"擦招牌"或"挂串灯"这种雷同方案——每个方案的 action 描述必须跟其他四个有本质区别！\n'
            '\n'
            f'输出 JSON 数组，{n} 个方案，每个方案格式：\n'
            '{\n'
            '  "direction": "方向标签（视觉展示/价格策略/体验优化/特色差异化/流程简化）",\n'
            '  "action": "具体做什么（1-2 句，说清楚）",\n'
            '  "cost_and_time": "多少钱 + 多久",\n'
            '  "revert_plan": "没用怎么退回"\n'
            '}'
        )},
        {'role': 'user', 'content': (
            f'用户问题（已改写）：{rewritten_query}\n\n'
            f'摊主上下文：\n'
            f'  卖什么：{context.sell_what or "未知"}\n'
            f'  在哪卖：{context.where_sell or "未知"}\n'
            f'  一份价格：{context.price or "未知"}元\n'
            f'  每天卖：{context.daily_qty or "未知"}\n'
            f'  摊位固定：{context.stall_fixed or "未知"}\n'
            f'  时段：{context.time_slot or "未知"}\n'
            f'  竞争：{context.competitors or "未知"}\n'
            f'  点位：{context.spot_type or "未知"}\n'
            f'  困境：{context.my_difficulty or "未知"}\n'
            f'  顾客走到摊前：{context.customer_action or "未知"}\n'
            f'  顾客看什么：{context.customer_look_at or "未知"}\n'
            f'\n'
            f'【之前的诊断】{context.prev_judgment or "无"}\n'
            f'【之前给的方案】{context.prev_solution or "无"}\n\n'
            f'【知识库参考】\n{knowledge_text}\n\n'
            f'生成 {n} 个不同方向的方案（JSON 数组）：'
        )},
    ]
    raw = llm.chat_json(system, temperature=temperature, max_tokens=3000)

    arr = _extract_json_array(raw)
    if arr:
        return [Candidate(
            index=i,
            direction=c.get('direction', f'方向{i+1}'),
            action=c.get('action', ''),
            cost_and_time=c.get('cost_and_time', ''),
            revert_plan=c.get('revert_plan', ''),
        ) for i, c in enumerate(arr)]

    # fallback: 返回一个空方案
    return [Candidate(index=0, direction='fallback',
                      action='先把招牌擦干净，字写大点',
                      cost_and_time='0 元，10 分钟',
                      revert_plan='随时可以擦掉')]


# ============ Step 5: 规则打分 Reranker（5 维） ============

def _parse_money_range(text):
    """从"2-18"、"5 元"里取价格区间（没有数字返回 (0, 0)）。"""
    import re
    nums = [float(x) for x in re.findall(r'\d+(?:\.\d+)?', text or '')]
    if not nums:
        return 0.0, 0.0
    return min(nums), max(nums)


def _parse_qty_range(text):
    """从"20 份以下 / 20-50 / 100 以上"里取日销量区间。"""
    import re
    t = (text or '').replace(' ', '')
    nums = [float(x) for x in re.findall(r'\d+(?:\.\d+)?', t)]
    if not nums:
        return 0.0, 0.0
    if '以上' in t or '+' in t:
        hi = max(nums)
        return hi, hi * 1.5
    if len(nums) >= 2:
        return min(nums), max(nums)
    return nums[0], nums[0]


def _parse_cost_amount(text):
    """从"0 元，10 分钟"里只取钱数——分钟数不能当成本。"""
    import re
    t = text or ''
    if any(k in t for k in ('免费', '不要钱', '不花钱', '零成本')):
        return 0.0
    nums = [float(x) for x in re.findall(r'(\d+(?:\.\d+)?)\s*(?:元|块|毛|角)', t)]
    if nums:
        return max(nums)
    if '几块' in t or '几元' in t or '几十' in t:
        return 30.0 if '几十' in t else 10.0
    return None


def rule_based_rerank(candidates: List[Candidate], similar_case: Dict[str, Any] | None = None,
                      kg: Dict[str, Any] | None = None) -> List[Candidate]:
    """
    对每个候选方案按维度打分（0-10）。
    升级：新增第 8 维 context_fit（符号学习适配度）——
      - 如果候选方向 ∈ kg.valid_strategies → +3~4 分
      - 如果候选方向 ∈ kg.invalid_strategies → -2~3 分
      - context_weight < 0.2 时不打这分（问卷没填的摊主不瞎判断）
    """
    kg = kg or {}
    valid_strategies = kg.get('valid_strategies', set())
    invalid_strategies = kg.get('invalid_strategies', set())
    context_weight = kg.get('context_weight', 0.0)
    root_causes = kg.get('root_causes', [])

    for c in candidates:
        scores: Dict[str, float] = dict(c.scores or {})

        # ---- 符号学习适配度（新维度！）----
        action_and_dir = (c.action or '') + ' ' + (c.direction or '')
        # 1. 是否命中 valid_strategies（品类×时段+竞争+点位的有效方向）
        fit_score = 5.0  # 中性分
        if context_weight >= 0.25 and valid_strategies:
            for vs in valid_strategies:
                if vs in action_and_dir or vs in (c.direction or ''):
                    fit_score += 1.5  # 每个命中的 valid strategy 加分
                    break
            # 2. 是否命中 invalid_strategies（严禁的方向）
            for ivs in invalid_strategies:
                if ivs in action_and_dir:
                    fit_score -= 2.0  # 命中 invalid 重罚
                    break
            # 3. 动作是否针对根因
            if root_causes:
                for cause in root_causes:
                    keywords = [w for w in cause if len(w) >= 2][:2]
                    if any(kw in action_and_dir for kw in keywords):
                        fit_score += 1.0  # 针对根因的动作 +分
                        break
            fit_score = max(1.0, min(10.0, fit_score))
        scores['context_fit'] = fit_score

        # 1. 成本 cost：按"这次要花的钱"占"这个摊一天大概卖多少钱"的比例打分
        cost_amt = _parse_cost_amount(c.cost_and_time)
        daily_rev = float((kg.get('budget') or {}).get('est_daily_revenue') or 0)
        if cost_amt is None or daily_rev <= 0:
            # 预算/成本数据缺失 → 中性分，不假装算得出成本水平
            scores['cost'] = 6.0
        else:
            ratio = cost_amt / daily_rev
            if ratio <= 0.05:
                scores['cost'] = 10.0
            elif ratio <= 0.10:
                scores['cost'] = 9.0
            elif ratio <= 0.20:
                scores['cost'] = 7.5
            elif ratio <= 0.40:
                scores['cost'] = 5.5
            else:
                scores['cost'] = 3.0

        # 时间：越快分越高
        if any(x in c.cost_and_time for x in ['10', '15', '5分钟', '10分钟', '15分钟', '小时']):
            scores['time'] = 9.0 if any(x in c.cost_and_time for x in ['分钟']) else 6.0
        else:
            scores['time'] = 5.0

        # 2. 记忆 memorability
        action_len = len(c.action or '')
        scores['memory'] = max(3.0, 10.0 - action_len / 50)

        # 3. 识别 recognition：结合 kg 增强
        dir_vis = any(x in action_and_dir for x in ['视觉', '展示', '招牌', '显眼', '摆', '堆头'])
        if valid_strategies & {'视觉展示', '招牌醒目', '堆头视觉'}:
            scores['recognition'] = 9.0 if dir_vis else 5.0  # 这个摊主视觉优先
        else:
            scores['recognition'] = 8.0 if dir_vis else 6.0

        # 4. 容错率 fault_tolerance
        scores['fault_tolerance'] = 9.0 if (c.revert_plan and len(c.revert_plan) > 5) else 5.0

        # 5. 特色 novelty
        novelty_kw = ['特色', '不一样', '隔壁', '独特', '记忆点', '差异化']
        scores['novelty'] = 8.0 if any(x in action_and_dir for x in novelty_kw) else 5.0

        # 6. 相似案例匹配度（持续学习 — 问卷没填就降低权重）
        if similar_case and similar_case.get('case_text') and context_weight >= 0.25:
            case_text = similar_case['case_text']
            action_kw = set((c.action + ' ' + c.direction).replace('：', ' ').split())
            case_kw = set(case_text.replace('：', ' ').split())
            overlap = action_kw & case_kw
            scores['similarity_score'] = min(10.0, len(overlap) * 1.5 + 3.0)
        else:
            scores['similarity_score'] = 5.0  # 问卷没填或没案例，中性分

        c.scores = scores

    return candidates


# ============ Step 6: RRF 融合排序 ============

def rrf_fusion(candidates: List[Candidate], k: int = 60) -> List[Candidate]:
    """Reciprocal Rank Fusion. 每个维度独立排序 → 融合得分。"""
    # 新增 diversity 维度（候选越不相似分越高），加 novelty_vs_history 维度
    dimensions = ['context_fit', 'cost', 'time', 'memory', 'recognition', 'fault_tolerance', 'novelty',
                  'diversity', 'novelty_vs_history', 'similarity_score']

    # 先按每个维度分别排序，得到 rank
    rank_lists: Dict[str, List[int]] = {}  # dim -> list of candidate indices ordered by rank
    for dim in dimensions:
        sorted_c = sorted(candidates, key=lambda c: c.scores.get(dim, 0), reverse=True)
        rank_lists[dim] = [c.index for c in sorted_c]

    # 计算 RRF score
    for c in candidates:
        rrf = 0.0
        for dim, ranking in rank_lists.items():
            rank_pos = ranking.index(c.index) + 1  # 1-indexed
            rrf += 1.0 / (k + rank_pos)
        c.final_score = rrf

    # 按 final_score 排序
    candidates.sort(key=lambda c: c.final_score, reverse=True)
    return candidates


# ============ 去重 & 多样性：嵌入向量相似度管线 ============

def deduplicate_candidates(
    candidates: List[Candidate],
    api_key: str | None,
    threshold: float = 0.85,
) -> List[Candidate]:
    """
    对候选方案的 action 做 embedding 相似度去重。
    相似度 > threshold 的只保留最短那个（短 = 更凝练 = 更可能被 LLM 选中）。
    """
    if len(candidates) <= 1:
        return candidates

    actions = [c.action or c.direction or '' for c in candidates]
    try:
        kept_indices = deduplicate_by_similarity(actions, api_key, threshold=threshold)
        result = [candidates[i] for i in kept_indices]
        if len(result) < len(candidates):
            print(f'[Dedup] {len(candidates)} → {len(result)}（淘汰 {len(candidates) - len(result)} 个相似项）')
        return result
    except Exception as e:
        print(f'[Dedup] embedding 去重失败，保留全部：{e}')
        return candidates


def compute_diversity_scores(
    candidates: List[Candidate],
    api_key: str | None,
) -> None:
    """
    给每个候选加 diversity 分数（写进 c.scores['diversity']）。
    diversity = 该候选与其他候选平均相似度的反比（1 - mean_sim）。
    越不相似 → diversity 分越高。
    """
    if len(candidates) <= 1:
        for c in candidates:
            c.scores['diversity'] = 10.0  # 只有一个，满分
        return

    try:
        actions = [c.action or c.direction or '' for c in candidates]
        vecs = embed(actions, api_key)
        sim_matrix = pairwise_cosine(vecs)
        n = len(candidates)
        for i, c in enumerate(candidates):
            # 排除自己，算与其他所有候选的平均相似度
            others = [sim_matrix[i][j] for j in range(n) if j != i]
            mean_sim = sum(others) / max(1, n - 1)
            # diversity ∈ [0, 1] → 映射到 [3, 10]
            div = 1.0 - mean_sim
            c.scores['diversity'] = max(3.0, div * 10)
    except Exception as e:
        print(f'[Diversity] embedding 计算失败，给默认分：{e}')
        for c in candidates:
            c.scores['diversity'] = 5.0


def penalize_history_similarity(
    candidates: List[Candidate],
    history_text: str,
    api_key: str | None,
) -> None:
    """
    给每个候选加 novelty_vs_history 分数（写进 c.scores['novelty_vs_history']）。
    history_text 不为空时生效。相似度 > 0.8 扣分明显。
    """
    if not history_text or len(candidates) == 0:
        for c in candidates:
            c.scores['novelty_vs_history'] = 7.0  # 没有历史参考，给中性分
        return

    try:
        actions = [c.action or '' for c in candidates]
        sims = compute_similarity_to_history(actions, history_text, api_key)
        for c, sim in zip(candidates, sims):
            # sim ∈ [0, 1] → 扣分：相似度越高分越低
            # sim=0 → 10分（全新方向）；sim=0.8 → 3分；sim=1.0 → 0分
            score = max(0.0, 10.0 - sim * 12.5)
            c.scores['novelty_vs_history'] = score
            if sim > 0.8:
                print(f'[HistoryPenalty] 候选 "{c.action[:20]}..." 与历史相似度 {sim:.2f} → 扣分 → {score:.1f}')
    except Exception as e:
        print(f'[HistoryPenalty] embedding 计算失败，给默认分：{e}')
        for c in candidates:
            c.scores['novelty_vs_history'] = 5.0


def _context_is_empty(context: SessionContext) -> bool:
    """判断问卷是不是基本没填（screen1 核心字段）。"""
    filled = sum(1 for v in [
        context.sell_what, context.where_sell, context.price,
        context.daily_qty, context.stall_fixed, context.daily_hours,
    ] if v)
    return filled < 2  # 填了不到 2 项算没填


def _need_screen2(context: SessionContext) -> bool:
    """屏 2 顾客反应没填——无法做诊断。"""
    filled = sum(1 for v in [
        getattr(context, 'customer_action', ''),
        getattr(context, 'customer_look_at', ''),
    ] if v)
    return filled < 1


def _retrieve_similar_case(context: SessionContext) -> Dict[str, Any] | None:
    """
    持续学习：从向量库「案例库/」目录里检索和当前摊主最相似的真实案例。
    匹配维度：品类 + 点位 + 困境。
    """
    try:
        query_parts = []
        if context.sell_what: query_parts.append(context.sell_what)
        if context.where_sell: query_parts.append(context.where_sell)
        if context.competitors: query_parts.append(context.competitors)
        if context.my_difficulty: query_parts.append(context.my_difficulty)
        if not query_parts: return None

        query = ' '.join(query_parts)
        from rag import retrieve as rag_retrieve
        chunks = rag_retrieve(query, top_k=3)
        # 只保留案例库的
        case_chunks = [c for c in chunks if '案例库' in (getattr(c, 'source', '') or '')]
        if not case_chunks: return None

        top = case_chunks[0]
        return {
            'title': getattr(top, 'title', '相似案例'),
            'case_text': getattr(top, 'content', '')[:400],
            'source': getattr(top, 'source', ''),
        }
    except Exception as e:
        print(f'[SimilarCase] 检索失败（不影响主流程）: {e}')
        return None


def _has_judgment(context: SessionContext) -> bool:
    """有没有做过 AI 诊断（主要问题是什么）。"""
    return bool(context.prev_judgment)


# ============ Phase 2: 符号学习 — 规则引擎（升级版本） ============

# （旧的 _CATEGORY_TIME_STRATEGY 和 _DIFFICULTY_ROOT_CAUSE 已移至 rules.py 种子规则库）


def _build_context_kg(context: SessionContext) -> Dict[str, Any]:
    """
    基于规则引擎（RuleGraph）构建**这个特定摊主**的知识图谱。

    升级：不再是手工 if-else 叠加，而是：
      ① RuleGraph.match() → 从规则库匹配所有触发的规则
      ② RuleGraph.resolve_conflicts() → 冲突消解（同 strategy 同时被 valid 和 invalid 时取 invalid）
      ③ 每条规则带 confidence × priority → 强度高的赢
      ④ 规则有依赖图（dependencies 字段）→ 依赖规则先执行
      ⑤ 规则可从案例库自动归纳（induce_rules_from_case）

    Returns:
        {
            'valid_strategies': set,        # 冲突消解后的有效策略
            'invalid_strategies': set,      # 冲突消解后的无效策略
            'root_causes': list,            # 困境 → 根因
            'context_weight': float,        # 问卷填充度 0~1
            'reasoning_chain': str,         # 可读的规则触发链（每条规则标注 confidence/priority）
            'firing_rules': list,           # 原始触发的规则明细（给前端展示）
            'filled_count': int,
        }
    """
    from rules import get_graph, is_food_category

    reasoning_parts: List[str] = []

    # —— 1. 规则库匹配 ——
    graph = get_graph()
    # 优先用 processor 推断的 category_kw（品类归类），匹配不到再回退到原始 sell_what
    from processor import _infer_category_group
    cat_group, cat_kw = _infer_category_group(context.sell_what or '')
    context_dict = {
        'sell': cat_kw,                          # 用归类关键词（烤鱼/烤串/快餐/奶茶/水果）
        'sell_raw': context.sell_what or '',      # 保留原始
        'time': context.time_slot or '',
        'difficulty': context.my_difficulty or '',
        'competitors': context.competitors or '',
        'spot': context.spot_type or '',
    }
    matched = graph.match(context_dict)

    # —— 2. 冲突消解（按品类过滤餐饮专属措辞）——
    is_food = is_food_category(f'{cat_group} {context.sell_what or ""}')
    valid, invalid, root_causes, firing_explanations = graph.resolve_conflicts(matched, is_food=is_food)

    # —— 3. 生成推理链 ——
    if matched:
        reasoning_parts.append(f'🔍 规则引擎命中 {len(matched)} 条规则：')
        for fe in firing_explanations:
            reasoning_parts.append(f'   ↳ {fe}')
        reasoning_parts.append(f'✓ 冲突消解后：有效={valid or "（无）"} | 无效={invalid or "（无）"}')
    else:
        reasoning_parts.append('🔍 没有命中任何规则（可能品类/时段不在规则库）')

    # —— 4. 根因链 ——
    if root_causes:
        reasoning_parts.append(f'困境根因链：{" → ".join(root_causes)}')

    # —— 5. 问卷填充度 ——
    filled_count = sum(1 for v in [
        context.sell_what, context.where_sell, context.price,
        context.daily_qty, context.stall_fixed, context.daily_hours,
        context.stall_type, context.time_slot, context.competitors,
        context.spot_type, context.my_difficulty,
    ] if v and v not in ('未填', ''))
    total = 11
    context_weight = filled_count / total

    if context_weight < 0.2:
        reasoning_parts.append(f'⚠️ 问卷只填了 {filled_count} 项 → 规则引擎置信度低，跳过案例检索')
    elif context_weight < 0.5:
        reasoning_parts.append(f'问卷填了 {filled_count}/{total} 项 → 规则方向基本可靠')
    else:
        reasoning_parts.append(f'问卷填了 {filled_count}/{total} 项 → 规则方向可靠，以问卷内容为主推理')

    # —— 6. 预算参照：没有"预算"字段，用「单价 × 日销量」估日营业额 ——
    price_lo, price_hi = _parse_money_range(context.price or '')
    qty_lo, qty_hi = _parse_qty_range(context.daily_qty or '')
    price_mid = (price_lo + price_hi) / 2 if price_hi else 0.0
    qty_mid = (qty_lo + qty_hi) / 2 if qty_hi else 0.0
    est_daily_revenue = round(price_mid * qty_mid, 2)
    if est_daily_revenue > 0:
        reasoning_parts.append(
            f'预算参照：单价 {price_mid:g} 元 × 日销 {qty_mid:g} 份 ≈ 日营业额 {est_daily_revenue:g} 元'
        )

    return {
        'valid_strategies': valid,
        'invalid_strategies': invalid,
        'root_causes': root_causes,
        'context_weight': context_weight,
        'reasoning_chain': '\n'.join(reasoning_parts),
        'firing_rules': [r.rule_id for r in matched],
        'filled_count': filled_count,
        'category_kw': cat_kw,       # 品类归类关键词
        'category_group': cat_group,  # 品类组名
        'budget': {
            'price': context.price or '',
            'daily_qty': context.daily_qty or '',
            'est_daily_revenue': est_daily_revenue,
        },
    }


def _ask_to_fill_form(raw_input: str, step: int) -> str:
    """问卷没填时，引导用户先填。"""
    hints = {
        1: '先填一下左边的问卷吧——告诉我你卖什么、在哪卖，我才能帮你。就两三分钟的事。',
        2: '继续填左边的问卷——顾客走到你摊前一般做什么？看什么？这两项答完我就能开始诊断了。',
        3: '问卷差不多了，再补一两项，我就能给你具体建议了！',
    }
    tip = hints.get(min(step, 3), '先填一下左边的问卷吧，填完我才能给你靠谱的建议。')
    return f'「{raw_input}」\n\n{tip}'


def _ask_to_diagnose_first(raw_input: str) -> str:
    """屏 3 诊断还没做——不许给方案。"""
    return (
        f'「{raw_input}」\n\n'
        '我还不知道问题出在哪——得先做诊断再给方案。\n'
        '请先走到第 3 步，让我看看最该先改的是什么。'
    )


# ============ 主 Pipeline ============
# ─────────────────────────────────────────────────────────────────
# 🧠 Temperature 调节 Agent（期末考试类比）
#
# 核心理念：
#   基础题（填得全、有参考、常规问题）→ 低 T（稳、不犯错、检查一遍）
#   难题（填得少、无参考、模糊/危机场景）→ 高 T（敢打破常规、多试多想）
#
# 同时保证：同样 context → 算出同样 T → 缓存命中 → 结果稳定
# ─────────────────────────────────────────────────────────────────

def _compute_dynamic_temperatures(
    context: SessionContext,
    kg: Dict[str, Any],
    has_similar_case: bool,
) -> Dict[str, float]:
    """
    返回 dict: {
        'query_rewrite': 0.10,   # 改写必须确定，固定 0.10
        'multi_query':   0.10,   # 展开也必须确定
        'candidates':    T_candidates,  # 方案生成，需创意
        'final':         T_final,       # 最终回答，稳定有个性
        'step3_diag':    T3,   # step 3 诊断推理
        'step4_flow':    T4,   # step 4 动线方案
        'step5_disp':    T5,   # step 5 陈列方案
        'step6_tech':    T6,   # step 6 话术/管理方案
    }
    
    核心理念：
      step 3（诊断）→ 稳定低 T（诊断要准，不能瞎猜）
      step 4-6（方案）→ 动态调节（难题高 T 敢想、基础题低 T 稳）
    """
    difficulty = context.my_difficulty or ''
    competitors = context.competitors or ''
    filled_count = kg.get('filled_count', 0)
    fill_ratio = filled_count / 11.0
    valid = kg.get('valid_strategies', set())

    # ====== 全局因子 ======
    t_from_fill = fill_ratio * 0.15
    t_from_case = 0.0 if has_similar_case else 0.30

    crisis_kws = ['被同行挤', '没活路', '卖不动不知道', '扩大没方向', 
                  '没人买', '快倒闭', '活不下去']
    vague_kws  = ['不知道', '不清楚', '迷茫', '困惑', '没方向']
    t_from_difficulty = 0.0
    if any(k in difficulty for k in crisis_kws):
        t_from_difficulty = 0.28
    elif any(k in difficulty for k in vague_kws):
        t_from_difficulty = 0.14

    t_from_competition = 0.10 if ('激烈' in competitors and '差异化' in valid) else 0.0

    gate_2 = -0.25 if context.step <= 2 else 0.0
    gate_3 = -0.12 if context.step == 3 else 0.0  # step 3 诊断要更准

    # ====== 各 step 温度 ======
    temps = {}

    # 固定值（必须确定的环节）
    temps['query_rewrite'] = 0.10
    temps['multi_query']   = 0.10

    # 方案生成 & 最终回答（已经在用）
    base_candidates = 0.22
    base_final = 0.15
    temps['candidates'] = round(min(0.85, max(0.12, base_candidates + t_from_fill + t_from_case + t_from_difficulty + t_from_competition + gate_2)), 2)
    temps['final']      = round(min(0.55, max(0.08, base_final + t_from_fill * 0.6 + t_from_case * 0.5 + t_from_difficulty * 0.5 + t_from_competition * 0.4 + gate_2 * 0.6)), 2)

    # ====== step 2-6 独立温度 ======
    # step 2 原因预估：需要"敢想"，而且必须结合 KG 证据，避免永远一个套路
    base_s2 = 0.42
    gate_step2 = 0.12 if context.step == 2 else 0.0
    temps['step2_diag'] = round(min(0.80, max(0.28,
        base_s2 + t_from_fill * 0.4 + t_from_difficulty * 0.5 + t_from_competition * 0.3 + gate_step2)), 2)

    # step 3 诊断：要准，T 稍低，但如果是危机场景也允许适度创新
    base_diag = 0.18
    temps['step3_diag'] = round(min(0.45, max(0.08, base_diag + t_from_fill * 0.4 + t_from_difficulty * 0.3 + gate_3)), 2)

    # step 4 动线方案：中等 T，需要结合人流数据做具体建议
    base_flow = 0.25
    temps['step4_flow'] = round(min(0.65, max(0.10, base_flow + t_from_fill * 0.5 + t_from_case * 0.6 + t_from_difficulty * 0.4 + t_from_competition * 0.5 + gate_2)), 2)

    # step 5 陈列/视觉方案：创意需求最高（颜色、道具、摆法）
    base_disp = 0.32
    temps['step5_disp'] = round(min(0.85, max(0.12, base_disp + t_from_fill * 0.6 + t_from_case * 0.7 + t_from_difficulty * 0.5 + t_from_competition * 0.5 + gate_2)), 2)

    # step 6 话术/管理：稳定中等
    base_tech = 0.20
    temps['step6_tech'] = round(min(0.55, max(0.08, base_tech + t_from_fill * 0.4 + t_from_case * 0.5 + t_from_difficulty * 0.3 + t_from_competition * 0.3 + gate_2)), 2)

    # 日志
    reasons = []
    if t_from_fill > 0.05: reasons.append(f'填了{filled_count}项')
    if t_from_case > 0.05: reasons.append('无相似案例')
    if t_from_difficulty > 0.05: reasons.append('困境关键词')
    if t_from_competition > 0.05: reasons.append('竞争激烈需差异化')
    if not reasons: reasons.append('基础题模式')

    print(f'[T-agent] candidates={temps["candidates"]} final={temps["final"]} | '
          f'step3_diag={temps["step3_diag"]} step4_flow={temps["step4_flow"]} '
          f'step5_disp={temps["step5_disp"]} step6_tech={temps["step6_tech"]} | '
          f'原因: {" ".join(reasons)}')

    return temps


# ============ 主 Pipeline ============
# 进程内确定性缓存：问卷内容+step 没变 → 直接返回（防同样输入产出不同 answer）
import hashlib, json as _json
_result_cache: Dict[str, Dict[str, Any]] = {}
_MAX_CACHE = 64

# step_card 独立缓存：跨 /api/process 和 /api/chat 复用同一份 LLM 生成的 StepCard
# key 只跟问卷+step 有关（和用户消息无关），填同一份问卷 → 永远复用
_step_card_cache: Dict[str, Any] = {}
_MAX_STEP_CARD_CACHE = 32

def _step_card_cache_key(context: SessionContext) -> str:
    """只跟问卷+step 有关，和用户消息无关。"""
    payload = {
        'sell_what': context.sell_what,
        'where_sell': context.where_sell,
        'time_slot': context.time_slot,
        'competitors': context.competitors,
        'spot_type': context.spot_type,
        'my_difficulty': context.my_difficulty,
        'customer_action': context.customer_action,
        'prev_judgment': context.prev_judgment,
        'prev_solution': context.prev_solution,
        'effect': context.effect_result,
        'step': context.step,
    }
    raw = _json.dumps(payload, sort_keys=True, default=str)
    return 'sc_' + hashlib.sha256(raw.encode()).hexdigest()

def _cache_key(context: SessionContext, step: int, extra: str = '') -> str:
    """基于问卷完整内容 + step 算 hash。问卷变了 → key 变 → 重新跑。"""
    payload = {
        'screen1': context.screen1 if hasattr(context, 'screen1') else {},
        'screen2': context.screen2 if hasattr(context, 'screen2') else {},
        'screen3': context.screen3 if hasattr(context, 'screen3') else {},
        'sell_what': context.sell_what,
        'where_sell': context.where_sell,
        'time_slot': context.time_slot,
        'competitors': context.competitors,
        'spot_type': context.spot_type,
        'my_difficulty': context.my_difficulty,
        'prev_judgment': context.prev_judgment,
        'prev_solution': context.prev_solution,
        'effect': context.effect_result,
        'step': step,
        'screenNum': context.screenNum,
        'extra': extra,
    }
    raw = _json.dumps(payload, sort_keys=True, default=str)
    return hashlib.sha256(raw.encode()).hexdigest()

def run_pipeline(raw_user_input: str, context: SessionContext,
                 history: List[Dict[str, str]] | None = None) -> Dict[str, Any]:
    """完整 RAG pipeline 执行入口。
    
    设计理念：AI 永远不拒绝用户的问题。
    - 问卷没填完 → 基于已有信息给方向性建议 + 温和提示补什么
    - 诊断没做 → 给"找方向"的建议，不瞎给具体方案
    - 任何时候用户问啥，都有回应
    """
    history = history or []

    # ============ 确定性缓存命中 ============
    # 同样的问卷内容 + step + screenNum + 用户消息 → 直接返回上次结果
    # （step 变了 → key 变 → 重新跑；问卷字段变了 → key 变 → 重新跑）
    from processor import process_step  # noqa: F401
    try:
        cache_k = _cache_key(context, context.step, raw_user_input[:50])
        if cache_k in _result_cache:
            import time as _t
            print(f'[cache] HIT step={context.step} sell={context.sell_what} key={cache_k[:8]}')
            # deepcopy 避免调用方修改返回对象影响缓存
            import copy as _copy
            return _copy.deepcopy(_result_cache[cache_k])
    except Exception:
        pass  # cache 挂了不影响主流程

    # ============ 软提示：缺失信息（只加在回答末尾，不拦截主流程） ============
    # 升级：不再用 give_solutions=False 拦截——哪怕问卷没填，也正常走完整管线！
    # KG 里 context_weight < 0.2 会自动让 context_fit 不分（避免瞎判断），足够了。
    soft_hints: List[str] = []
    if _context_is_empty(context):
        soft_hints.append('你还没告诉我卖什么、在哪卖——不过没关系，先看看方向，之后补信息我能给更准的建议')
    if _need_screen2(context) and context.step < 3:
        soft_hints.append('等你告诉我顾客走到摊前一般做什么、看什么，建议会更有针对性')
    give_solutions = True  # 永远 True！哪怕问卷没填，也给具体方案（KG 会自动处理置信度）

    # ============ Step 0.5: 符号学习 — 这个摊主的专属知识图谱 ============
    kg = _build_context_kg(context)

    # ============ Step 0.6: 相似案例检索（持续学习维度 — 至少要有 2 项问卷才检索 ============
    similar_case = None
    if kg['filled_count'] >= 2:
        similar_case = _retrieve_similar_case(context)
    else:
        print(f'[SimilarCase] 问卷只填了 {kg["filled_count"]} 项，跳过案例检索（避免 KNN 惰性学习）')

    # —— 自动符号学习：案例命中时，用 LLM 从案例文本归纳新规则 → 写入规则库（越用越聪明）——
    if similar_case and similar_case.get('case_text') and kg['filled_count'] >= 2:
        try:
            from rules import induce_rules_from_case, get_graph
            from llm_client import LLMClient
            _llm = LLMClient()
            new_rules = induce_rules_from_case(similar_case['case_text'], _llm)
            if new_rules:
                g = get_graph()
                for nr in new_rules:
                    g.add_rule(nr)
                print(f'[KG] 从案例归纳 {len(new_rules)} 条新规则 → 规则库现在 {len(g.rules)} 条')
        except Exception as e:
            print(f'[KG] 案例规则归纳（非关键路径，失败不影响主流程）: {e}')

    # ============ Step 0.7: 🧠 Temperature 调节 Agent ============
    temps = _compute_dynamic_temperatures(
        context, kg, has_similar_case=bool(similar_case)
    )
    T_candidates = temps['candidates']
    T_final = temps['final']

    # ============ Step 0.8: Step Processor（每步独立的结构化中间产物，传入动态 T） ============
    # 带跨端点缓存：/api/process 先跑了 → 这里直接复用，省掉第二次 LLM 调用
    step_card = None
    try:
        from processor import process_step
        sc_cache_k = _step_card_cache_key(context)
        if sc_cache_k in _step_card_cache:
            step_card = _step_card_cache[sc_cache_k]
            print(f'[step_card_cache] HIT step={context.step} key={sc_cache_k[:12]}')
        else:
            step_card = process_step(context, temperatures=temps)
            if len(_step_card_cache) >= _MAX_STEP_CARD_CACHE:
                old = list(_step_card_cache.keys())[: _MAX_STEP_CARD_CACHE // 2]
                for k in old: del _step_card_cache[k]
            _step_card_cache[sc_cache_k] = step_card
            print(f'[step_card_cache] SET step={context.step} key={sc_cache_k[:12]}')
    except Exception:
        step_card = None
    knowledge_refs = step_card.knowledge_refs if step_card else []

    # ============ Step 1-6: RAG Pipeline ============
    rewritten = query_rewrite(raw_user_input, context)
    sub_queries = multi_query(rewritten, context)
    knowledge = gather_knowledge(sub_queries)
    candidates = generate_multi_candidates(rewritten, knowledge, context, temperature=T_candidates)

    # 去重 & 多样性管线
    api_key = getattr(settings, 'SILICONFLOW_API_KEY', None)
    candidates = deduplicate_candidates(candidates, api_key, threshold=0.95)
    history_text = context.prev_solution or context.prev_judgment or ''
    penalize_history_similarity(candidates, history_text, api_key)
    compute_diversity_scores(candidates, api_key)
    candidates = rule_based_rerank(candidates, similar_case, kg)  # ← 加 kg
    candidates = rrf_fusion(candidates, k=settings.RRF_K)

    top = candidates[0] if candidates else None
    alternates = candidates[1:4] if len(candidates) > 1 else []

    # 最终组装答案：T-agent 动态温度 + 本屏固定格式 + 逻辑链，并且内容锚定到本屏卡片
    final_answer = _compose_final_answer(
        top, context, raw_user_input, knowledge_refs,
        soft_hints=soft_hints,
        give_solutions=give_solutions,
        history=history,
        similar_case=similar_case,
        kg=kg,  # ← 加 kg
        temperature=T_final,  # ← T-agent 动态温度
        step_card=step_card,  # ← 本屏卡片作为唯一事实源
    ) if top else '抱歉，我想想…'

    result = {
        'query_rewritten': rewritten,
        'sub_queries': sub_queries,
        'knowledge_used': [asdict(c) for c in knowledge],
        'candidates': [asdict(c) for c in candidates],
        'recommended': asdict(top) if top else None,
        'alternatives': [asdict(c) for c in alternates],
        'answer': final_answer,
        'kg_reasoning': kg['reasoning_chain'],
        'step_card': asdict(step_card) if step_card else None,
        # ← 新增：完整处理轨迹（前端渲染"体验过程"用）
        'process_trail': {
            'category_kw': kg.get('category_kw', ''),
            'category_group': kg.get('category_group', ''),
            'filled_fields': kg.get('filled_count', 0),
            'total_fields': 11,
            'kg_firing_rules': kg.get('firing_rules', []),
            'kg_valid': list(kg.get('valid_strategies', set())),
            'kg_invalid': list(kg.get('invalid_strategies', set())),
            'kg_root_causes': kg.get('root_causes', []),
            'similar_case_hit': bool(similar_case),
            'similar_case_title': (similar_case or {}).get('title', '') if similar_case else '',
            'rag_chunks': len(knowledge),
            'candidates_count': len(candidates),
            'top_direction': (asdict(top) if top else {}).get('direction', '') if top else '',
            'top_score': float(top.final_score) if top else 0.0,
        },
    }

    # ============ 写入确定性缓存 ============
    try:
        cache_k = _cache_key(context, context.step, raw_user_input[:50])
        if len(_result_cache) >= _MAX_CACHE:
            # LRU: 删一半旧的
            old = list(_result_cache.keys())[: _MAX_CACHE // 2]
            for k in old:
                del _result_cache[k]
        _result_cache[cache_k] = result
        print(f'[cache] SET step={context.step} sell={context.sell_what} key={cache_k[:8]}')
    except Exception:
        pass

    return result


def _card_to_prompt_text(card) -> str:
    """把本屏 StepCard 压成给 LLM 的事实清单，保证右侧回答和左侧卡片说同一件事。"""
    lines: List[str] = []
    if getattr(card, 'summary', ''):
        lines.append(f'结论：{card.summary}')
    for sec in getattr(card, 'sections', []) or []:
        items = sec.get('items') or []
        if not items:
            continue
        lines.append(f'[{sec.get("title", "")}]')
        for it in items[:6]:
            if isinstance(it, (list, tuple)) and len(it) >= 2:
                lines.append(f'- {it[0]}：{it[1]}')
            elif isinstance(it, dict):
                label = it.get('problem') or it.get('reason') or it.get('text') or it.get('metric') or ''
                conf = it.get('confidence')
                suffix = f'（把握 {int(conf * 100)}%）' if isinstance(conf, (int, float)) else ''
                lines.append(f'- {label}{suffix}')
            else:
                lines.append(f'- {it}')
    return '\n'.join(lines)


def _compose_final_answer(top: Candidate, context: SessionContext,
                          raw_input: str, knowledge_refs: list | None = None,
                          soft_hints: List[str] | None = None,
                          give_solutions: bool = True,
                          history: List[Dict[str, str]] | None = None,
                          similar_case: Dict[str, Any] | None = None,
                          kg: Dict[str, Any] | None = None,
                          temperature: float = 0.12,
                          step_card=None) -> str:
    """
    让 LLM 把 top1 方案用结构化格式说出来。
    升级：喂 kg（符号学习推理链）给 LLM，让 AI 的回答带上推理依据，而不是机械给方案。
    """
    kg = kg or {}
    reasoning_chain = kg.get('reasoning_chain', '')
    context_weight = kg.get('context_weight', 0.0)
    root_causes = kg.get('root_causes', [])
    valid_strategies = kg.get('valid_strategies', set())

    # 当前屏号决定输出形态：1-3 屏讲这一屏看到的/推理/诊断，4-6 屏才给方案
    screen_num = getattr(context, 'step', 1) or 1
    give_solutions = 4 <= screen_num <= 6

    soft_hints = soft_hints or []

    parts = []
    if context.sell_what: parts.append(f'卖{context.sell_what}')
    if context.where_sell: parts.append(f'在{context.where_sell}')
    if context.price: parts.append(f'每份{context.price}元')
    if context.time_slot: parts.append(f'{context.time_slot}时段')
    if context.competitors and context.competitors not in ('未填', ''): parts.append(context.competitors)
    if context.spot_type: parts.append(f'点位：{context.spot_type.split("（")[0]}')
    if context.my_difficulty: parts.append(f'困境：{context.my_difficulty.split("（")[0]}')
    context_desc = '、'.join(parts) if parts else '（摊主还没填写具体信息）'

    # 之前的判断和方案（关键！让 AI 关联前一步）
    prev_section = ''
    if context.prev_judgment:
        prev_section += f'【之前做的诊断】{context.prev_judgment}\n'
    if context.prev_solution:
        prev_section += f'【之前给的方案】{context.prev_solution}\n'
    if context.customer_action:
        prev_section += f'【顾客反应】走到摊前一般：{context.customer_action}\n'
    if context.customer_look_at:
        prev_section += f'【顾客看什么】{context.customer_look_at}\n'
    # 屏 7：老板选的效果结果 —— 必须让它决定结论，否则每次回答都一样
    if getattr(context, 'effect_result', ''):
        _eff_label = {
            'good': '明显好一些（这招起作用了）',
            'some': '好像有点（有变化但不明显）',
            'none': '没有变化（和之前一样）',
            'worse': '更差了（比改动前还差）',
        }.get(context.effect_result, context.effect_result)
        prev_section += f'【老板这轮选的效果】{_eff_label}\n'
    if prev_section:
        prev_section = '\n（之前的信息，要和当前回答关联起来，不要断片）\n' + prev_section + '\n'

    # 历史对话（最多最近 6 条 = 3 轮，加"不要重复"指令）
    history_section = ''
    if history:
        recent = history[-6:]
        lines = []
        for h in recent:
            role = h.get('role', '?')
            txt = (h.get('text', '') or '').strip()
            if txt and len(txt) > 2:
                prefix = '老板' if role == 'user' else 'AI'
                lines.append(f'{prefix}：{txt[:120]}')
        if lines:
            history_section = (
                '\n【最近对话（必须承接！之前说过的不要再重复！）】\n'
                + '\n'.join(lines) + '\n'
                + '⚠️ 规则：之前 AI 已经说过的建议/方向/推理过程，本轮不要再重复说一遍！\n'
                  '只说你上一轮没说过的新内容（新的推理、新的方向、新的细节补充）。\n'
            )

    # ========== Step-aware LSTM 约束 ==========
    step_rules = {
        1: '【当前第 1 步：摊位画像】复述你看到的信息（品类/位置/价格带/点位/竞争/困境）+ 给品类定位判断。严禁给具体方案。',
        2: '【当前第 2 步：顾客行为】从顾客行为反推卡在哪一环（看见→停下→问价→下单）。严禁给改招牌/换点位的具体方案。',
        3: '【当前第 3 步：诊断报告】指出核心矛盾和根因链（表象→中层→深层）。这是诊断，不是方案，不要给 3 条动作。',
        4: '【当前第 4 步：方案】给出今天就能做的一件具体事（动作/花费时间/退路）。要具体到摊位上的动作。',
        5: '【当前第 5 步：测量】给 2-3 个明天就能数的指标（怎么数、数什么、判什么）。不要重复方案内容。',
        6: '【当前第 6 步：执行清单】把方案拆成今天能逐条勾掉的动作。不要重复诊断推理。',
        7: ('【当前第 7 步：复盘】只针对老板这轮选的效果下结论，禁止罗列全部可能：'
            '选"明显好一些"→ 证明这招有效，给出今天继续加深/放大的具体动作；'
            '选"好像有点"→ 方向对但力度不够，指出差在哪一口气，给一个加大强度的动作；'
            '选"没有变化"→ 这招不成立，明确换方向（换成什么，不是换个说法）；'
            '选"更差了"→ 先排查外部因素（天气/城管/时段/隔壁摊位），再决定撤回还是微调。'),
    }
    step_constraint = step_rules.get(screen_num, step_rules[1])

    # ========== 相似案例（持续学习 — 注意：案例仅供参考，不能照搬） ==========
    similar_section = ''
    if similar_case and similar_case.get('case_text') and context_weight >= 0.25:
        similar_section = (
            f'\n【参考（不是照搬！）：找到一个类似摊主 — {similar_case.get("title", "")}】\n'
            f'案例：{similar_case["case_text"]}\n'
            f'⚠️ 这个案例仅供参考！最终建议必须以本摊主的问卷内容为主推理！\n'
        )

    # ========== 符号学习推理链（核心！让 LLM 基于本摊主的独立知识图谱推理） ==========
    kg_section = ''
    if reasoning_chain and context_weight >= 0.15:
        root_causes_str = '、'.join(root_causes[:3]) if root_causes else '（待推理）'
        valid_str = '、'.join(sorted(valid_strategies)) if valid_strategies else '（通用）'
        kg_section = (
            f'\n【AI 已经为这个摊主独立构建了知识图谱 — 这是你的推理依据】\n'
            f'推理链：\n{reasoning_chain}\n'
            f'→ 本摊主适合的策略方向：{valid_str}\n'
            f'→ 本摊主的困境可能根因：{root_causes_str}\n'
            f'⚠️ 必须基于以上推理链来生成建议！不是照搬案例，不是通用模板！\n'
            f'在回答开头可以自然地说一句"看你的情况，{root_causes_str.split("、")[0]}——所以先从 XX 入手"。\n'
        )
    elif context_weight < 0.2 and reasoning_chain:
        kg_section = (
            f'\n【⚠️ 问卷填得太少（只填了 {kg.get("filled_count",0) or 0}/11 项）】\n'
            f'暂时做不了精准知识图谱推理。给出方向性建议即可，不要瞎给具体方案。\n'
        )

    refs_hint = ''
    if knowledge_refs:
        refs_hint = '\n\n【悄悄参考这些知识（用到即可，别说"根据XX文档"）】：\n'
        for r in knowledge_refs:
            refs_hint += f'- {r}\n'
        refs_hint += '\n'

    # 每屏的输出形态：说什么由当前屏决定，不能一屏方案糊到底
    if screen_num == 4:
        output_format = (
            '严格按以下格式输出（中文）：\n\n'
            '自然语言开头（1-2 句大白话点核心）\n\n'
            '📦 今天就做这一件\n'
            '★ 具体动作：{action}\n'
            '★ 花多少钱 / 多久：{cost_and_time}\n'
            '★ 退路：{revert_plan}\n\n'
            '🏆 成本:xx 🏆 时间:xx 🏆 记忆:xx 🏆 识别:xx 🏆 容错:xx 🏆 特色:xx\n'
        )
    elif screen_num == 5:
        output_format = (
            '严格按以下格式输出（中文）：\n\n'
            '开头 1 句：说清"做完这件事，明天怎么判断有没有用"\n\n'
            '明天要数的 2-3 个数（每个都写成"数什么 + 怎么数 + 数到多少算有用"）\n\n'
            '⚠️ 不要给方案、不要给新动作，只讲怎么量。\n'
        )
    elif screen_num == 6:
        output_format = (
            '严格按以下格式输出（中文）：\n\n'
            '开头 1 句：今天按顺序做下面几条，做完打勾\n\n'
            '☐ 动作一（具体到手上做什么）\n'
            '☐ 动作二\n'
            '☐ 动作三（最多 4 条）\n\n'
            '⚠️ 不要重复诊断推理，不要讲道理，只给能勾掉的动作。\n'
        )
    elif screen_num == 7:
        output_format = (
            '严格按以下格式输出（中文）：\n\n'
            '开头 1-2 句：对比做之前/之后，效果到没到位\n\n'
            '✅ 有效的：…\n'
            '❌ 没动的：…\n'
            '🔧 下一轮只调这一处：…（一句话，20 字以内）\n'
        )
    else:
        # 屏 1-3：只讲这一屏看到的/推理/诊断，不给方案
        output_format = (
            '严格按以下格式输出（中文）：\n\n'
            '开头 1-2 句大白话，直接说这一屏你看到了什么、判断是什么\n\n'
            '🔍 我为什么这么判断\n'
            '★ 依据一：（结合老板填的品类/位置/时段/竞争/顾客反应）\n'
            '★ 依据二：（结合经营常识）\n\n'
            '📍 这一屏先记住这一句：{一句 20 字以内、能直接用在摊上的话}\n'
        )

    hints_section = ''
    if soft_hints:
        hints_section = (
            '\n\n【温和提示——悄悄用，自然融入回答，不要机械列表】\n'
            + '\n'.join(f'- {h}' for h in soft_hints)
            + '\n用自然的方式提一句就好，别堆太多。\n'
        )

    system = [
        {'role': 'system', 'content': (
            '你是地摊顾问，面向的是路边摊主老板（认知有限，不要说术语）。\n\n'
            '【核心原则】\n'
            '1. 永远不拒绝用户！哪怕用户啥也没说清楚，也基于已知信息给点方向性建议。\n'
            '2. 不许说"先填问卷"、"先做完诊断"这种拒绝用户的话——要自然给建议，再温和提一句"如果告诉我 XXX 就能更准"。\n'
            '3. 承接之前的对话和之前的诊断/方案——不要断片，不要凭空重新开始！\n'
            '4. 之前 AI 已经说过的内容，本轮不要再重复说一遍！只说新的。\n'
            '5. 不许编造摊主没说过的事实：招牌材质/大小/字体、商品颜色、摊位尺寸、几米几厘米这类细节，'
            '问卷里没写就绝不能当成"我看到的问题"来讲；要提也只能说"如果……建议确认一下"。\n'
            '6. 知识库案例里的具体细节（比如某案例用了 A4 纸、某案例花了 5 块钱）是别人的摊，不是这位摊主的，不许照搬成他的现状。\n\n'
            '【老板画像】\n'
            '- 认知有限，听不懂"供需错配"、"流量转化率"这种词 → 要说人话\n'
            '- 时间紧，没耐心看长文 → 每条建议控制在 20 字以内\n'
            '- 需要信任感 → 先讲"我为什么这样判断"（推理/数据），再给"你该怎么做"（结果）\n'
            '- 对"换地方"没底 → 给点位建议时一定说"什么时候人多"、"附近缺什么"\n'
            '- 对"政策"摸不清 → 可以提"最近听说这里管得松了"\n\n'
            + step_constraint + '\n\n'
            + kg_section + '\n\n'
            + similar_section + '\n\n'
            + prev_section
            + history_section
            + output_format
            + hints_section
            + refs_hint
        )},
        {'role': 'user', 'content': (
            f'摊主问题：「{raw_input}」\n'
            f'摊主已知情况：{context_desc}\n'
            + (
                (f'\n推荐方案：\n'
                 f'  方向：{top.direction}\n'
                 f'  具体做：{top.action}\n'
                 f'  成本时间：{top.cost_and_time}\n'
                 f'  退路：{top.revert_plan}\n'
                 f'  各维度分数：{top.scores}\n')
                if give_solutions else
                (f'\n本屏参考素材（只用于说明你这一屏的判断，不要当成方案输出）：\n'
                 f'  方向：{top.direction}\n'
                 f'  它想解决的问题：{top.action}\n')
            )
            + (
                ('\n【本屏卡片——这是已经算好的结论，必须原样采用，不得换成别的动作/指标/数字】\n'
                 + _card_to_prompt_text(step_card) + '\n')
                if step_card is not None else ''
            )
            + f'\n用结构化格式输出：'
        )},
    ]
    return llm.chat(system, temperature=temperature, max_tokens=600).strip()
