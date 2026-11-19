"""FastAPI entry point.

Render 部署说明：
  服务类型: Web Service（Free 层即可）
  Build Command: pip install -r requirements.txt
  Start Command: uvicorn main:app --host 0.0.0.0 --port $PORT
  环境变量:
    DEEPSEEK_API_KEY        ← 必填
    SILICONFLOW_API_KEY     ← 必填（embedding）
    FRONTEND_URL            ← 你的 Netlify 地址（允许的 CORS 来源）
"""
import os
import sys
import hmac
import time
from collections import defaultdict
from pathlib import Path

# 确保 backend 目录在 sys.path（Render 从 backend/ 启动时也能找到）
sys.path.insert(0, str(Path(__file__).parent))

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Dict, Optional, Any

from config import settings


# ============ 启动前：确保向量库存在 ============
def _ensure_vector_db():
    """冷启动时若向量库缺失或为空，自动重建。"""
    db_path = Path(settings.VECTOR_DB_PATH)
    if db_path.exists() and db_path.stat().st_size > 1024:
        print(f"[vector] 已存在 ({db_path.stat().st_size} bytes)，跳过重建")
        return
    print("[vector] 向量库不存在或为空，开始重建...")
    try:
        import ingest
        ingest.ingest(reset=True)
        print("[vector] 向量库重建完成")
    except Exception as e:
        print(f"[vector] 重建失败（不影响启动）: {e}")


_ensure_vector_db()


# ============ FastAPI App ============
app = FastAPI(title='地摊顾问 RAG Backend', version='0.2.0')

# 访问控制：设置 ACCESS_CODE 后，/api/* 必须带 X-Access-Code 头（公开部署防额度被刷）
# 同一 IP 5 分钟内输错 8 次 → 429，防止公网地址被暴力枚举访问码
_FAIL_WINDOW = 300
_FAIL_LIMIT = 8
_fail_log: dict = defaultdict(list)


def _client_ip(request) -> str:
    fwd = request.headers.get('x-forwarded-for', '')
    if fwd:
        return fwd.split(',')[0].strip()
    return request.client.host if request.client else 'unknown'


@app.middleware('http')
async def access_guard(request, call_next):
    code = settings.ACCESS_CODE
    if code and request.url.path.startswith('/api/'):
        ip = _client_ip(request)
        now = time.time()
        hits = [t for t in _fail_log.get(ip, []) if now - t < _FAIL_WINDOW]
        if len(hits) >= _FAIL_LIMIT:
            _fail_log[ip] = hits
            return JSONResponse({'detail': '访问码错误次数过多，请 5 分钟后再试'}, status_code=429)
        if not hmac.compare_digest(request.headers.get('x-access-code', ''), code):
            hits.append(now)
            _fail_log[ip] = hits
            if len(_fail_log) > 2000:      # 防止内存无限增长
                _fail_log.clear()
                _fail_log[ip] = hits
            return JSONResponse({'detail': '访问码不正确'}, status_code=401)
        _fail_log.pop(ip, None)
    return await call_next(request)


# CORS —— 在访问控制之后注册，保证 401 响应也带跨域头（最后注册 = 最外层）
_origins = list(filter(None, [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    settings.FRONTEND_URL,       # 可选：前后端分开部署时填前端地址
]))
print(f"[cors] allowed origins: {_origins}")

app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_credentials=True,
    allow_methods=['*'],
    allow_headers=['*'],
)


# ============ Request / Response Models ============

class ChatMessageIn(BaseModel):
    role: str
    text: str

class ChatRequest(BaseModel):
    message: str
    history: Optional[List[ChatMessageIn]] = None
    context: Optional[Dict[str, Any]] = None

class ChatResponse(BaseModel):
    answer: str
    query_rewritten: str
    sub_queries: List[str]
    knowledge_used: List[Dict[str, Any]]
    recommended: Optional[Dict[str, Any]]
    alternatives: List[Dict[str, Any]]
    candidates: List[Dict[str, Any]]
    pipeline_debug: Dict[str, Any]


# ============ Endpoints ============

