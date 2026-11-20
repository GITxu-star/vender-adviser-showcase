"""
Step Processor — 每步独立的信息融合 + 结构化中间产物生成

概念上等价于一个轻量 MLP 处理器：
  输入：当前步骤 + 已填问卷 + 知识库检索结果 + 历史对话
  加工：特征工程 → 多维度交叉打分 → 融合归纳
  输出：结构化中间产物卡（前端可直接渲染）

每步一张卡：
  屏 1 → 摊位画像卡 (VendorProfile)
  屏 2 → 顾客行为图谱 (CustomerGraph)
  屏 3 → 诊断报告卡 (DiagnosisReport)
  屏 4 → 方案加工卡 (SolutionCrafted)
  屏 5 → 测量指标卡 (MeasureMetric)
  屏 6 → 执行记录卡 (ActionLog)
  屏 7 → 效果复盘卡 (EffectReview)
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field, asdict
from typing import Dict, List, Any, Optional, Tuple
from enum import Enum

from pipeline import SessionContext
from rag import retrieve as rag_retrieve  # retrieve(query, top_k) → List[RetrievedChunk]


# ============================================================
# 数据结构（前端直接吃的 JSON 卡）
# ============================================================

class CardType(str, Enum):
    VENDOR_PROFILE = 'vendor_profile'       # 屏1: 摊位画像
    CUSTOMER_GRAPH = 'customer_graph'       # 屏2: 顾客行为图谱
    DIAGNOSIS_REPORT = 'diagnosis_report'   # 屏3: 诊断报告
    SOLUTION_CRAFTED = 'solution_crafted'   # 屏4: 方案加工
    MEASURE_METRIC = 'measure_metric'       # 屏5: 测量指标
    ACTION_LOG = 'action_log'               # 屏6: 执行记录
    EFFECT_REVIEW = 'effect_review'         # 屏7: 效果复盘


@dataclass
class StepCard:
    """前端渲染的中间产物卡"""
    card_type: str                    # CardType 值
    step: int                         # 对应问卷步骤 1-7
    title: str                        # 卡标题
    emoji: str                        # 小图标
    summary: str                      # 一句话摘要
    sections: List[Dict[str, Any]]    # 各区块（标题 + 内容 + 标签）
    tags: List[str] = field(default_factory=list)  # 标签
    knowledge_refs: List[str] = field(default_factory=list)  # 用到的知识片段来源


# 每一步 → 收尾的一句"接下来"
_NEXT_STEP_HINT = {
    1: '⬇️ 下一步：告诉我顾客走到你摊前一般做什么、看什么、问什么，我就能从「你卖什么」推到「他为什么不买」。',
    2: '⬇️ 下一步：进入第 3 步，我把问题到底卡在哪一环给你诊断出来。',
    3: '➡️ 下一步：进入第 4 步，我给你今天就能动手改的那一件具体事。',
    4: '➡️ 下一步：进入第 5 步，定 2-3 个明天就能数的指标，做完才知道有没有用。',
    5: '➡️ 下一步：进入第 6 步，把方案拆成今天能一条条勾掉的执行清单。',
    6: '➡️ 下一步：进入第 7 步，做完我们复盘一次，看效果到没到位。',
    7: '✅ 这一轮走完了。想再优化就回第 1 步改问卷，我按新信息重新判断。',
}


def render_card_feedback(card: StepCard, with_next: bool = True, max_items: int = 8,
                         compact: bool = False) -> str:
    """把 StepCard 渲染成一段人类可读的"当下屏反馈"。

    compact=True 时只给这一屏的结论（3-5 行），细节交给上方卡片，避免气泡把卡片再念一遍。
    """
    lines = [f'{card.emoji} **{card.title}**']
    if card.summary:
        lines.append(card.summary)

    if compact:
        # 优先挑"推理/诊断/问题/方向/指标"那一段的核心结论
        key_sec = None
        for sec in card.sections:
            title = sec.get('title') or ''
            if any(k in title for k in ('推理', '诊断', '问题', '方向', '指标', '清单', '要数', '做这一件', '复盘')):
                key_sec = sec
                break
        if key_sec is None and card.sections:
            key_sec = card.sections[0]
        if key_sec:
            items = (key_sec.get('items') or [])[:2]
            for it in items:
                if isinstance(it, dict):
                    label = it.get('problem') or it.get('reason') or it.get('text') or it.get('metric') or ''
                    conf = it.get('confidence')
                    if label and isinstance(conf, (int, float)):
                        it = f'{label}（把握 {int(conf * 100)}%）'
                    else:
                        it = label
                elif isinstance(it, (list, tuple)):
                    it = '：'.join(str(x) for x in it[:2])
                if it:
                    lines.append(f'· {it}')
        has_next_section = any('下一步' in (sec.get('title') or '') for sec in card.sections)
        if with_next:
            next_sec = next((sec for sec in card.sections if '下一步' in (sec.get('title') or '')), None)
            if next_sec and next_sec.get('items'):
                lines.append('')
                lines.append(str(next_sec['items'][0]))
            elif not has_next_section and _NEXT_STEP_HINT.get(card.step):
                lines.append('')
                lines.append(_NEXT_STEP_HINT[card.step])
        return '\n'.join(lines)

    for sec in card.sections:
        items = sec.get('items') or []
        if not items:
            continue
        lines.append('')
        lines.append(f'**{sec.get("title", "")}**')
        is_kv = sec.get('type') == 'kv'
        for it in items[:max_items]:
            if is_kv and isinstance(it, (list, tuple)) and len(it) >= 2:
                lines.append(f'· {it[0]}：{it[1]}')
            elif isinstance(it, dict):
                label = it.get('problem') or it.get('reason') or it.get('text') or it.get('metric') or ''
                conf = it.get('confidence')
                if label and isinstance(conf, (int, float)):
                    lines.append(f'· {label}（把握 {int(conf * 100)}%）')
                elif label:
                    lines.append(f'· {label}')
                else:
                    lines.append('· ' + '，'.join(f'{k}：{v}' for k, v in it.items()))
            else:
                lines.append(f'· {it}')
    has_next_section = any('下一步' in (sec.get('title') or '') for sec in card.sections)
    if with_next and not has_next_section and _NEXT_STEP_HINT.get(card.step):
        lines.append('')
        lines.append(_NEXT_STEP_HINT[card.step])
    return '\n'.join(lines)


# ============================================================
# 特征工程（轻量"MLP"的第一层：输入 → 特征向量）
# ============================================================

_CATEGORY_GROUPS: List[Tuple[List[str], str, str]] = [
    # (关键词列表, 品类组名, KG 匹配关键词)
    # 这几个必须排在"鱼/梨/衣"等宽泛词前面，否则会被误判成熟食或水果
    (['冰糖雪梨', '雪梨', '梨汤', '姜茶', '热饮', '热奶茶'], '饮品', '奶茶'),
    (['活鱼', '卖鱼', '鲫鱼', '草鱼', '鲤鱼', '带鱼', '水产', '冰鲜'], '生鲜果蔬', '水果'),
    (['烤串', '炸串', '烧烤', '肉串', '羊肉串', '烤肉', '铁板', '鱿鱼', '章鱼小丸子', '烤肠', '烤冷面'], '小吃-烧烤类', '烤串'),
    (['烤鱼', '水煮鱼', '麻辣鱼', '鱼', '烤海鲜', '虾', '生蚝', '贝'], '小吃-鱼类熟食', '烤鱼'),
    (['卤味', '卤菜', '卤肉', '熟食', '凉菜', '凉拌', '鸭脖', '鸡爪', '卤煮', '烧鸡', '酱货'], '卤味熟食', '熟食'),
    (['炸鸡', '鸡排', '鸡柳', '薯条', '汉堡', '热狗', '鸡肉卷', '炸物'], '炸制快餐', '炸鸡'),
    (['麻辣烫', '关东煮', '串串香', '冒菜', '钵钵鸡', '麻辣拌', '麻辣香锅'], '麻辣烫煮物', '麻辣烫'),
    (['臭豆腐', '豆腐', '烤红薯', '红薯', '烤玉米', '玉米', '糖葫芦', '糖画', '棉花糖'], '街头小吃', '小吃'),
    (['包子', '馒头', '煎饼', '鸡蛋灌饼', '油条', '豆浆', '粥', '早餐', '肉夹馍', '手抓饼', '煎饼果子', '卷饼', '烧饼', '锅贴', '生煎'], '早餐面点', '早餐'),
    (['炒面', '炒饭', '炒粉', '面条', '拉面', '刀削面', '米线', '米粉', '螺蛳粉', '酸辣粉', '凉皮', '擀面皮', '凉面', '盖饭', '快餐', '盒饭', '便当'], '快餐主食', '快餐'),
    (['奶茶', '咖啡', '果汁', '饮', '柠檬茶', '茶', '豆浆饮', '酸梅汤', '冰镇', '汽水'], '饮品', '奶茶'),
    (['甜品', '蛋糕', '面包', '烘焙', '冰粉', '糖水', '冰淇淋', '雪糕', '糕点', '双皮奶', '杨枝甘露'], '甜品烘焙', '甜品'),
    (['水果', '菜', '蔬', '生鲜', '瓜', '桃', '草莓', '葡萄', '梨', '苹果', '香蕉', '橘', '橙', '柚', '枣', '芒果', '菠萝', '荔枝', '龙眼', '樱桃'], '生鲜果蔬', '水果'),
    (['坚果', '炒货', '干果', '瓜子', '板栗'], '坚果炒货', '坚果'),
    (['唱歌', '驻唱', '卖唱', '点歌', '弹唱', '街头演唱', '歌手', '乐队'], '街头表演-唱歌', '唱歌'),
    (['杂技', '杂耍', '魔术', '变脸', '顶碗', '转碟', '武术表演', '街头表演', '表演'], '街头表演-杂技', '杂技'),
    (['唱片', '黑胶', '磁带', '专辑', 'CD', 'cd', '碟片', '音像'], '唱片音像', '唱片'),
    (['贴膜', '手机', '修', '配钥匙', '换电池'], '便民服务', '手机贴膜'),
    (['五金', '螺丝', '钉子', '扳手', '钳子', '锤子', '卷尺', '锯', '钻头', '水管', '水龙头', '阀门', '合页', '锁', '砂纸', '工具', '电料', '插座', '插排', '开关', '灯泡', '电线'], '五金工具', '五金'),
    (['耳机', '充电器', '充电宝', '数据线', '蓝牙', '音箱', 'U盘', '内存卡', '键盘', '鼠标', '小家电', '电风扇', '手电筒', '数码', '手机壳', '手机配件'], '电子数码', '电子'),
    (['衣', '衬衫', 'T恤', '外套', '裤子', '服', '饰', '杂货', '百货', '玩具', '饰品', '袜', '帽子', '箱包', '发饰', '文具'], '日用百货', '日用百货'),
    (['香薰', '文创', '手作', '画', '书', '手串', '编织', '陶', '明信片', '贺卡', '邮票'], '文创手工', '香薰'),
    (['花', '植物', '绿植', '多肉'], '植物类', '植物'),
    (['宠物', '猫', '狗粮', '鱼食'], '宠物用品', '宠物'),
]

# 案例库/关键词都不认识时，用 LLM 兜底归类（按品类字符串缓存，保证稳定）
_CATEGORY_FALLBACK_CACHE: Dict[str, Tuple[str, str]] = {}


def _llm_classify_category(sell: str) -> Optional[Tuple[str, str]]:
    """关键词没命中时，让 LLM 从固定品类组里选一个；失败返回 None。"""
    try:
        from llm_client import LLMClient
        options = '\n'.join(
            f'- {group}（例如：{"、".join(kws[:3])}）' for kws, group, _ in _CATEGORY_GROUPS
        )
        raw = LLMClient().chat(
            [{'role': 'user', 'content':
              f'把"地摊卖的{sell}"归到下面最接近的一类。\n{options}\n'
              f'只输出类名本身，不要解释、不要标点。如果不属于任何一类，输出：其他'}],
            temperature=0.0, max_tokens=20,
        ).strip()
        for _, group, kg_kw in _CATEGORY_GROUPS:
            if group in raw:
                return group, kg_kw
    except Exception as e:
        print(f'[category] LLM 兜底归类失败: {e}')
    return None


_FOOD_ONLY_WORDS = ('快速出餐', '出餐', '口味', '食欲', '烟火气', '分量大', '早餐组合')


def _llm_kg_reasoning(ctx, features: Dict[str, Any], rule_lines: List[str],
                      kg_causes: List[str], is_food: bool) -> List[str]:
    """规则命中 + LLM 结合实际填写做逻辑推理。

    规则库只提供候选证据，最终推理由 LLM 按这个摊的真实情况生成：
    规则和事实冲突时以事实为准（如卖面粉不能推出"快速出餐"）。
    失败则返回空列表，调用方回退到纯规则。
    """
    try:
        from llm_client import LLMClient
        evidence = '\n'.join(f'- {l}' for l in rule_lines) or '（规则库没命中，直接按事实推理）'
        if kg_causes:
            evidence += f'\n- 规则给出的可能根因：{"、".join(kg_causes[:3])}'
        facts = (
            f'卖什么：{ctx.sell_what or "未知"}；在哪卖：{ctx.where_sell or "未知"}；'
            f'价格：{ctx.price or "未知"}；日销：{ctx.daily_qty or "未知"}；'
            f'时段：{ctx.time_slot or "未知"}；场地：{ctx.weather or "未知"}；'
            f'竞争：{ctx.competitors or "未知"}；点位：{ctx.spot_type or "未知"}；'
            f'摊位情形：{ctx.stall_type or "未知"}；困境：{ctx.my_difficulty or "未知"}；'
            f'顾客动作：{ctx.customer_action or "未知"}；顾客先看：{ctx.customer_look_at or "未知"}'
        )
        forbid = (
            ''
            if is_food else
            '这是非现制餐饮的摊（或卖的是原料），严禁出现"出餐/备餐/口味/食欲/烟火气/分量"这类餐饮词。\n'
        )
        raw = LLMClient().chat_json(
            [{'role': 'user', 'content':
              f'你是地摊经营顾问，要给一个具体摊位做逻辑推理，不是套模板。\n'
              f'事实：{facts}\n'
              f'规则库候选（只当参考，可能不适用于这个摊）：\n{evidence}\n\n'
              f'要求：\n'
              f'1. 结合事实给出 2-3 条因果推理，每条是"触发条件 → 会导致什么/该注意什么"。\n'
              f'2. 条件必须来自老板填的事实，禁止编造招牌材质/尺寸/颜色/商品细节。\n'
              f'3. 规则候选与事实冲突时（比如卖原料却说快速出餐）直接丢掉，以事实为准。\n'
              f'{forbid}'
              f'4. 每条 18-40 字，说人话，老板能听懂。\n'
              f'5. confidence 取 0.5-0.9：事实越完整越高，靠猜的给低。\n'
              f'只输出 JSON：{{"reasoning":[{{"when":"...","then":"...","confidence":0.7}}]}}'}],
            temperature=0.3, max_tokens=500,
        )
        data = json.loads(raw)
        out: List[str] = []
        for it in (data.get('reasoning') or [])[:3]:
            w = str(it.get('when', '')).strip()
            t = str(it.get('then', '')).strip()
            if not w or not t:
                continue
            text = f'{w} → {t}'
            if not is_food and any(k in text for k in _FOOD_ONLY_WORDS):
                continue
            try:
                c = float(it.get('confidence', 0.6))
            except (TypeError, ValueError):
                c = 0.6
            c = max(0.45, min(0.9, c))
            out.append(f'{text}（把握 {int(c * 100)}%）')
        return out
    except Exception as e:
        print(f'[step2_diag] KG-LLM 推理失败，回退规则: {e}')
        return []


def _dynamic_confidence(r, filled: int = 0, total: int = 11) -> float:
    """把握度按"规则条件具体程度 + 问卷填充度"动态算，不再一律 95%。

    - 条件轴越多（品类+时段+困境…）→ 越具体 → 把握越高
    - 问卷没填全 → 打折（信息不足就不该装作有把握）
    """
    cond = r.condition if isinstance(r.condition, dict) else {}
    axes = [k for k in cond if k in ('sell', 'time', 'difficulty', 'competitors', 'spot')]
    conf = float(r.confidence)
    conf *= 0.80 + 0.06 * min(len(axes), 3)          # 1 轴 86% / 2 轴 92% / 3 轴 98%
    if total:
        conf *= 0.75 + 0.25 * min(1.0, filled / total)  # 问卷空一半 → 再打约 10% 折扣
    return max(0.50, min(0.95, conf))


def _rule_lines(matched_rules, sell_label: str = '', is_food: bool = True,
                filled: int = 0, total: int = 11) -> List[str]:
    """把命中的规则翻译成人话，供卡片"规则推理链"展示（按品类和问卷完整度自适应）。"""
    from rules import _filter_food_words, _adapt_root_causes

    axis_name = {'sell': '品类', 'time': '时段', 'difficulty': '困境',
                 'competitors': '竞争', 'spot': '点位'}
    lines: List[str] = []
    for r in matched_rules:
        cond = r.condition
        if cond is True or (isinstance(cond, dict) and cond.get('any')):
            continue  # 公理类（永远成立）对"原因判断"没信息量
        if not isinstance(cond, dict):
            continue
        if any(k not in axis_name or isinstance(v, (list, tuple, set, dict)) for k, v in cond.items()):
            continue  # 多值/非业务维度条件（如 spot_keywords）说不成人话，不展示
        cond_text = ' + '.join(
            f'{axis_name[k]}={sell_label if k == "sell" and sell_label else v}' for k, v in cond.items()
        )
        concl = r.conclusion or {}
        valid = _filter_food_words(concl.get('valid_add', []), is_food)
        invalid = _filter_food_words(concl.get('invalid_add', []), is_food)
        causes = _adapt_root_causes(concl.get('root_cause_add', []), is_food)
        bits = []
        if valid:
            bits.append('优先' + '、'.join(map(str, valid)))
        if invalid:
            bits.append('别做' + '、'.join(map(str, invalid)))
        if causes:
            bits.append('根因' + '、'.join(map(str, causes)))
        if not bits:
            continue
        conf = _dynamic_confidence(r, filled=filled, total=total)
        lines.append(f'{cond_text} → {"；".join(bits)}（把握 {int(conf * 100)}%）')
    return lines


# 问卷里没问过的物理细节，不许出现在诊断里（避免"招牌是A4纸打印"这种编造）
_FABRICATED_DETAIL_RE = re.compile(
    r'A[34](?:纸|打印)?|LED|灯箱|喷绘|亚克力|红底|红字|黄底|白底|'
    r'\d+\s*(?:米|厘米|cm|CM|毫米|mm|寸|号字|px)'
)


def _has_fabricated_detail(text: str, source: str) -> bool:
    """文字里出现问卷没提过的具体物理细节 → 视为编造。"""
    src = source or ''
    for m in _FABRICATED_DETAIL_RE.findall(text or ''):
        if m and m not in src:
            return True
    return False


def _infer_category_group(sell: str) -> Tuple[str, str]:
    """把老板填的 sell_what 归类成品类组（给 KG 和 LLM 用）。"""
    s = (sell or '').strip()
    if not s:
        return '其他', '其他'
    for kws, group, kg_kw in _CATEGORY_GROUPS:
        if any(k in s for k in kws):
            return group, kg_kw
    # 关键词没命中 → LLM 语义兜底（缓存，同品类永远同一结果）
    if s in _CATEGORY_FALLBACK_CACHE:
        return _CATEGORY_FALLBACK_CACHE[s]
    guess = _llm_classify_category(s)
    if guess:
        _CATEGORY_FALLBACK_CACHE[s] = guess
        return guess
    return '其他', '其他'


def _extract_features(ctx: SessionContext) -> Dict[str, Any]:
    """从问卷上下文提取结构化特征（多维度）"""
    features = {}

    # 品类归类（升级：覆盖更多品类）
    sell = ctx.sell_what or ''
    cat_group, cat_kg = _infer_category_group(sell)
    features['category'] = cat_group       # 给前端展示
    features['category_kw'] = cat_kg        # 给 KG 匹配用
    features['sell_what_raw'] = sell        # 保留原始文本给 LLM

    # 位置归类
    where = ctx.where_sell or ''
    if any(k in where for k in ['夜市', '夜']):
        features['location'] = '夜市'
    elif any(k in where for k in ['早市', '菜市场']):
        features['location'] = '早市/菜市场'
    elif any(k in where for k in ['学校', '大学']):
        features['location'] = '学校周边'
    elif any(k in where for k in ['街边', '路']):
        features['location'] = '街边流动'
    elif any(k in where for k in ['商场', '广场']):
        features['location'] = '商业广场'
    else:
        features['location'] = '其他'

    # 时段（新增）
    ts = ctx.time_slot or ''
    if any(k in ts for k in ['早', '晨', '早餐']):
        features['time_slot'] = '早市'
    elif any(k in ts for k in ['午', '中', '午餐']):
        features['time_slot'] = '午间'
    elif any(k in ts for k in ['夜', '晚', '晚餐']):
        features['time_slot'] = '夜市'
    elif any(k in ts for k in ['全天', '都摆']):
        features['time_slot'] = '全天候'
    else:
        features['time_slot'] = features.get('location', '其他')  # fallback 到 location

    # 天气/场地（新增）
    w = ctx.weather or ''
    if any(k in w for k in ['露天', '外面', '户外']):
        features['venue'] = '露天'
    elif any(k in w for k in ['遮阳', '棚']):
        features['venue'] = '有遮阳棚'
    elif any(k in w for k in ['室内', '商场']):
        features['venue'] = '室内'
    else:
        features['venue'] = '不确定'

    # 竞争环境（新增）
    comp = ctx.competitors or ''
    if any(k in comp for k in ['独门', '唯一', '没有']):
        features['competitors'] = '独门生意'
    elif any(k in comp for k in ['不多', '少']):
        features['competitors'] = '竞争少'
    elif any(k in comp for k in ['多', '好多', '一堆']):
        features['competitors'] = '竞争激烈'
    else:
        features['competitors'] = '未填'

    # 价格带
    try:
        p = float((ctx.price or '0').replace('元', '').strip())
        if p <= 5:
            features['price_band'] = '5元以下'
        elif p <= 10:
            features['price_band'] = '5-10元'
        else:
            features['price_band'] = '10元以上'
    except (ValueError, TypeError):
        features['price_band'] = '未填'

    # ── 基于 24 种实拍场景推断摆法特征 ──
    stall = ctx.stall_type or ''

    # 1) 有没有招牌 / 广告牌
    if any(k in stall for k in ['什么也不摆', '靠老板吆喝', '一张桌子上面放商品']):
        features['has_sign'] = '无招牌'
    elif any(k in stall for k in ['旁边放个广告牌', '旁边安个大喇叭', '价目表']):
        features['has_sign'] = '有辅助广告（广告牌/喇叭/价目表）'
    elif any(k in stall for k in ['招牌在地上', '招牌在车顶', '既有招牌也有广告']):
        features['has_sign'] = '有招牌'
    else:
        features['has_sign'] = '未判断'

    # 2) 商品能不能被路过的人一眼看见
    if any(k in stall for k in ['四周被挡着看不见', '什么也不摆', '卡车上直接放上价目表', '一张桌子上面放商品']):
        features['visibility'] = '商品不易看见'
    elif any(k in stall for k in ['四周透亮', '摊车上既有招牌也有广告、也有移动的很多张折叠桌椅']):
        features['visibility'] = '商品清楚可见'
    else:
        features['visibility'] = '一般'

    # 3) 固定 / 流动
    if any(k in stall for k in ['流动三轮车', '面包车', '卡车上', '门口上学高峰和放学高峰摆', '节庆热闹摊', '大型活动摊']):
        features['mobility'] = '流动/半固定（周期性摆）'
    elif any(k in stall for k in ['社区固定摊', '商场摊', '地铁旁的摊', '公园摊', '工地、工厂门头']):
        features['mobility'] = '固定点位'
    else:
        features['mobility'] = '一般'

    # 4) 场景位置标签（给 LLM 参考）
    location_hints = []
    for kw, label in [
        ('校门', '校园周边'), ('工地', '工地/工厂周边'),
        ('景区', '景区场景'), ('古街', '文旅街区'),
        ('节庆', '节庆/活动场景'), ('大型活动', '活动场景'),
        ('地铁', '交通枢纽'), ('公园', '公园/休闲'),
        ('商场', '商场周边'), ('社区', '社区固定点'),
    ]:
        if kw in stall:
            location_hints.append(label)
    features['scene_tags'] = location_hints if location_hints else ['街边/常规']

    # 5) 经营状态（结合摆法简陋度推断）
    raw = stall + (ctx.sell_what or '')
    if any(k in stall for k in ['什么也不摆', '靠老板吆喝']) and features['has_sign'] == '无招牌':
        features['status'] = '摆法简陋，起步/挣扎中'
    elif '高档移动摊车' in stall:
        features['status'] = '有投入，想往上走'
    else:
        features['status'] = '正常经营' if stall else '未填'

    # 规模
    daily = (ctx.daily_qty or '').lower()
    if not daily or daily in ('未填', ''):
        features['scale'] = '未填'
    elif any(k in daily for k in ['100', '50-100', '50以上']):
        features['scale'] = '日销 50+'
    elif any(k in daily for k in ['20-50', '20以上']):
        features['scale'] = '日销 20-50'
    else:
        features['scale'] = '日销偏少（你填的是"' + daily + '" → 推测）'

    # 价格带（只有真填了才推理）
    price_raw = (ctx.price or '').strip()
    if not price_raw or price_raw in ('未填', ''):
        features['price_band'] = '未填'
    else:
        # 尝试从文字里抽数字
        import re
        nums = re.findall(r'\d+', price_raw)
        if nums:
            avg = sum(int(n) for n in nums) / len(nums)
            if avg < 10: features['price_band'] = '低价（<10元）'
            elif avg < 25: features['price_band'] = '中低（10-25元）'
            elif avg < 50: features['price_band'] = '中高（25-50元）'
            else: features['price_band'] = '高价（>50元）'
        else:
            features['price_band'] = price_raw  # 填了文字但没数字 → 直接显示

    # ── 老板填的「点位类型」→ 直接转 location_premium ──
    spot = ctx.spot_type or ''
    competitors = ctx.competitors or ''

    if any(k in spot for k in ['斑马线', '路口转角', '公园转角']):
        features['location_premium'] = '⭐ 天然流量红利（转角/斑马线 = 360° 人流经过）'
    elif any(k in spot for k in ['老片区']):
        features['location_premium'] = '⚠️ 存量萎缩（老片区住户在减少，继续熬是慢性死亡）'
    elif any(k in spot for k in ['热门街区']):
        features['location_premium'] = '🔥 流量充裕但竞争白热化（你多我就少）'
    elif any(k in spot for k in ['校门口']):
        features['location_premium'] = '⏰ 强时段红利（只有上下学 1 小时窗口，但刚需）'
    elif any(k in spot for k in ['地铁旁']):
        features['location_premium'] = '🚇 通勤流红利（早高峰 7-9 点 + 晚高峰 17-19 点）'
    elif any(k in spot for k in ['工地', '工厂']):
        features['location_premium'] = '🏗️ 刚需稳定客群（早餐/午餐定点刚需）'
    elif any(k in spot for k in ['商场']):
        features['location_premium'] = '🛍️ 逛街流（但商场对摊位管理严格）'
    else:
        features['location_premium'] = '未判断'

    # ── 供需压力（用户有限 vs 摊位扩张） ──
    if competitors == '竞争激烈':
        features['supply_pressure'] = '🔴 供给过剩（你选"竞争激烈" → 用户就这么多，每家分到的在减少）'
    elif competitors == '竞争少':
        features['supply_pressure'] = '🟡 有空间（竞争少 → 要么这片人还够，要么摊位还没涌过来）'
    elif competitors == '独门生意':
        features['supply_pressure'] = '🟢 独占红利（政策松绑初期或真·独家，建立品牌窗口期）'
    else:
        features['supply_pressure'] = '未判断'

    # ── 顾客批量出现的时间窗口 ──
    time_slot = ctx.time_slot or ''
    if any(k in spot for k in ['校门口']):
        features['crowd_timing'] = '上学 7:00-8:30 / 放学 16:30-18:00（2 个精准窗口）'
    elif any(k in spot for k in ['工地', '工厂']):
        features['crowd_timing'] = '早餐 6:30-8:00 / 午餐 11:00-12:30（2 个刚需窗口）'
    elif any(k in spot for k in ['地铁旁']) or '早市' in time_slot:
        features['crowd_timing'] = '通勤早高峰 7:00-9:00（错过就没了）'
    elif any(k in spot for k in ['公园']) or '夜市' in time_slot:
        features['crowd_timing'] = '傍晚 17:30-20:30（散步/遛弯高峰，强依赖天气）'
    elif any(k in spot for k in ['热门街区', '节庆', '活动']):
        features['crowd_timing'] = '全天分散但夜市 18:00-22:00 最集中'
    else:
        features['crowd_timing'] = time_slot or '未填'

    # ── 老板自己说的困境 → 直接注入 reasoning ──
    diff = ctx.my_difficulty or ''
    if diff:
        features['reasoning_input'] = f'老板自述困境：{diff}'
    else:
        features['reasoning_input'] = ''

    return features


def _cross_match(features: Dict[str, Any], knowledge_chunks: List[Dict]) -> List[Tuple[int, float]]:
    """
    多维度交叉打分（轻量"MLP"的第二层：特征 × 知识 → 相关度）

    不是简单 cosine，而是多维度加权：
      - 品类匹配度（权重 0.4）
      - 位置匹配度（权重 0.3）
      - 状态匹配度（权重 0.2）
      - 语义相似度（权重 0.1，已在 chunk.score 里）
    """
    weights = {'category': 0.4, 'location': 0.3, 'status': 0.2, 'semantic': 0.1}

    results = []
    for i, chunk in enumerate(knowledge_chunks):
        text = chunk.get('text', '')
        score = chunk.get('score', 0.0)

        dim_scores = {'semantic': score}  # 已有的向量相似度

        # 品类匹配
        cat = features.get('category', '')
        if cat and cat != '其他':
            keywords = cat.split('-')[-1] if '-' in cat else cat
            dim_scores['category'] = 1.0 if keywords in text else (0.3 if any(k in text for k in ['摊', '经营', '招牌']) else 0.0)
        else:
            dim_scores['category'] = 0.2

        # 位置匹配
        loc = features.get('location', '')
        if loc and loc != '其他':
            dim_scores['location'] = 1.0 if loc in text else (0.3 if any(k in text for k in loc.split('/')) else 0.0)
        else:
            dim_scores['location'] = 0.2

        # 状态匹配
        st = features.get('status', '')
        if '困难' in st or '差' in st:
            dim_scores['status'] = 0.8 if any(k in text for k in ['改进', '问题', '提升', '改']) else 0.2
        else:
            dim_scores['status'] = 0.4

        # 加权融合
        final = sum(dim_scores[d] * weights.get(d, 0) for d in weights)
        results.append((i, final, dim_scores))

    # 按融合分排序
    results.sort(key=lambda x: -x[1])
    return results


# ============================================================
# 每步独立处理器
# ============================================================

def _process_step1(ctx: SessionContext, features: Dict[str, Any], temperatures=None) -> StepCard:
    """
    Step 1 → 摊位画像卡（**只展示 + 温和提示，不推核心矛盾**）

    Step-gated reasoning:
      step 1 → "你是谁"（品类定位 + 基础画像）→ 温和提示下一步
      step 2 → "顾客怎么反应"（顾客行为图谱）
      step 3 → "问题在哪"（视觉/陈列诊断）
      step 4 → "今天就能做的事"（动线+摆法具体方案）
    """
    rag_chunks = rag_retrieve(f"{features.get('category_kw', '')} {features.get('location', '')} 经营要点", top_k=2)
    chunk_dicts = [{'text': c.content, 'score': c.score, 'source': c.source} for c in rag_chunks]
    top_chunks = chunk_dicts[:1] if chunk_dicts else []

    # ── 1. 📊 我看到的（只展示老板真填的，未填不脑补） ──
    data_rows = []
    sell_raw = features.get('sell_what_raw') or ctx.sell_what
    if sell_raw and sell_raw != '未填':
        data_rows.append(('你在卖', sell_raw))
    data_rows.append(('品类归类', features.get('category', '未填')))
    where = ctx.where_sell or ''
    if where and where != '未填':
        data_rows.append(('在哪卖', where))
    if features.get('price_band') and features['price_band'] != '未填':
        data_rows.append(('价格带', features['price_band']))
    if features.get('scale') and features['scale'] != '未填':
        data_rows.append(('日销量', features['scale']))
    else:
        data_rows.append(('日销量', '未填（知道大概量级更好）'))

    # ── 2. 🧠 品类定位推理（用老板真实写的品类，KG 关键词只在内部用） ──
    reasoning_lines = []
    kw = features.get('category_kw', '')
    sell_name = (sell_raw or '').strip()
    if len(sell_name) > 14:
        sell_name = sell_name[:14]
    sell_name = sell_name or '你的货'
    ts = ctx.time_slot or ''
    spot = ctx.spot_type or ''
    competitors = ctx.competitors or ''

    # 定位推理：这个品类在什么场景下成立
    if kw in ('烤鱼', '烤串'):
        if '夜市' in ts or '傍晚' in ts or '夜市' in where:
            reasoning_lines.append(f'🔥 {sell_name} × 夜市 → 成立！夜市人走得慢、愿意停下来吃热的、愿意等几分钟')
        elif '早市' in ts or '早' in ts:
            reasoning_lines.append(f'⚠️ {sell_name} × 早市 → 不太对。早上人赶时间，不愿意等热的，建议考虑"早上卖别的、晚上卖{sell_name}"')
        else:
            reasoning_lines.append(f'📋 {sell_name} → 成立。什么时段都能卖，但"顾客什么时候最多"决定了你怎么摆')
    elif kw == '快餐':
        if any(k in sell_name for k in ('炒', '煎', '炸', '铁板', '手抓饼', '烤冷面')):
            speed = '10 秒看见、30 秒下单、3-5 分钟出第一份'
        elif any(k in sell_name for k in ('烤串', '烧烤', '烤鱼', '生蚝', '麻辣烫', '煮')):
            speed = '10 秒看见、30 秒下单、5-8 分钟出一份'
        elif any(k in sell_name for k in ('卤', '凉', '包', '甜品', '水果', '饮', '茶', '寿司')):
            speed = '10 秒看见、30 秒问价、1 分钟内递到手上'
        else:
            speed = '10 秒看见、30 秒问价、1 分钟内让顾客弄明白你卖什么'
        reasoning_lines.append(f'⚡ {sell_name} → 成立。顾客来你的原因是"快"，摆法和窗口要围绕"{speed}"')
    elif kw == '奶茶':
        reasoning_lines.append(f'🥤 {sell_name} → 成立。你的核心是"路过随手买一杯"，视觉（杯子颜色/造型）比味道更重要')
    elif kw == '手机贴膜':
        reasoning_lines.append(f'🔧 {sell_name} → 成立。你的核心是"等一下就好"，需要一个让人愿意站 2-3 分钟的等待区（哪怕是个小板凳）')
    elif kw == '水果':
        reasoning_lines.append(f'🍎 {sell_name} → 成立。堆头视觉是关键——顾客第一眼看见的是"有没有食欲"，不是"多少钱一斤"')
    elif kw != '其他':
        reasoning_lines.append(f'📋 {sell_name}（{features.get("category", "")}）→ 成立。我记下了，等你告诉我顾客反应就能更精准判断')
    else:
        reasoning_lines.append(f'{sell_name} → 我记下了，等你告诉我顾客走到摊前会做什么，就能开始判断')

    # ── 3. ➡️ 下一步提示（温和引导，不推核心矛盾） ──
    hint_lines = [
        '⬇️ 点下一步告诉我：顾客走到你摊前一般做什么、看什么、问什么？',
    ]
    if competitors == '竞争激烈':
        hint_lines.insert(0, '竞争激烈 → 记住：别打价格战，得让顾客"因为你家特殊而停下来"')
    if spot and '热门街区' in spot:
        hint_lines.insert(0, '热门街区 → 记住：人很多但走得快，"一眼看见卖什么"比"摆得多漂亮"重要')

    sections = [
        {'title': '📊 摊位基础画像', 'type': 'kv', 'items': data_rows},
        {'title': '🧠 品类定位推理', 'type': 'tree', 'items': reasoning_lines},
        {'title': '➡️ 下一步做什么', 'type': 'list', 'items': hint_lines},
    ]

    knowledge_refs = [c.get('source', '') for c in top_chunks if c]

    return StepCard(
        card_type=CardType.VENDOR_PROFILE.value,
        step=1,
        title='摊位画像 + 初步定位',
        emoji='🛒',
        summary=f"你在{where or '某处'}卖{sell_raw or '东西'}，我记下了，下一步告诉我顾客反应就能开始判断",
        sections=sections,
        tags=[features.get('category', '')],
        knowledge_refs=knowledge_refs,
    )


def _process_step2(ctx: SessionContext, features: Dict[str, Any], temperatures=None) -> StepCard:
    """屏 2 → 顾客行为图谱"""
    chunks = rag_retrieve(f"顾客行为 {ctx.customer_action} {','.join(ctx.customer_look_at.split(','))} 分析", top_k=2)
    chunk_dicts = [{'text': c.content, 'score': c.score, 'source': c.source} for c in chunks]
    matched = _cross_match(features, chunk_dicts)
    top_chunks = [chunk_dicts[i] for i, _, _ in matched[:1]] if matched else []

    # 行为→问题根因的关联度打分
    behavior = ctx.customer_action or ''
    look_at = ctx.customer_look_at or ''

    # ====== 🧠 KG 符号推理：先从规则图推出根因，作为"证据底座" ======
    kg_causes: List[str] = []
    kg_lines: List[str] = []
    try:
        from rules import get_graph, is_food_category
        matched_rules = get_graph().match({
            'sell': features.get('category_kw', '') or '',
            'time': features.get('time_slot', ''),
            'difficulty': ctx.my_difficulty or '',
            'competitors': ctx.competitors or '',
            'spot': features.get('location', ''),
        })
        # 品类是餐饮还是非餐饮 → 决定能不能用"出餐/口味/食欲"这类措辞
        is_food = is_food_category(f'{features.get("category", "")} {ctx.sell_what or ""}')
        _, _, kg_causes, _ = get_graph().resolve_conflicts(matched_rules, is_food=is_food)
        kg_causes = [c for c in kg_causes if c][:4]
        filled = sum(1 for v in [
            ctx.sell_what, ctx.where_sell, ctx.price, ctx.daily_qty,
            ctx.stall_fixed, ctx.daily_hours, ctx.stall_type, ctx.time_slot,
            ctx.competitors, ctx.spot_type, ctx.my_difficulty,
        ] if v and v not in ('未填', ''))
        rule_lines = _rule_lines(
            matched_rules, sell_label=(ctx.sell_what or '').strip()[:12],
            is_food=is_food, filled=filled, total=11,
        )[:3]
        # 规则推理 + LLM 按本摊实际填写做逻辑推理；LLM 不可用才回退纯规则
        kg_lines = _llm_kg_reasoning(ctx, features, rule_lines, kg_causes, is_food) or rule_lines
    except Exception as e:
        print(f'[step2_diag] KG 推理失败: {e}')

    problem_links = []
    if '看一眼就走' in behavior or '不看' in behavior:
        problem_links.append({'problem': '视觉吸引力不足', 'confidence': 0.85})
    if '走得快' in behavior or '路过' in behavior:
        problem_links.append({'problem': '没有停步理由', 'confidence': 0.75})
    if '看了又走' in behavior or '犹豫' in behavior:
        problem_links.append({'problem': '价格/品质不确定', 'confidence': 0.70})
    if '看手机' in behavior:
        problem_links.append({'problem': '被注意力分散', 'confidence': 0.50})
    if '排队' in behavior or '等着' in behavior:
        problem_links.append({'problem': '出品速度慢', 'confidence': 0.65})
    if not problem_links:
        problem_links.append({'problem': '观察不够', 'confidence': 0.30})

    # ====== 原因预估：高 T + KG 证据，避免永远"吸引力不够/观察不够" ======
    t2 = float(((temperatures or {}).get('step2_diag') or 0))
    if t2 > 0.30 and behavior:
        try:
            from llm_client import LLMClient
            chunk_text = ' / '.join((c.get('text') or '')[:90] for c in top_chunks)
            raw = LLMClient().chat_json(
                [{'role': 'user', 'content':
                  f'你是地摊经营顾问。摊主卖{ctx.sell_what or "未知"}，在{ctx.where_sell or "未知"}，'
                  f'时段{ctx.time_slot or "未知"}，周边竞争：{ctx.competitors or "未知"}，自述困境：{ctx.my_difficulty or "未填"}。\n'
                  f'摊位类型：{ctx.stall_type or "未填"}（招牌：{features.get("has_sign", "未判断")}；商品可见度：{features.get("visibility", "一般")}）\n'
                  f'顾客典型动作：{behavior}；顾客一般先看：{look_at or "未填"}。\n'
                  f'知识图谱推出的可能根因：{"；".join(kg_causes) if kg_causes else "无"}\n'
                  f'知识库片段：{chunk_text or "无"}\n\n'
                  f'请给出 2-3 条"这一摊具体可能的原因"，必须落在可观察的细节上。\n'
                  f'禁止使用"观察不够""吸引力不足""没有停步理由"这类空话，除非能补出具体证据。\n'
                  f'严禁编造问卷里没有的物理细节：不许说"A4纸打印""字几厘米""招牌几米高""什么颜色"之类，'
                  f'只能用上面的摊位类型、顾客动作、困境作为证据。\n'
                  f'每条 problem 12-22 个字，要能对上顾客的动作或关注点；confidence 在 0.4-0.9。\n'
                  f'只输出 JSON：{{"problems":[{{"problem":"商品被围挡挡住，路过的人看不到","confidence":0.72}}]}}'}],
                temperature=t2, max_tokens=400,
            )
            data = json.loads(raw)
            evidence_src = ' '.join([
                ctx.sell_what or '', ctx.stall_type or '', ctx.where_sell or '',
                behavior, look_at, ctx.my_difficulty or '', ctx.competitors or '', ctx.spot_type or '',
            ])
            parsed = []
            for it in (data.get('problems') or [])[:3]:
                p = str(it.get('problem', '')).strip()
                if not p:
                    continue
                if _has_fabricated_detail(p, evidence_src):
                    print(f'[step2_diag] 丢弃编造细节: {p}')
                    continue
                try:
                    c = float(it.get('confidence', 0.6))
                except (TypeError, ValueError):
                    c = 0.6
                parsed.append({'problem': p, 'confidence': max(0.3, min(0.9, c))})
            if parsed:
                problem_links = parsed
                print(f'[step2_diag] LLM 原因推断 T={t2} → {len(parsed)} 条')
        except Exception as e:
            print(f'[step2_diag] LLM 失败，回退规则路径: {e}')

    sections = [
        {
            'title': '顾客行为',
            'type': 'kv',
            'items': [
                ('典型动作', behavior or '未填'),
                ('一般先看', look_at or '未填'),
            ]
        },
        {
            'title': '可能的问题方向',
            'type': 'confidence',
            'items': problem_links
        }
    ]
    if kg_lines:
        sections.append({'title': '🧠 规则推理链（KG）', 'type': 'list', 'items': kg_lines})

    knowledge_refs = [c.get('source', '') for c in top_chunks if c]

    return StepCard(
        card_type=CardType.CUSTOMER_GRAPH.value,
        step=2,
        title='顾客行为图谱',
        emoji='👀',
        summary=f"顾客{behavior or '行为待观察'}，注意力在{look_at or '不明'}",
        sections=sections,
        tags=[b['problem'] for b in problem_links[:2]],
        knowledge_refs=knowledge_refs,
    )


def _process_step3(ctx: SessionContext, features: Dict[str, Any], temperatures: Dict[str, float] | None = None) -> StepCard:
    """屏 3 → 诊断报告卡（AI 判断的结构化展示）"""
    # 用完整上下文搜知识
    chunks = rag_retrieve(
        f"{features.get('category', '')} {features.get('location', '')} 问题 诊断 {ctx.customer_action}",
        top_k=3
    )
    chunk_dicts = [{'text': c.content, 'score': c.score, 'source': c.source} for c in chunks]
    matched = _cross_match(features, chunk_dicts)
    top_chunks = [chunk_dicts[i] for i, _, _ in matched[:2]] if matched else []

    # ====== 一MLP：纯规则路径（格式必须 100% 确定整齐，不给 LLM 碰）======
    problem_tree = []
    if not problem_tree:
        j = ctx.prev_judgment or ''
        if j:
            lines = j.split('\n')
            for line in lines:
                line = line.strip()
                if line and len(line) > 3:
                    problem_tree.append(line)
        if not problem_tree:
            problem_tree = [f"可能是{features.get('category', '')}在{features.get('location', '')}吸引力不够"]

    sections = [
        {
            'title': '问题树（根因分析）',
            'type': 'tree',
            'items': problem_tree
        },
        {
            'title': '诊断依据',
            'type': 'list',
            'items': [
                f"摊位：{features.get('category', '')} @ {features.get('location', '')}",
                f"状态：{features.get('status', '')}",
                f"顾客：{ctx.customer_action or '待补充'}",
            ]
        }
    ]

    knowledge_refs = [c.get('source', '') for c in top_chunks if c]

    return StepCard(
        card_type=CardType.DIAGNOSIS_REPORT.value,
        step=3,
        title='诊断报告',
        emoji='🔍',
        summary=f"主要问题：{problem_tree[0] if problem_tree else '待生成'}",
        sections=sections,
        tags=problem_tree[:2],
        knowledge_refs=knowledge_refs,
    )


def _guess_problems(features: Dict[str, Any]) -> List[str]:
    """根据特征预猜可能的问题方向"""
    guesses = []
    cat = features.get('category', '')
    loc = features.get('location', '')
    st = features.get('status', '')

    if '夜市' in loc:
        guesses.append('夜间视觉吸引')
    if '街边' in loc:
        guesses.append('路过不留步')
    if '经营困难' in st:
        guesses.append('复购/口碑不足')
    if '烧烤' in cat or '小吃' in cat:
        guesses.append('出品速度')
    if not guesses:
        guesses = ['信息不足，继续填']
    return guesses


# ============================================================
# 主入口
# ============================================================

def process_step(ctx: SessionContext, temperatures: Dict[str, float] | None = None) -> StepCard:
    """
    主入口：根据当前步骤，跑对应处理器，产出一张结构化卡

    Args:
        ctx: 当前 session 上下文（问卷填的所有内容）
        temperatures: T-agent 算出的各 step 动态温度（可选，给了就让 processor 在 step3-6 里调 LLM 生成更有个性的推理）

    用法：
        card = process_step(context)  # 纯规则路径（step 1-2）
        card = process_step(context, temps)  # 动态 T 路径（step 3-6）
    """
    step = ctx.step
    features = _extract_features(ctx)

    handlers = {
        1: _process_step1,
        2: _process_step2,
        3: _process_step3,
        4: _process_step4,
        5: _process_step5,
        6: _process_step6,
        7: _process_step7,
    }

    handler = handlers.get(step, _process_generic)
    return handler(ctx, features, temperatures=temperatures)


# ---- 屏 4-7 处理器（细化版） ----

def _process_step4(ctx: SessionContext, features: Dict[str, Any], temperatures=None) -> StepCard:
    """屏 4 → 方案加工卡：把 prev_solution 拆成具体动作清单 + 成本/退路"""
    chunks = rag_retrieve(
        f"{features.get('category', '')} {features.get('time_slot', '')} 低成本 快速见效 改进方案", top_k=2)
    chunk_dicts = [{'text': c.content, 'score': c.score, 'source': c.source} for c in chunks]

    solution = ctx.prev_solution or ''
    cost_guess = _estimate_cost(features)
    time_guess = _estimate_time(features)

    # ====== 一MLP：纯规则路径（格式必须 100% 确定整齐，不给 LLM 碰）======
    actions = _extract_actions(solution) if solution else ['先填完诊断，AI 才能给具体方案']
    if solution and not actions:
        # 方案文本不可解析（或只剩占位文案）→ 用品类给出可执行的兜底动作
        cat = features.get('category', '') or '你的招牌货'
        actions = [f'把「{cat}」最拿手的一件摆到最前面，让人一眼看到']

    # "太难了/砍简单点" → 只留最小的一步，成本和耗时一起砍
    msg = getattr(ctx, 'user_message', '') or ''
    simplify_intent = any(k in msg for k in ('太难', '砍简', '简化', '简单点', '太复杂', '做不了'))
    if simplify_intent and solution:
        actions = [actions[0], '其他都先别管——今天只做这一件']
        cost_guess, time_guess = '0-10 元', '10-15 分钟'

    sections = [
        {
            'title': '今天就做这一件',
            'type': 'list',
            'items': actions
        },
        {
            'title': '成本预估',
            'type': 'kv',
            'items': [
                ('花费', cost_guess),
                ('耗时', time_guess),
                ('退路', _guess_fallback(features)),
            ]
        },
        {
            'title': '预期效果',
            'type': 'confidence',
            'items': _guess_impact(features)
        }
    ]

    return StepCard(
        card_type=CardType.SOLUTION_CRAFTED.value,
        step=4, title='方案加工', emoji='📦',
        summary=f"今天花{cost_guess}，{time_guess}做完",
        sections=sections,
        knowledge_refs=[c.get('source', '') for c in chunk_dicts if c.get('score', 0) > 0.3][:2],
    )


# 品类 → 三个基础指标的本地叫法：(指标名, 怎么数, 单位)
_METRIC_TRIOS: Dict[str, List[Tuple[str, str, str]]] = {
    '小吃-烧烤类': [
        ('路过摊前的人', '数 5 分钟内经过你摊前的人', '人'),
        ('闻到味停下的人', '数有多少人走着走着停下、往炉子这边看', '人'),
        ('买串的人', '数收钱次数（几单）', '单'),
    ],
    '小吃-鱼类熟食': [
        ('路过摊前的人', '数 5 分钟内经过你摊前的人', '人'),
        ('停下问价的人', '数有多少人停下来问「怎么卖」', '人'),
        ('买鱼的人', '数成交单数', '单'),
    ],
    '卤味熟食': [
        ('路过摊前的人', '数 5 分钟内经过你摊前的人', '人'),
        ('停下看柜的人', '数有多少人停下往你的熟食盘/柜里看', '人'),
        ('称重成交的人', '数称了几次、收了几次钱', '单'),
    ],
    '炸制快餐': [
        ('路过摊前的人', '数 5 分钟内经过你摊前的人', '人'),
        ('闻到油香停下的人', '数有多少人被味道拉住、回头看摊', '人'),
        ('买的人', '数收钱次数', '单'),
    ],
    '麻辣烫煮物': [
        ('路过摊前的人', '数 5 分钟内经过你摊前的人', '人'),
        ('停下看菜盆的人', '数有多少人低头看菜盆、拿夹子', '人'),
        ('下单的人', '数成交单数', '单'),
    ],
    '街头小吃': [
        ('路过摊前的人', '数 5 分钟内经过你摊前的人', '人'),
        ('停下看摊的人', '数有多少人放慢脚步、转头看你摊', '人'),
        ('买的人', '数收钱次数', '单'),
    ],
    '早餐面点': [
        ('路过摊前的人', '数 5 分钟内经过你摊前的人', '人'),
        ('停下看蒸笼的人', '数有多少人停下看蒸笼/问「有什么」', '人'),
        ('买的人', '数装袋次数', '单'),
    ],
    '快餐主食': [
        ('路过摊前的人', '数 5 分钟内经过你摊前的人', '人'),
        ('抬头看菜单的人', '数有多少人停下抬头看你的菜单/招牌', '人'),
        ('下单的人', '数成交单数', '单'),
    ],
    '饮品': [
        ('路过摊前的人', '数 5 分钟内经过你摊前的人', '人'),
        ('停下看菜单的人', '数有多少人站在摊前看菜单、看杯子', '人'),
        ('买单的人', '数卖出几杯', '杯'),
    ],
    '甜品烘焙': [
        ('路过摊前的人', '数 5 分钟内经过你摊前的人', '人'),
        ('停下看展示的人', '数有多少人低头看你摆出来的成品', '人'),
        ('买的人', '数装盒次数', '单'),
    ],
    '生鲜果蔬': [
        ('路过摊前的人', '数 5 分钟内经过你摊前的人', '人'),
        ('停下挑的人', '数有多少人停下拿起你的货翻看', '人'),
        ('成交的人', '数收钱次数', '单'),
    ],
    '坚果炒货': [
        ('路过摊前的人', '数 5 分钟内经过你摊前的人', '人'),
        ('停下抓看的人', '数有多少人伸手抓一把、问价格', '人'),
        ('称重成交的人', '数称重次数', '单'),
    ],
    '便民服务': [
        ('路过摊前的人', '数 5 分钟内经过你摊前的人', '人'),
        ('停下问价的人', '数有多少人停下来问「这个多少钱/要多久」', '人'),
        ('成交的人', '数实际接单次数', '单'),
    ],
    '日用百货': [
        ('路过摊前的人', '数 5 分钟内经过你摊前的人', '人'),
        ('停下翻看的人', '数有多少人停下翻你摊上的货', '人'),
        ('成交的人', '数收钱次数', '单'),
    ],
    '文创手工': [
        ('路过摊前的人', '数 5 分钟内经过你摊前的人', '人'),
        ('拿起来看的人', '数有多少人拿起明信片/手作翻看', '人'),
        ('成交的人', '数收钱次数', '单'),
    ],
    '植物类': [
        ('路过摊前的人', '数 5 分钟内经过你摊前的人', '人'),
        ('停下摸问的人', '数有多少人停下摸叶子、问怎么养', '人'),
        ('成交的人', '数卖出几盆/几束', '单'),
    ],
    '宠物用品': [
        ('路过摊前的人', '数 5 分钟内经过你摊前的人', '人'),
        ('停下逗看的人', '数有多少人蹲下看、逗宠物用品', '人'),
        ('成交的人', '数收钱次数', '单'),
    ],
    '街头表演-唱歌': [
        ('路过摊前的人', '数 5 分钟内经过你表演区的人', '人'),
        ('停超过 3 秒的人', '数有多少人听到后停住、往你这边看', '人'),
        ('点歌/打赏的人', '数点歌次数 + 打赏次数', '次'),
    ],
    '街头表演-杂技': [
        ('路过摊前的人', '数 5 分钟内经过你表演区的人', '人'),
        ('停下围观的人', '数有多少人停下围成半圈', '人'),
        ('看完整场/打赏的人', '数留到最后 30 秒的人 + 打赏次数', '次'),
    ],
    '唱片音像': [
        ('路过摊前的人', '数 5 分钟内经过你摊前的人', '人'),
        ('停下翻碟的人', '数有多少人蹲下翻你的碟箱', '人'),
        ('成交的人', '数卖出几张', '张'),
    ],
}

_DEFAULT_TRIO: List[Tuple[str, str, str]] = [
    ('路过摊前的人', '数 5 分钟内经过你摊前的人', '人'),
    ('停下看的人', '数有多少人放慢脚步、转头看你摊', '人'),
    ('买的人', '数收钱次数', '单'),
]


def _metric_trio(cat: str) -> List[Tuple[str, str, str]]:
    if cat in _METRIC_TRIOS:
        return _METRIC_TRIOS[cat]
    for k, v in _METRIC_TRIOS.items():
        if k and (k in cat or cat in k):
            return v
    return _DEFAULT_TRIO


def _measure_targets(ctx: SessionContext, features: Dict[str, Any]) -> Dict[str, Any]:
    """按竞争 / 点位 / 天气，算出这摊今天的"及格线"（不是一套放之四海皆准的数）。"""
    comp = ctx.competitors or ''
    spot = ctx.spot_type or ''
    venue = ctx.weather or ''

    # 1) 5 分钟路过人数基准（点位决定流量）
    flow = 10
    for kw, v in [('斑马线', 20), ('路口', 20), ('地铁', 25), ('校门', 15), ('工地', 8),
                  ('工厂', 8), ('热门街区', 18), ('公园', 10), ('商场', 10),
                  ('老片区', 6), ('社区', 6), ('节庆', 15), ('活动', 15)]:
        if kw in spot:
            flow = v
            break

    # 2) 停步率门槛（竞争越激烈，越要证明你能抢到注意力）
    if '激烈' in comp:
        stop_rate, comp_reason = 0.25, '竞争激烈，同行在抢同一批人，停步不够就等于没抢到'
    elif '独门' in comp:
        stop_rate, comp_reason = 0.10, '独门生意，没有替代品，有人停下就说明被看见了'
    else:
        stop_rate, comp_reason = 0.15, '竞争少，主要吃自然流量'

    # 3) 点位修正：快流点停留率天然低，逛的场景停留率高
    if any(k in spot for k in ('地铁', '路口', '斑马线', '校门', '工地', '工厂')):
        stop_rate *= 0.8
        spot_note = '这个点位人走得快，停留天然少'
    elif any(k in spot for k in ('公园', '热门街区', '商场', '节庆')):
        stop_rate *= 1.2
        spot_note = '这个点位的人愿意逛，停留会多一点'
    else:
        spot_note = '按常规人流节奏算'

    stop = max(2, round(flow * stop_rate))
    comp_reason = f'{comp_reason}；{spot_note}，所以此摊的停步率门槛是 {int(stop_rate * 100)}%'

    # 4) 成交门槛（转化率）
    buy_rate = 0.30 if '激烈' in comp else (0.50 if '独门' in comp else 0.40)
    buy = max(1, round(stop * buy_rate))

    # 5) 天气/环境规则 —— 只保留和这个品类、这个场地真正相关的条目，不再每次都是同一套通用话
    cat = features.get('category', '') or ''
    cat_raw = f'{ctx.sell_what or ""}{cat}'
    hot_cat = any(k in cat_raw for k in ('烤', '炒', '炸', '煎', '汤', '面', '粥', '卤', '麻辣烫', '早餐', '热'))
    cold_cat = any(k in cat_raw for k in ('冰', '冷饮', '雪糕', '冰淇淋', '凉', '水果', '生鲜', '饮'))
    night = ('夜市' in (ctx.where_sell or '')) or ('晚' in (ctx.time_slot or ''))
    weather_lines: List[str] = []
    if '室内' in venue:
        weather_lines.append(f'室内摊位：外面下雨反而是好事，停下目标按 {stop} 人照常，下雨天可提到 {stop + 1} 人')
        weather_lines.append('只有一种情况要改：外面暴雨导致整条街没人，别硬守，提前收')
    elif '遮阳' in venue:
        weather_lines.append(f'有棚/遮阳：小雨和暴晒影响不大，停下 ≥{stop} 人照常执行')
        weather_lines.append(f'下大雨：路过人数会腰斩，改看停步率 ≥{int(stop_rate * 100)}%，棚下能站住人就是优势')
    else:
        per = max(2, round(100 / max(1, int(stop_rate * 100))))
        weather_lines.append(
            f'露天·下雨：路过目标（{flow} 人）直接作废，只数停步率 ≥{int(stop_rate * 100)}%，'
            f'约每 {per} 个路过的人里至少 1 个停下'
        )
        if hot_cat:
            weather_lines.append(f'露天·降温/大风：{cat}反而好卖，停下目标提到 {stop + 2} 人，趁别人收摊')
        elif cold_cat:
            weather_lines.append(f'露天·升温：{cat}是窗口，停下目标提到 {stop + 2} 人、成交提到 {buy + 1} 单')
        else:
            weather_lines.append('露天·晴天：按上面的数正常执行；突然下雨就别追路过人数，只看有没有人主动问价')
    if night:
        weather_lines.append('夜市遇雨会提前散场：收摊比平时早 30-60 分钟，今天备货按七成准备')
    weather_lines.append('天气突变时，先重新数 5 分钟路过人数，按新基数重算，别拿昨天的数对比')

    return {
        'flow': flow, 'stop': stop, 'buy': buy,
        'stop_rate_pct': int(stop_rate * 100),
        'comp_reason': comp_reason,
        'weather_lines': weather_lines,
    }


def _process_step5(ctx: SessionContext, features: Dict[str, Any], temperatures=None) -> StepCard:
    """屏 5 → 测量指标卡：按竞争/点位/天气实时算及格线，帮摊主用一句话数数"""
    cat = features.get('category', '')
    t = _measure_targets(ctx, features)

    # 品类 → 三个基础指标的本地叫法，避免所有摊位都是"路过/停下/买"
    trio = _metric_trio(cat)
    targets = [t['flow'], t['stop'], t['buy']]
    metric_items = [
        (name, f'{how}（≥{targets[i]} {unit}）')
        for i, (name, how, unit) in enumerate(trio)
    ]

    # 第 4 个指标跟着"这招到底做了什么"走，避免每屏都是同一套三个数
    act_text = ctx.prev_solution or ''
    if any(k in act_text for k in ('镜子', '照')):
        a_name, a_how = '照镜子的人', '数有多少人停下来照镜子、顺一下头发'
    elif any(k in act_text for k in ('招牌', '纸板', '牌子', '字')):
        a_name, a_how = '抬头看招牌的人', '数有多少人抬头看你牌子超过 1 秒'
    elif any(k in act_text for k in ('试吃', '尝')):
        a_name, a_how = '试吃的人', '数有多少人接过试吃'
    elif any(k in act_text for k in ('音响', '音乐', '唱')):
        a_name, a_how = '听停的人', '数有多少人听到声音后停住超过 3 秒'
    elif any(k in act_text for k in ('炒', '烤', '炸', '煎', '闻')):
        a_name, a_how = '闻味回头的人', '数有多少人走过又回头找味道来源'
    elif '花' in act_text:
        a_name, a_how = '拿起来看的人', '数有多少人拿起花束翻价签'
    elif any(k in act_text for k in ('明信片', '卡片', '唱片', 'CD')):
        a_name, a_how = '翻看的人', '数有多少人拿起来翻看'
    elif any(k in act_text for k in ('堆', '金字塔', '码')):
        a_name, a_how = '堆头回头的人', '数有多少人走过堆头后又回头'
    else:
        a_name, a_how = '开口问价的人', '数有多少人主动问「多少钱」'
    a_num = max(1, round(t['stop'] * 0.5))
    metric_items.append((a_name, f'{a_how}（≥{a_num} 人）'))

    sections = [
        {'title': '明天要数这 4 个数（每个数 5 分钟）', 'type': 'kv', 'items': metric_items},
        {
            'title': '为什么是这个数',
            'type': 'list',
            'items': [
                f'你卖「{ctx.sell_what or "招牌货"}」，按「{(ctx.spot_type or "未填").split("（")[0]}」的人流节奏，5 分钟约碰到 {t["flow"]} 人',
                f'竞争「{ctx.competitors or "未填"}」→ 停下目标 {t["stop"]} 人：{t["comp_reason"]}',
                f'转化按 {int(t["buy"] / t["stop"] * 100)}% 算 → 成交目标 {t["buy"]} 单',
            ]
        },
        {
            'title': '判断有没有用',
            'type': 'list',
            'items': [
                f'✅ 成立：停下 ≥{t["stop"]} 人，且成交 ≥{t["buy"]} 单',
                f'⚠️ 看到了没买：停下 ≥{t["stop"]} 但成交 <{t["buy"]} → 价格/话术问题，不是展示问题',
                f'🔁 没被看见：路过 ≥{t["flow"]} 但停下 <{t["stop"]} → 招牌/摆法不到位',
                f'❌ 别怪方案：5 分钟路过 <{t["flow"]} 人 → 是点位/时段/天气问题',
            ]
        },
        {'title': '☔ 天气一变，标准跟着变', 'type': 'list', 'items': t['weather_lines']},
    ]

    return StepCard(
        card_type=CardType.MEASURE_METRIC.value,
        step=5, title='测量指标', emoji='📏',
        summary=f'5 分钟：路过≥{t["flow"]}、停下≥{t["stop"]}、成交≥{t["buy"]}，才算这招成立',
        sections=sections,
        knowledge_refs=[],
    )


def _process_step6(ctx: SessionContext, features: Dict[str, Any], temperatures=None) -> StepCard:
    """屏 6 → 执行记录卡：确认做完了 + 留个简单 checklist"""
    solution = ctx.prev_solution or ''

    # ====== 一MLP：纯规则路径（格式必须 100% 确定整齐，不给 LLM 碰）======
    check_items = _extract_actions(solution) if solution else ['按屏 4 的方案执行']
    if solution and not check_items:
        cat = features.get('category', '') or '你的招牌货'
        check_items = [f'把「{cat}」最拿手的一件摆到最前面，让人一眼看到']

    sections = [
        {
            'title': '执行清单',
            'type': 'tag',
            'items': [f'☐ {a}' for a in check_items]
        },
        {
            'title': '做完了吗？',
            'type': 'list',
            'items': [
                '点下面「我做完了」按钮 → 系统会记下来',
                '明天看屏 7 回来看结果',
            ]
        }
    ]

    return StepCard(
        card_type=CardType.ACTION_LOG.value,
        step=6, title='执行记录', emoji='✅',
        summary='做完勾一下，明儿回来看效果',
        sections=sections,
        knowledge_refs=[],
    )


def _process_step7(ctx: SessionContext, features: Dict[str, Any], temperatures=None) -> StepCard:
    """屏 7 → 效果复盘卡：根据结果给出方向"""
    solution = ctx.prev_solution or ''
    plan_lines = [l.strip() for l in solution.split('\n') if l.strip()]
    plan_lines = [l for l in plan_lines if not _PLACEHOLDER_RE.search(l)][:3]
    plan_text = '；'.join(plan_lines) if plan_lines else '还没有执行方案'
    cat = features.get('category', '') or ''

    # 按老板选的效果分支出不同的结论和下一步（不再是同一段通用复盘）
    eff = ctx.effect_result or ''
    if eff == 'good':
        verdict = '有效，接着加深，不要换方向'
        logic = [
            f'停下来的人明显变多 → 「{plan_text[:26]}」这条路对「{cat or "这个品类"}」是成立的',
            '只加深不换招：前面那几件每天换成当天最拿得出手的，位置再往人流方向挪半步',
            '连续做 3 天，第 4 天再数一次停步率；稳住了就把这招固定成每晚的规矩',
        ]
    elif eff == 'some':
        verdict = '有点用但没到位，加大执行强度'
        logic = [
            '变化不大但方向没跑偏 → 多半是执行力度或位置差了一口气',
            '今天只改一件事：提前 30 分钟摆好、把主推往前再推 20cm、价格牌放大一号',
            '明天只数一个数：停下的人有没有比今天再多 2 个；有就继续，没有就换方向',
        ]
    elif eff == 'none':
        verdict = '这招无效，换方向，别再改说法'
        logic = [
            '停下来的人没变 → 说明问题不在「怎么说」，而在卖点或位置本身',
            '回屏 3 选一个不同方向（换卖点），不要在同一招上加字、换配色',
            f'{cat or "这个品类"}在「{ctx.spot_type or "当前点位"}」连续两招都没反应时，优先换点位或换时段',
        ]
    elif eff == 'worse':
        verdict = '变差了，先止损再复盘'
        logic = [
            '比之前更差 → 先排除外部原因：天气、城管、隔壁摊位、时段变化',
            '外部都正常 → 立刻撤回这招，回到改动前的摆法，别硬撑',
            f'这次组合（{plan_text[:26]}）在当前点位/天气下不成立，记下来，下次别再用',
        ]
    else:
        verdict = '先选一个结果，我才能判断下一步'
        logic = [
            '停下的人多了 → 加深这招',
            '看一眼就走还是那么多 → 换方向',
            '买的人多了但利润没涨 → 回屏 1 调价格',
        ]

    sections = [
        {
            'title': '复盘结论',
            'type': 'list',
            'items': logic,
        },
        {
            'title': '记忆你之前的方案',
            'type': 'list',
            'items': [plan_text]
        }
    ]

    return StepCard(
        card_type=CardType.EFFECT_REVIEW.value,
        step=7, title='效果复盘', emoji='📊',
        summary=verdict,
        sections=sections,
        knowledge_refs=[],
    )


# ---- 屏 4-7 共用的小工具 ----

_PLACEHOLDER_RE = re.compile(r'按方案执行|砍到只剩一件事|其他都先别管|先填完诊断|还没有执行方案')


def _extract_actions(solution: str) -> List[str]:
    """从 AI 方案文本里拆出具体动作"""
    if not solution:
        return []
    lines = [l.strip() for l in solution.replace('★', '\n').split('\n') if l.strip()]
    actions = []
    for l in lines:
        # 跳过开头标签
        for prefix in ['具体动作', '★', '-', '1.', '2.', '3.', '📦']:
            if l.startswith(prefix):
                l = l[len(prefix):].strip()
        if l and len(l) >= 2 and len(l) <= 50 and not _PLACEHOLDER_RE.search(l):
            actions.append(l)
    return actions[:3]


def _estimate_cost(features: Dict[str, Any]) -> str:
    """估算成本"""
    cat = features.get('category', '')
    competitors = features.get('competitors', '')
    if '竞争激烈' in competitors:
        return '50-100 元'
    if '烧烤' in cat:
        return '20-50 元'
    if '饮品' in cat:
        return '10-30 元'
    return '10-50 元'


def _estimate_time(features: Dict[str, Any]) -> str:
    """估算时间"""
    loc = features.get('location', '')
    if '夜市' in loc:
        return '15-30 分钟'
    if '早市' in loc:
        return '10-20 分钟'
    return '20 分钟'


def _guess_fallback(features: Dict[str, Any]) -> str:
    """退路"""
    venue = features.get('venue', '')
    if '露天' in venue:
        return '大不了下雨就收摊'
    return '随时可以撤，没库存风险'


def _guess_impact(features: Dict[str, Any]) -> List[Dict]:
    """预期效果置信度"""
    cat = features.get('category', '')
    return [
        {'problem': '停下来看的人增加', 'confidence': 0.65},
        {'problem': '成交单数增加', 'confidence': 0.55},
    ]


def _process_generic(ctx, features, temperatures=None):
    return StepCard(
        card_type='generic', step=ctx.step,
        title=f'第 {ctx.step} 步中间产物', emoji='✨',
        summary='继续填，AI 会生成更多',
        sections=[], knowledge_refs=[],
    )


if __name__ == '__main__':
    # 快速自测
    ctx = SessionContext(
        sell_what='炸鸡', where_sell='街边夜市', price='8',
        daily_qty='20-50', stall_fixed='固定', daily_hours='8 小时以上',
        stall_type='做了一阵但没起色', step=1,
    )
    card = process_step(ctx)
    print(json.dumps(asdict(card), ensure_ascii=False, indent=2))
