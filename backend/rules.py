"""
规则引擎 —— 符号学习的核心。

规则不是 if-else 硬编码，而是带 metadata 的对象：
    Rule(condition, conclusion, confidence, priority, dependencies, source)

冲突消解：同 condition 下 conclusion 互斥时，按 confidence × priority 胜者生效。
依赖图：规则可以声明依赖（比如"竞争激烈→差异化" 依赖 "是夜市"）。
自动归纳：从案例库文本里用 LLM 提取新规则 → 写入规则库 → 下次生效。
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field, asdict
from typing import List, Dict, Set, Optional, Any, Tuple
from collections import defaultdict


# ===== 数据结构 =====

@dataclass
class Rule:
    """
    condition:   触发条件（自然语言或结构化 dict）
                 e.g. {"sell": "烤鱼", "time": "夜市"}  或  "品类是烤鱼+时段是夜市"
    conclusion:  结论（对策略方向的判断）
                 e.g. {"valid_add": "视觉展示"}  或  {"invalid_add": "定价战"}
    confidence:  置信度 0~1（人工种子规则=1.0，LLM 归纳的案例规则=0.6~0.85）
    priority:    优先级 0~10（行业公理=10，品类通用=7，案例归纳=4）
    dependencies: 前置依赖（触发该规则需要先满足的其他规则 conclusion）
                 e.g. ["category_time_sell_strategy"]
    source:      规则来源（"seed", "case_induced", "llm_inferred"）
    rule_id:     唯一 ID
    apply_count: 被命中次数（运行时更新）
    success_rate: 命中后被 LLM 回答采用的比例（运行时更新）
    """
    condition: Any
    conclusion: Dict[str, Any]          # {"valid_add": [..], "invalid_add": [..], "root_cause_add": [..]}
    confidence: float = 0.7
    priority: int = 5
    dependencies: List[str] = field(default_factory=list)
    source: str = "seed"
    rule_id: str = ""
    apply_count: int = 0
    success_rate: float = 0.5

    @property
    def strength(self) -> float:
        """规则强度 = confidence × priority/10（冲突消解时比较）。"""
        return self.confidence * self.priority / 10.0


# ===== 品类适配：非餐饮摊不许出现餐饮专属措辞 =====

# 只有现制餐饮才成立的策略词（饰品/文创/便民服务说"别做快速出餐"完全脱离场景）
_FOOD_ONLY_STRATEGIES = {
    '快速出餐', '分量大', '口味重', '特色口味', '烟火气',
    '早餐定位', '早餐组合', '早高峰抓牢', '切盒即拿', '夜市场景', '温暖感',
}
# 只有餐饮才成立的根因词
_FOOD_ONLY_CAUSE_HINTS = ('食欲', '口味', '出餐')
# 非餐饮时把餐饮根因换成同义的通用说法
_ROOT_CAUSE_REWRITE = {
    '产品外观没引起食欲/兴趣': '产品外观没勾起兴趣',
    '口味/质量不稳定': '质量/水准不稳定',
}
_FOOD_GROUP_HINTS = (
    '小吃', '熟食', '炸', '麻辣烫', '早餐', '快餐', '饮品', '甜品',
    '生鲜', '水果', '坚果', '烤', '卤', '街头小吃', '煮物', '面点', '主食',
)


_RAW_MATERIAL_HINTS = (
    '面粉', '挂面', '原料', '粮油', '干货', '冻品', '批发', '散装', '半成品', '调料',
)


def is_food_category(group_or_sell: str) -> bool:
    """品类是否属于餐饮/现制食品（决定能不能用"出餐/口味/食欲"这类措辞）。

    卖原料（面粉/粮油/干货）不算现制餐饮——不能对卖面粉的说"做好出餐速度"。
    """
    text = group_or_sell or ''
    if any(k in text for k in _RAW_MATERIAL_HINTS):
        return False
    return any(k in text for k in _FOOD_GROUP_HINTS)


def _filter_food_words(items, is_food: bool) -> List[str]:
    if is_food:
        return [x for x in (items or []) if x]
    return [x for x in (items or []) if x and x not in _FOOD_ONLY_STRATEGIES]


def _adapt_root_causes(causes, is_food: bool) -> List[str]:
    """非餐饮品类：剔除/改写餐饮专属根因，保证推理不脱离实际场景。"""
    out: List[str] = []
    for rc in causes or []:
        if not rc:
            continue
        if is_food:
            out.append(rc)
            continue
        if any(k in rc for k in _FOOD_ONLY_CAUSE_HINTS):
            out.append(_ROOT_CAUSE_REWRITE.get(rc, '商品本身没让人产生兴趣'))
        else:
            out.append(rc)
    return out


# ===== 种子规则库（行业公理 + 品类通用） =====

def _build_seed_rules() -> List[Rule]:
    """手工种子规则——行业公理，confidence=1.0，priority=10。"""
    rules: List[Rule] = []

    # —— 组 1：品类 × 时段 → 策略有效性（最高优先级）——
    cat_time_data = [
        # ((品类kw, 时段kw), (valid, invalid))
        # —— 餐饮类 ——
        (("烤鱼", "夜市"), (["视觉展示", "特色口味", "烟火气"], ["定价战", "快速出餐"])),
        (("烤鱼", "傍晚"), (["视觉展示", "特色口味", "烟火气"], ["定价战", "快速出餐"])),
        (("烤鱼", "早市"), (["快速出餐", "便携包装", "早餐定位"], ["视觉展示", "烟火气"])),
        (("烤串", "夜市"), (["烟火气", "视觉展示", "社交属性"], ["定价战"])),
        (("烤串", "傍晚"), (["烟火气", "视觉展示", "社交属性"], ["定价战"])),
        (("烤串", "午休"), (["快速出餐", "性价比"], ["烟火气"])),
        (("快餐", "午间"), (["快速出餐", "性价比", "套餐组合"], ["视觉展示", "烟火气"])),
        (("快餐", "夜市"), (["分量大", "口味重"], ["快速出餐"])),
        (("快餐", "早市"), (["快速出餐", "便携包装", "早餐组合"], ["视觉展示"])),
        (("早餐类", "早市"), (["快速出餐", "便携包装", "温暖感"], ["视觉展示"])),
        (("早餐类", "全时段"), (["早高峰抓牢", "便携包装"], ["视觉展示"])),
        # —— 饮品类 ——
        (("奶茶", "全时段"), (["价格带锚定", "视觉展示", "组合营销"], ["特色口味", "快速出餐"])),
        (("奶茶", "早市"), (["早餐组合", "便携包装"], ["视觉展示"])),
        # —— 果蔬类 ——
        (("水果", "全时段"), (["堆头视觉", "价格牌醒目", "组合装"], ["快速出餐"])),
        (("水果", "傍晚"), (["夜市场景", "切盒即拿"], [""])),
        # —— 便民服务类 ——
        (("手机贴膜", "全时段"), (["招牌醒目", "等待区舒适"], ["快速出餐", "定价战"])),
        # —— 五金类（按需购买，不是冲动型消费）——
        (("五金", "全时段"), (["按用途分区", "规格价目表", "常用件备货足", "缺货代购"], ["堆头视觉", "定价战"])),
        (("螺丝", "全时段"), (["按规格分格", "整包拆零", "常用件备货足"], ["堆头视觉"])),
        # —— 电子配件类（要能试、要敢保）——
        (("电子", "全时段"), (["现场通电试用", "兼容性对照表", "售后包换", "配件墙陈列"], ["快速出餐", "烟火气", "定价战"])),
        (("数据线", "全时段"), (["现场试充", "接口对照表", "包换承诺"], ["快速出餐"])),
        # —— 其他 ——
        (("香薰", "全时段"), (["视觉展示", "试用体验"], ["快速出餐", "定价战"])),
        (("其他", "全时段"), (["观察客流", "小范围试错"], ["大规模投入"])),
    ]
    for (cat_kw, time_kw), (vs, ivs) in cat_time_data:
        rules.append(Rule(
            rule_id=f"CT::{cat_kw}+{time_kw}",
            condition={"sell": cat_kw, "time": time_kw},
            conclusion={"valid_add": vs, "invalid_add": ivs},
            confidence=1.0, priority=10,
            dependencies=[],
            source="seed",
        ))

    # —— 组 2：困境 → 根因推理链 ——
    diff_root_data = [
        ("路过的人根本注意不到", ["视觉吸引力不足", "招牌太小/太脏", "摊位太平没层次", "位置可能不在人流主视线"]),
        ("注意到了但不停", ["陈列没勾起兴趣", "没让人一眼看到卖啥", "环境噪音/视觉干扰多"]),
        ("停下了但不买", ["价格锚定没做好", "产品外观没引起食欲/兴趣", "没给下单理由"]),
        ("买过的不再来", ["口味/质量不稳定", "没有记忆点", "没有复购激励"]),
        ("旁边比我便宜", ["陷入价格战", "没有差异化价值", "顾客只认价"]),
        ("被城管赶", ["点位不稳定", "需要找长期点位"]),
        ("没地方摆", ["点位选择问题", "可能需要换时间/换地段"]),
        ("没生意", ["多因素：视觉+定价+产品+位置", "需要做诊断找核心"]),
    ]
    for diff_kw, causes in diff_root_data:
        rules.append(Rule(
            rule_id=f"DIFF::{diff_kw}",
            condition={"difficulty": diff_kw},
            conclusion={"root_cause_add": causes},
            confidence=0.95, priority=9,
            dependencies=[],
            source="seed",
        ))

    # —— 组 3：竞争 → 策略约束 ——
    comp_data = [
        ("竞争激烈", ["差异化"], ["定价战"]),
        ("独门", ["品牌建立"], ["定价战"]),
        ("竞争少", ["主动扩客"], []),
    ]
    for comp_kw, vs, ivs in comp_data:
        rules.append(Rule(
            rule_id=f"COMP::{comp_kw}",
            condition={"competitors": comp_kw},
            conclusion={"valid_add": vs, "invalid_add": ivs},
            confidence=0.85, priority=8,
            dependencies=[],
            source="seed",
        ))

    # —— 组 4：点位 → 策略优先级 ——
    spot_data = [
        (["校门口", "工地", "地铁"], ["快速出餐"], ["视觉展示"], "强时段点位"),
        (["夜市", "热门街区", "公园", "古街"], ["视觉展示"], ["快速出餐"], "休闲点位"),
    ]
    for kws, vs, ivs, label in spot_data:
        rules.append(Rule(
            rule_id=f"SPOT::{label}",
            condition={"spot_keywords": kws},
            conclusion={"valid_add": vs, "invalid_add": ivs},
            confidence=0.8, priority=7,
            dependencies=[],
            source="seed",
        ))

    # —— 组 5：硬公理（违反=必败）——
    rules.append(Rule(
        rule_id="AXIOM::price_war_never",
        condition={"any": True},
        conclusion={"invalid_add": ["定价战"]},
        confidence=1.0, priority=10,
        dependencies=[],
        source="seed",
    ))

    return rules


# ===== 规则图（依赖 + 触发） =====

class RuleGraph:
    """规则图：存储所有规则，支持条件匹配 + 依赖消解 + 冲突消解。"""

    def __init__(self):
        self.rules: Dict[str, Rule] = {}
        self._load_or_init()

    def _load_or_init(self):
        path = os.path.join(os.path.dirname(__file__), 'data', 'rules.json')
        if os.path.exists(path):
            try:
                with open(path, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                for r in data:
                    self.rules[r['rule_id']] = Rule(**r)
                print(f'[KG] 从 rules.json 加载 {len(self.rules)} 条规则')
                return
            except Exception as e:
                print(f'[KG] rules.json 加载失败，重建: {e}')

        # 初始化种子规则
        for r in _build_seed_rules():
            self.rules[r.rule_id] = r
        print(f'[KG] 初始化种子规则 {len(self.rules)} 条')
        self._save()

    def _save(self):
        path = os.path.join(os.path.dirname(__file__), 'data')
        os.makedirs(path, exist_ok=True)
        path = os.path.join(path, 'rules.json')
        try:
            with open(path, 'w', encoding='utf-8') as f:
                json.dump([asdict(r) for r in self.rules.values()], f, ensure_ascii=False, indent=2)
        except Exception as e:
            print(f'[KG] rules.json 保存失败: {e}')

    def add_rule(self, rule: Rule):
        """新增规则（案例归纳或 LLM 推理的），自动去重 + 冲突消解。"""
        if rule.rule_id in self.rules:
            # 已存在 → 合并（confidence 取 max，priority 取 max）
            existing = self.rules[rule.rule_id]
            existing.confidence = max(existing.confidence, rule.confidence)
            existing.priority = max(existing.priority, rule.priority)
            existing.apply_count = existing.apply_count + rule.apply_count
        else:
            self.rules[rule.rule_id] = rule
        self._save()

    def match(self, context_dict: Dict[str, Any]) -> List[Rule]:
        """从 context 里匹配所有触发的规则。"""
        matched: List[Rule] = []
        sell = context_dict.get('sell', '') or ''
        time_slot = context_dict.get('time', '') or ''
        difficulty = context_dict.get('difficulty', '') or ''
        competitors = context_dict.get('competitors', '') or ''
        spot = context_dict.get('spot', '') or ''

        for rid, r in self.rules.items():
            cond = r.condition

            # —— 品类 × 时段 ——
            if 'sell' in cond and 'time' in cond:
                cat_kw = cond['sell']
                time_kw = cond['time']
                if cat_kw in sell and (time_kw in time_slot or time_kw == '全时段'):
                    matched.append(r); continue

            # —— 困境 ——
            if 'difficulty' in cond:
                dkw = cond['difficulty']
                if dkw and (dkw in difficulty or difficulty in dkw):
                    matched.append(r); continue

            # —— 竞争 ——
            if 'competitors' in cond:
                ckw = cond['competitors']
                if ckw and ckw in competitors:
                    matched.append(r); continue

            # —— 点位关键词列表 ——
            if 'spot_keywords' in cond:
                if any(k in spot for k in cond['spot_keywords']):
                    matched.append(r); continue

            # —— 硬公理 ——
            if cond.get('any'):
                matched.append(r); continue

        return matched

    def resolve_conflicts(self, matched: List[Rule], is_food: bool = True) -> Tuple[Set[str], Set[str], List[str], List[str]]:
        """
        冲突消解 + 依赖图执行。

        is_food=False 时剔除餐饮专属策略/改写餐饮根因——饰品、文创、便民服务
        这类摊位不该出现"别做快速出餐""没引起食欲"的推理。

        Returns: (valid_union, invalid_union, root_causes, firing_explanations)
        """
        # —— Step 1: 按 conclusion 类型分桶 ——
        valid_map: Dict[str, Rule] = {}     # strategy → 最强规则
        invalid_map: Dict[str, Rule] = {}
        root_cause_list: List[str] = []
        firing_explanations: List[str] = []

        for r in matched:
            r.apply_count += 1
            conf = r.conclusion

            rule_valid = _filter_food_words(conf.get('valid_add', []), is_food)
            rule_invalid = _filter_food_words(conf.get('invalid_add', []), is_food)

            for s in rule_valid:
                existing = valid_map.get(s)
                if not existing or r.strength > existing.strength:
                    valid_map[s] = r

            for s in rule_invalid:
                existing = invalid_map.get(s)
                if not existing or r.strength > existing.strength:
                    invalid_map[s] = r

            for rc in _adapt_root_causes(conf.get('root_cause_add', []), is_food):
                if rc not in root_cause_list:
                    root_cause_list.append(rc)

            firing_explanations.append(
                f'[{r.source}:{r.rule_id}] conf={r.confidence} prio={r.priority} '
                f'+valid={rule_valid} -invalid={rule_invalid}'
            )

        # —— Step 2: invalid 覆盖 valid（如果同 strategy 出现两边）——
        # 策略：invalid 中的 strategy 从 valid 中移除
        final_valid = {s for s in valid_map if s not in invalid_map}
        final_invalid = set(invalid_map.keys())

        return final_valid, final_invalid, root_cause_list, firing_explanations


def _parse_rule_json(raw) -> List[Dict[str, Any]]:
    """把 LLM 返回的原始文本解析成规则 dict 列表（容忍 ```json 包裹 / 对象包数组）。"""
    if not raw:
        return []
    if isinstance(raw, dict):
        for key in ('rules', 'items', 'data', 'result'):
            if isinstance(raw.get(key), list):
                return raw[key]
        return [raw]
    if isinstance(raw, list):
        return [x for x in raw if isinstance(x, dict)]

    text = str(raw).strip()
    if text.startswith('```'):
        text = text.split('```')[1] if '```' in text[3:] else text[3:]
        if text.lstrip().lower().startswith('json'):
            text = text.lstrip()[4:]
    text = text.strip()
    try:
        parsed = json.loads(text)
    except Exception:
        start, end = text.find('['), text.rfind(']')
        if start == -1 or end <= start:
            return []
        try:
            parsed = json.loads(text[start:end + 1])
        except Exception:
            return []
    if isinstance(parsed, dict):
        for key in ('rules', 'items', 'data', 'result'):
            if isinstance(parsed.get(key), list):
                return parsed[key]
        return [parsed]
    if isinstance(parsed, list):
        return [x for x in parsed if isinstance(x, dict)]
    return []