@app.get('/health')
def health():
    return {
        'status': 'ok',
        'model': settings.DEEPSEEK_MODEL,
        'port': settings.BACKEND_PORT,
        # 前端据此决定是否弹访问码输入框
        'access_required': bool(settings.ACCESS_CODE),
    }


@app.get('/api/verify')
def verify_access():
    """能走到这里说明 X-Access-Code 已通过中间件校验。"""
    return {'ok': True}


@app.post('/api/feedback')
async def submit_feedback(payload: Dict[str, Any]):
    """首页反馈：落到 backend/data/feedback.jsonl，不依赖任何外部服务。"""
    import json as _json
    import time as _time

    text = str((payload or {}).get('text') or '').strip()
    if not text:
        return JSONResponse({'ok': False, 'error': 'empty feedback'}, status_code=400)

    try:
        data_dir = Path(__file__).parent / 'data'
        data_dir.mkdir(parents=True, exist_ok=True)
        with open(data_dir / 'feedback.jsonl', 'a', encoding='utf-8') as f:
            f.write(_json.dumps({
                'ts': _time.time(),
                'text': text[:2000],
                'page': str((payload or {}).get('page') or ''),
            }, ensure_ascii=False) + '\n')
    except Exception as e:  # 磁盘只读等异常不能影响前端
        return JSONResponse({'ok': False, 'error': str(e)}, status_code=500)

    return {'ok': True}


