"""Config — 优先读系统环境变量（Render/云平台），fallback 读 .env 文件。"""
import os
from dotenv import dotenv_values
from pathlib import Path

# 同时支持 Render 环境变量和本地 .env 文件
_local_env = dotenv_values(Path(__file__).parent / '.env')

def _get(k: str, default: str = '') -> str:
    """Render 环境变量优先，其次本地 .env，最后 default"""
    v = os.environ.get(k) or _local_env.get(k)
    return v if v is not None else default

def _get_int(k: str, default: int) -> int:
    try:
        return int(_get(k, str(default)))
    except ValueError:
        return default

class Settings:
    # LLM
    DEEPSEEK_API_KEY: str = _get('DEEPSEEK_API_KEY')
    DEEPSEEK_BASE_URL: str = _get('DEEPSEEK_BASE_URL', 'https://api.deepseek.com/v1')
    DEEPSEEK_MODEL: str = _get('DEEPSEEK_MODEL', 'deepseek-chat')

    # Embedding（硅基流动）
    SILICONFLOW_API_KEY: str = _get('SILICONFLOW_API_KEY')

    # 服务器
    # Render 用 $PORT，本地 .env 用 BACKEND_PORT
    BACKEND_HOST: str = _get('BACKEND_HOST', '0.0.0.0')
    # Render 设 PORT 环境变量，本地 .env 设 BACKEND_PORT
    BACKEND_PORT: int = _get_int('PORT', 0) or _get_int('BACKEND_PORT', 8000)

    # 前端地址（CORS 白名单）
    FRONTEND_URL: str = _get('FRONTEND_URL', '*')

    # 访问码：设置为非空后，所有 /api/* 请求必须带 X-Access-Code 头；留空则完全放开（本地开发）
    ACCESS_CODE: str = _get('ACCESS_CODE', '')

    # RAG
    RRF_K: int = _get_int('RRF_K', 60)
    NUM_CANDIDATES: int = _get_int('NUM_CANDIDATES', 5)
    NUM_SUB_QUERIES: int = _get_int('NUM_SUB_QUERIES', 4)

    # 向量库路径（持久化到 data 目录，容器重建后仍可用）
    VECTOR_DB_PATH: str = _get(
        'VECTOR_DB_PATH',
        str(Path(__file__).parent / 'data' / 'vector.db')
    )

settings = Settings()