# ===== Phase B: LLM 从案例库归纳规则 =====

def induce_rules_from_case(case_text: str, llm_client=None) -> List[Rule]:
    """
    用 LLM 从一个案例文本里归纳 (条件→结论) 规则。
    返回的规则 confidence=0.75, priority=4, source="case_induced"。
    """
    if not case_text or len(case_text) < 20 or llm_client is None:
        return []

    prompt = (
        f"阅读以下摊主案例，归纳出 1~3 条可泛化的经营规则。\n"
        f"规则格式：什么品类+什么时段+什么竞争+什么困境 → 应该做什么 / 不应该做什么。\n"
        f"只输出 JSON 对象，不要解释。格式：\n"
        f'{{"rules": [{{"cond": {{"sell": "...", "time": "...", "competitors": "...", "difficulty": "..."}}, '
        f'"should": ["..."], "should_not": ["..."]}}]}}\n'
        f"案例：{case_text[:600]}"
    )

    try:
        raw = llm_client.chat_json(
            [{'role': 'user', 'content': prompt}],
            max_tokens=500, temperature=0.2,
        )
        raw_rules = _parse_rule_json(raw)
        if not raw_rules:
            return []

        induced: List[Rule] = []
        for i, rr in enumerate(raw_rules[:3]):
            cond_dict = rr.get('cond', {})
            if not cond_dict:
                continue
            cond_key = '+'.join(f'{k}={v}' for k, v in sorted(cond_dict.items()) if v)
            rule_id = f"IND::{cond_key}#{i}"
            induced.append(Rule(
                rule_id=rule_id,
                condition=cond_dict,
                conclusion={
                    "valid_add": rr.get('should', []),
                    "invalid_add": rr.get('should_not', []),
                },
                confidence=0.75, priority=4,
                dependencies=[],
                source="case_induced",
            ))
        return induced
    except Exception as e:
        print(f'[KG] 案例规则归纳失败: {e}')
        return []


# ===== 全局单例 =====

_graph: Optional[RuleGraph] = None

def get_graph() -> RuleGraph:
    global _graph
    if _graph is None:
        _graph = RuleGraph()
    return _graph