@app.post('/api/chat', response_model=ChatResponse)
async def chat(req: ChatRequest):
    try:
        from pipeline import run_pipeline, SessionContext

        ctx_raw = req.context or {}
        s1 = ctx_raw.get('screen1', {})
        s2 = ctx_raw.get('screen2', {})
        j = ctx_raw.get('judgment')
        print(f'[chat] screen1={s1.get("sellWhat")}/{s1.get("whereSell")}, step={ctx_raw.get("screenNum")}')

        context = SessionContext(
            sell_what=s1.get('sellWhat', ''),
            where_sell=s1.get('whereSell', ''),
            price=s1.get('price', ''),
            daily_qty=s1.get('dailyQty', ''),
            stall_fixed=s1.get('stallFixed', ''),
            daily_hours=s1.get('dailyHours', ''),
            stall_type=s1.get('stallType', ''),
            time_slot=s1.get('timeSlot', ''),
            weather=s1.get('weather', ''),
            competitors=s1.get('competitors', ''),
            spot_type=s1.get('spotType', ''),
            my_difficulty=s1.get('myDifficulty', ''),
            step=int(ctx_raw.get('screenNum', 1)),
            customer_action=s2.get('customerAction', ''),
            customer_look_at=','.join(s2.get('customerLookAt', []) or []),
            prev_judgment=j.get('mainProblem', '') if isinstance(j, dict) else '',
            prev_solution=ctx_raw.get('solution', {}).get('doWhat', '') if isinstance(ctx_raw.get('solution'), dict) else '',
            effect_result=str(ctx_raw.get('effect') or ''),
            user_message=req.message or '',
        )

        history = [{'role': m.role, 'text': m.text} for m in (req.history or [])]

        # ========== STEP-GATED HARD BLOCK ==========
        # step 1-2：信息不够 → 不跑完整 pipeline（不推核心矛盾、不给具体方案）
        # 只返回 StepCard 的品类定位 + 温和提示 + 极简 AI 回复
        if context.step <= 2:
            from processor import process_step, _infer_category_group, render_card_feedback
            from rules import get_graph
            from pipeline import (_build_context_kg, _compute_dynamic_temperatures,
                                  _step_card_cache, _step_card_cache_key, _MAX_STEP_CARD_CACHE)
            # 屏 1-2 也要用 T-agent：step2 的原因预估需要更高 T + KG 符号推理
            # 卡片按「问卷 + step」缓存：同样问卷必须给同样的判断
            cache_key = _step_card_cache_key(context)
            step_card = _step_card_cache.get(cache_key)
            if step_card is None:
                kg_lite = _build_context_kg(context)
                temps = _compute_dynamic_temperatures(context, kg_lite, has_similar_case=False)
                print(f'[T-agent][step{context.step}] step2_diag={temps.get("step2_diag")}')
                step_card = process_step(context, temperatures=temps)
                if len(_step_card_cache) >= _MAX_STEP_CARD_CACHE:
                    for k in list(_step_card_cache.keys())[: _MAX_STEP_CARD_CACHE // 2]:
                        del _step_card_cache[k]
                _step_card_cache[cache_key] = step_card
            cat_group, cat_kw = _infer_category_group(context.sell_what or '')
            filled = sum(1 for v in [context.sell_what, context.where_sell, context.competitors,
                                     context.spot_type, context.time_slot, context.my_difficulty] if v)
            # 当下屏反馈：把这一屏的结论说给老板听（细节在上方卡片里）
            brief_answer = render_card_feedback(step_card, compact=True)

            # 屏 1/2 也要有 LLM 参与：结合问卷 + 卡片，用摊主口气回一句（只观察，不下结论、不给方案）
            try:
                from llm_client import LLMClient
                from dataclasses import asdict
                _card = step_card if isinstance(step_card, dict) else asdict(step_card)
                _card_txt = '；'.join(
                    str(i)
                    for _sec in (_card.get('sections') or [])
                    for i in (_sec.get('items') or [])[:2]
                )[:260]
                _facts = (
                    f'卖什么：{context.sell_what or "未填"}；在哪卖：{context.where_sell or "未填"}；'
                    f'价格：{context.price or "未填"}；时段：{context.time_slot or "未填"}；'
                    f'竞争：{context.competitors or "未填"}；点位：{context.spot_type or "未填"}'
                )
                _reply = LLMClient().chat([
                    {'role': 'system', 'content': '你是摆摊十年的老摊主，说话短、具体，像隔壁摊主聊天，不客套、不用"建议您"。'},
                    {'role': 'user', 'content': (
                        f'老板情况：{_facts}\n'
                        f'程序刚看到的判断：{_card_txt}\n'
                        f'老板问：{req.message}\n\n'
                        '只回应这一屏的观察：点出他这个摊最显眼的一个具体现象，并说清为什么，2 句话、60 字内。'
                        '不要下"核心矛盾"结论，不要给行动方案，不要罗列清单。'
                    )},
                ], temperature=0.7, max_tokens=160).strip()
                if _reply:
                    brief_answer = _reply
            except Exception as e:
                print(f'[step{context.step}_llm] 调用失败，回退卡片摘要: {e}')

            # 真实的 KG 处理轨迹（让前端渲染"我看到你卖烤鱼×夜市"）
            g = get_graph()
            ctx_dict = {
                'sell': cat_kw, 'time': context.time_slot or '',
                'difficulty': context.my_difficulty or '',
                'competitors': context.competitors or '',
                'spot': context.spot_type or '',
            }
            matched = g.match(ctx_dict)

            return ChatResponse(
                answer=brief_answer,
                query_rewritten='',
                sub_queries=[],
                knowledge_used=[],
                recommended=None,
                alternatives=[],
                candidates=[],
                pipeline_debug={
                    'step_gated': True,
                    'kg_reasoning': 'Step 1-2：只给当下屏反馈，不推核心矛盾/不给方案',
                    'filled_fields': filled,
                    'step_card': step_card,
                    'process_trail': {
                        'category_kw': cat_kw,
                        'category_group': cat_group,
                        'filled_fields': filled,
                        'total_fields': 11,
                        'kg_firing_rules': [r.rule_id for r in matched],
                        'kg_valid': [], 'kg_invalid': [],
                        'similar_case_hit': False,
                        'rag_chunks': 0,
                        'candidates_count': 0,
                        'top_direction': '',
                        'top_score': 0.0,
                    },
                },
            )

        result = run_pipeline(req.message, context, history)

        return ChatResponse(
            answer=result['answer'],
            query_rewritten=result['query_rewritten'],
            sub_queries=result['sub_queries'],
            knowledge_used=result['knowledge_used'],
            recommended=result['recommended'],
            alternatives=result['alternatives'],
            candidates=result['candidates'],
            pipeline_debug={
                'num_sub_queries': len(result['sub_queries']),
                'num_candidates': len(result['candidates']),
                'num_knowledge_chunks': len(result['knowledge_used']),
                'top_final_score': result['recommended']['final_score'] if result['recommended'] else 0,
                'kg_reasoning': result.get('kg_reasoning', ''),
                'step_card': result.get('step_card'),
                'process_trail': result.get('process_trail', {}),
            },
        )
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.post('/api/process')
async def process_api(req: ChatRequest):
    from dataclasses import asdict
    from processor import process_step
    from pipeline import SessionContext
    try:
        ctx_raw = req.context or {}
        s1 = ctx_raw.get('screen1', {})
        s2 = ctx_raw.get('screen2', {})
        j = ctx_raw.get('judgment')
        context = SessionContext(
            sell_what=s1.get('sellWhat', ''),
            where_sell=s1.get('whereSell', ''),
            price=s1.get('price', ''),
            daily_qty=s1.get('dailyQty', ''),
            stall_fixed=s1.get('stallFixed', ''),
            daily_hours=s1.get('dailyHours', ''),
            stall_type=s1.get('stallType', ''),
            time_slot=s1.get('timeSlot', ''),
            weather=s1.get('weather', ''),
            competitors=s1.get('competitors', ''),
            spot_type=s1.get('spotType', ''),
            my_difficulty=s1.get('myDifficulty', ''),
            step=int(ctx_raw.get('screenNum', 1)),
            customer_action=s2.get('customerAction', ''),
            customer_look_at=','.join(s2.get('customerLookAt', []) or []),
            prev_judgment=j.get('mainProblem', '') if isinstance(j, dict) else '',
        )
        # 左侧 StepCard = 一MLP：纯规则/特征工程，不传 temperatures，不走 LLM
        # temperatures 只给 /api/chat → pipeline 里的 processor 用（右侧 AI 回复的动态生成）
        card = process_step(context)
        return {'card': asdict(card)}
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


# ============ /api/visualize —— 2D 摆摊仿真效果图 ============
class VisualizeRequest(BaseModel):
    context: Dict[str, Any] = {}
    step: int = 3  # 屏 3 视觉陈列

@app.post('/api/visualize')
async def visualize_api(req: VisualizeRequest):
    """
    摊位仿真效果图生成。双引擎：
      1) Pollinations.ai（免费、photorealism、英文 prompt 效果好）← 优先
      2) Kwai-Kolors（硅基流动、用户 token、中文理解好）← fallback
    返回 DataURL 或图片 URL，前端 <img src> 直接能用。
    """
    import httpx, re, random, base64
    from urllib.parse import quote_plus

    ctx_raw = req.context or {}
    s1 = ctx_raw.get('screen1', {})
    judgment = ctx_raw.get('judgment', {})
    j_text = ''
    if isinstance(judgment, dict):
        angles = judgment.get('angles', [])
        angles_str = ' '.join(angles) if isinstance(angles, list) else str(angles)
        j_text = (judgment.get('mainProblem', '') + ' ' + judgment.get('howToFix', '') + ' ' + angles_str).strip()
    elif isinstance(judgment, str):
        j_text = judgment

    sell = s1.get('sellWhat', '小摊')
    where = s1.get('whereSell', '')
    stall_type = s1.get('stallType', '')
    price = s1.get('price', '')
    time_slot = s1.get('timeSlot', '')
    venue = s1.get('weather', '')

    # 从 AI 诊断提取陈列建议
    display_tips = []
    if j_text:
        kw_map = [
            ('招牌', '招牌'), ('抬高', '招牌举高'), ('灯', '暖光LED'), ('颜色', '颜色醒目'),
            ('红', '红色招牌'), ('黄', '黄色招牌'), ('摆', '货品整齐'), ('陈列', '货品陈列'),
            ('堆', '堆头饱满'), ('价格', '价格牌'), ('布', '干净桌布'), ('围挡', '围挡'),
        ]
        for en, cn in kw_map:
            if en in j_text and cn not in display_tips:
                display_tips.append(cn)

    # 品类归类（先算，招牌/图标/形状都按真实品类走，不能默认成小吃摊）
    cat_group, _ = '其他', ''
    try:
        from processor import _infer_category_group
        cat_group, _ = _infer_category_group(sell)
    except Exception:
        pass
    _food_kw = ('吃', '饭', '面', '粉', '肉', '鱼', '串', '鸡', '饼', '粥', '汤',
                '茶', '咖啡', '果', '菜', '奶', '饮', '炸', '烤', '卤', '甜')
    try:
        from rules import is_food_category as _is_food_cat
        sells_food = _is_food_cat(f'{cat_group} {sell}')
    except Exception:
        sells_food = any(k in sell for k in _food_kw)

    # 招牌文字：按品类出，不把固定模板套到别的场景
    sign_map = [
        (('烤鱼',), '张记 烤鱼'),
        (('奶茶', '饮'), '张记 奶茶'),
        (('手串', '佛珠', '手链'), '手工手串 现场挑选'),
        (('饰品', '发饰', '耳环', '项链', '耳钉'), '手工饰品'),
        (('香薰', '蜡烛'), '手作香薰'),
        (('面粉', '粮油', '大米', '干货'), '粮油 散装批发'),
        (('花',), '鲜切花 10元3支'),
        (('水果',), '新鲜水果'),
        (('手机', '贴膜'), '手机贴膜'),
    ]
    sign_text = ''
    for kws, txt in sign_map:
        if any(k in sell for k in kws):
            sign_text = txt
            break
    if not sign_text:
        sign_text = sell[:8] if sell else '小摊'
    price_text = f'一律 {price} 元' if price else ''

    # ===== 陈列参数（前端 Canvas 按这些参数摆放商品，AI 只画空摊位底图）=====
    # 商品图标：按品类组选，图标由前端用 Canvas 绘制（数量/层数可控）
    icon_by_group = {
        '小吃-烧烤类': ['🦑', '🍢', '🌭', '🍡'],
        '小吃-鱼类熟食': ['🐟', '🦐', '🦪'],
        '卤味熟食': ['🍗', '🍖'],
        '炸制快餐': ['🍗', '🍟', '🍔'],
        '麻辣烫煮物': ['🍲', '🍢'],
        '街头小吃': ['🍢', '🌽', '🍠', '🍡'],
        '早餐面点': ['🥟', '🥞', '🥖'],
        '快餐主食': ['🍜', '🍚', '🍝'],
        '饮品': ['🥤', '🧋', '☕'],
        '甜品烘焙': ['🍰', '🍦', '🥧'],
        '生鲜果蔬': ['🥥', '🍉', '🍓', '🍎', '🍊'],
        '坚果炒货': ['🌰', '🥜'],
        '便民服务': ['📱', '🔑'],
        '日用百货': ['🧦', '🧸', '🧲'],
        '文创手工': ['🧲', '🎨', '🪀'],
        '植物类': ['🌸', '🪴'],
        '宠物用品': ['🐾', '🐟'],
    }
    icons = icon_by_group.get(cat_group, ['🍢', '🥤', '🍡'] if sells_food else ['🧺', '🎁', '🧸'])
    if not sells_food and cat_group not in ('便民服务', '日用百货', '文创手工', '植物类', '宠物用品', '唱片音像'):
        icons = ['🥣', '🧺', '🎁']   # 卖原料（面粉/粮油）不套成品餐食图标
    if cat_group == '街头表演-唱歌':
        icons = ['🎤', '🎸', '🎧']
    elif cat_group == '街头表演-杂技':
        icons = ['🤹', '🎪', '🎩']
    elif cat_group == '唱片音像':
        icons = ['💿', '🎵', '📀']
    shape_by_group = {
        '小吃-烧烤类': 'skewer', '小吃-鱼类熟食': 'plate', '卤味熟食': 'plate',
        '炸制快餐': 'snack', '麻辣烫煮物': 'bowl', '街头小吃': 'skewer',
        '早餐面点': 'snack', '快餐主食': 'bowl', '饮品': 'cup',
        '甜品烘焙': 'box', '生鲜果蔬': 'fruit', '坚果炒货': 'snack',
        '便民服务': 'service', '日用百货': 'box', '文创手工': 'craft',
        '植物类': 'plant', '宠物用品': 'box',
        '街头表演-唱歌': 'craft', '街头表演-杂技': 'craft', '唱片音像': 'box',
    }
    shape = shape_by_group.get(cat_group, 'skewer' if sells_food else 'box')
    if not sells_food and shape in ('skewer', 'bowl', 'cup', 'plate', 'snack'):
        shape = 'box'
    img_by_group = {
        '小吃-烧烤类': 'skewer', '小吃-鱼类熟食': 'fish', '卤味熟食': 'braised',
        '炸制快餐': 'fried', '麻辣烫煮物': 'malatang', '街头小吃': 'street_snack',
        '早餐面点': 'breakfast', '快餐主食': 'fastfood', '饮品': 'drink',
        '甜品烘焙': 'dessert', '生鲜果蔬': 'fruit', '坚果炒货': 'nuts',
        '便民服务': 'service', '日用百货': 'goods', '文创手工': 'craft',
        '植物类': 'plant', '宠物用品': 'pet',
    }
    img_name = img_by_group.get(cat_group, '')
    img_url_asset = f'/products/{img_name}.png' if img_name else ''
    items_raw = [x.strip() for x in re.split(r'[、,，/]', sell) if x.strip()][:2]
    if not items_raw:
        items_raw = [sell or '招牌货']
    products = [
        {'name': name, 'icon': icons[i % len(icons)], 'shape': shape, 'img': img_url_asset}
        for i, name in enumerate(items_raw)
    ]

    # 从诊断建议里读陈列意图（堆/往前/招牌/灯）
    has_front = any(k in j_text for k in ('往前', '靠前', '前面', '前置'))
    has_sign_fix = any(k in j_text for k in ('招牌', '抬高', '字', '醒目'))

    layout = {
        'pyramid': True,                          # 方案图就是要展示"堆成金字塔"
        'front_bias': 0.88 if has_front else 0.80,
        'sign_scale': 1.40 if has_sign_fix else 1.25,
        'rows': 4 if len(products) == 1 else 3,
    }
    before_layout = {'pyramid': False, 'front_bias': 0.30, 'sign_scale': 0.85, 'rows': 1}

    # ===== 底图 prompt：只要"空摊位 + 暖光 + 人流动线"，不要商品、不要文字 =====
    stall_num = stall_type.split('（')[0].strip() if stall_type else ''
    stall_en = {
        '1': 'ground display mat on the pavement',
        '2': 'simple wooden table stall',
        '3': 'folding table with wooden board',
        '4': 'red mobile cart with canopy',
        '5': 'street food cart with glass display counter',
        '6': 'bicycle food stall',
        '7': 'tricycle food stall',
        '8': 'awning-covered stall',
        '9': 'ground mat stall',
        '10': 'wall-mounted display shelf',
    }.get(stall_num, 'simple street stall')

    prompt_photoreal = (
        f"Ultra-realistic photo of an EMPTY Chinese street vendor stall in {where or 'a night market'}, at {time_slot or 'night'}.\n"
        f"It is a {stall_en}.\n"
        f"The counter top is completely EMPTY — no food, no products, no goods of any kind.\n"
        f"There is a BLANK sign board above the stall with NO text and NO letters on it.\n"
        f"Warm night market lighting, glowing bulbs, clean empty counter in the foreground with plenty of free space.\n"
        f"Background is softly blurred with a few distant stalls and pedestrians.\n"
        f"Front view, camera at eye level, sharp focus on the empty counter.\n"
        f"Photorealistic, high detail, no watermark, no text, no letters, no products."
    )

    # ===== 引擎 1：Pollinations.ai（免费）=====
    async def try_pollinations() -> str | None:
        try:
            seed = random.randint(1, 999999)
            url = (
                'https://image.pollinations.ai/prompt/' + quote_plus(prompt_photoreal) +
                f'?width=1024&height=1024&nologo=true&enhance=true&seed={seed}'
            )
            async with httpx.AsyncClient(timeout=55, follow_redirects=True) as client:
                resp = await client.get(url)
            if resp.status_code != 200:
                return None
            content_type = resp.headers.get('content-type', '')
            if 'image' not in content_type and len(resp.content) < 1000:
                return None
            # base64 → DataURL
            b64 = base64.b64encode(resp.content).decode('ascii')
            mime = 'image/jpeg' if 'jpeg' in content_type else ('image/png' if 'png' in content_type else 'image/jpeg')
            return f'data:{mime};base64,{b64}'
        except Exception:
            return None

    # ===== 引擎 2：Kwai-Kolors（硅基流动 fallback）=====
    async def try_kolors() -> str | None:
        api_key = settings.SILICONFLOW_API_KEY
        if not api_key:
            return None
        try:
            prompt_kolors = (
                f"An empty Chinese street vendor stall at {where or 'a night market'}, {time_slot or 'night'}. "
                f"A {stall_en}. The counter is completely empty with no food and no goods. "
                f"A blank sign board with no text above the stall. "
                f"Warm night market lighting, blurred background of other stalls, front view, photorealistic, no text."
            )
            async with httpx.AsyncClient(timeout=45) as client:
                resp = await client.post(
                    'https://api.siliconflow.cn/v1/images/generations',
                    json={'model': 'Kwai-Kolors/Kolors', 'prompt': prompt_kolors,
                          'size': '1024x1024', 'n': 1, 'response_format': 'url'},
                    headers={'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'},
                )
                if resp.status_code != 200:
                    return None
                data = resp.json()
                url = data['data'][0]['url']
                # 转 base64，避免前端 canvas 跨域污染（导出图片会失败）
                img = await client.get(url, timeout=30)
                if img.status_code != 200:
                    return None
                mime = img.headers.get('content-type', 'image/jpeg').split(';')[0]
                return f'data:{mime};base64,' + base64.b64encode(img.content).decode('ascii')
        except Exception:
            return None

    # ===== 串行尝试 =====
    img_url = await try_pollinations()
    if not img_url:
        img_url = await try_kolors()

    if not img_url:
        raise HTTPException(status_code=502, detail='两个生图引擎都挂了，请稍后再试')

    return {
        'image_url': img_url,          # 空摊位底图（DataURL），前端 Canvas 合成
        'base_image': img_url,
        'products': products,          # [{name, icon}]
        'layout': layout,              # 方案后：金字塔/往前靠/招牌放大
        'before_layout': before_layout,  # 方案前：散放/靠后/小招牌
        'sign_text': sign_text,
        'price_text': price_text,
        'tips': display_tips,
        'category_group': cat_group,   # 前端展示"识别为哪类摊位"，便于核对生图是否对得上
    }


# ============ 生产环境：托管前端静态文件（前后端同源，Docker 部署） ============
# 本地开发时前端跑 vite(5173)，这里没有 dist，整段自动跳过。
_DIST_DIR = Path(os.environ.get(
    'FRONTEND_DIST', str(Path(__file__).parent.parent / 'frontend' / 'dist')
))
if _DIST_DIR.is_dir():
    from fastapi.staticfiles import StaticFiles
    from fastapi.responses import FileResponse

    if (_DIST_DIR / 'assets').is_dir():
        app.mount('/assets', StaticFiles(directory=str(_DIST_DIR / 'assets')), name='assets')
    if (_DIST_DIR / 'products').is_dir():
        app.mount('/products', StaticFiles(directory=str(_DIST_DIR / 'products')), name='products')

    @app.get('/{full_path:path}', include_in_schema=False)
    async def spa_fallback(full_path: str):
        """SPA 路由回退：/screen/3 这类前端路由刷新时也返回 index.html。"""
        if full_path == 'api' or full_path.startswith('api/'):
            raise HTTPException(status_code=404, detail='Not Found')
        target = (_DIST_DIR / full_path).resolve()
        if full_path and str(target).startswith(str(_DIST_DIR.resolve())) and target.is_file():
            return FileResponse(str(target))
        return FileResponse(str(_DIST_DIR / 'index.html'))


if __name__ == '__main__':
    import uvicorn
    uvicorn.run(
        'main:app',
        host=settings.BACKEND_HOST,
        port=settings.BACKEND_PORT,
        reload=False,  # Render 生产环境不要开 reload
    )
