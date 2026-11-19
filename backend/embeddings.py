"""SiliconFlow Embeddings API client + fallback.

优先用 BAAI/bge-m3（中文最强开源 embedding，1024 维）。
国内网络零压力，key 已在 config。
API: POST https://api.siliconflow.cn/v1/embeddings

无 key 时 fallback 到 SHA-256 哈希 embedding（256 维，无语义）。
"""
import httpx
import hashlib
from typing import List, Optional


SF_EMBED_URL = 'https://api.siliconflow.cn/v1/embeddings'
SF_MODEL = 'BAAI/bge-m3'   # 中文最强，1024 维，支持中英混合检索


def embed_with_siliconflow(texts: List[str], api_key: str) -> List[List[float]]:
    """调硅基流动 Embeddings API。"""
    headers = {
        'Authorization': f'Bearer {api_key}',
        'Content-Type': 'application/json',
    }
    payload = {
        'model': SF_MODEL,
        'input': texts,
        'encoding_format': 'float',
    }
    with httpx.Client(timeout=30.0) as client:
        resp = client.post(SF_EMBED_URL, headers=headers, json=payload)
        resp.raise_for_status()
        data = resp.json()

    return [item['embedding'] for item in data['data']]


def embed_hash_fallback(texts: List[str], dim: int = 256) -> List[List[float]]:
    """
    纯本地 fallback：用 SHA-256 哈希做一个粗糙的 embedding。
    无语义能力，只保证 pipeline 能跑。
    """
    import math
    results: List[List[float]] = []
    for t in texts:
        h = hashlib.sha256(t.encode('utf-8')).digest()
        vec: List[float] = []
        for i in range(dim):
            byte = h[i % 32]
            vec.append((byte / 255.0) * 2 - 1)
        norm = math.sqrt(sum(x * x for x in vec))
        if norm > 0:
            vec = [x / norm for x in vec]
        results.append(vec)
    return results


def embed(texts: List[str], api_key: Optional[str] = None, dim: int = 1024,
          strict: bool = False) -> List[List[float]]:
    """主入口：有 key 用 SiliconFlow bge-m3，没有 key 才 fallback hash。

    strict=True：有 key 但调用失败时直接抛错。建库必须用严格模式，
    否则会悄悄写入 256 维无语义向量，检索永远为空且不报任何错。
    """
    if api_key:
        try:
            return embed_with_siliconflow(texts, api_key)
        except Exception as e:
            if strict:
                raise RuntimeError(f'Embedding API 调用失败，已中止（不写入哈希向量）: {e}') from e
            print(f'[Embedding] SiliconFlow 调用失败，fallback hash: {e}')
    else:
        print('[Embedding] 未配置 SILICONFLOW_API_KEY，使用无语义哈希向量（仅限本地调试）')
    # fallback
    return embed_hash_fallback(texts, dim=256)


# ============ 相似度计算 ============

def cosine(v1: List[float], v2: List[float]) -> float:
    """两个向量的余弦相似度 [-1, 1]。"""
    import math
    dot = sum(a * b for a, b in zip(v1, v2))
    n1 = math.sqrt(sum(a * a for a in v1))
    n2 = math.sqrt(sum(b * b for b in v2))
    if n1 == 0 or n2 == 0:
        return 0.0
    return dot / (n1 * n2)


def pairwise_cosine(vectors: List[List[float]]) -> List[List[float]]:
    """两两余弦相似度矩阵（N x N 对称矩阵，对角线=1）。纯 Python，零依赖。"""
    n = len(vectors)
    result: List[List[float]] = [[0.0] * n for _ in range(n)]
    for i in range(n):
        for j in range(i, n):
            s = cosine(vectors[i], vectors[j])
            result[i][j] = s
            result[j][i] = s
    return result


def deduplicate_by_similarity(
    texts: List[str],
    api_key: Optional[str],
    threshold: float = 0.85,
) -> List[int]:
    """
    对一组文本做 embedding → 余弦相似度矩阵 → 贪心淘汰相似项。
    返回「保留的索引列表」（按原顺序）。
    - 先按文本长度排序（短的先保留，长的更容易被短的"盖住"）
    - 贪心：如果当前候选跟已保留的任何一个相似度都 < threshold，就保留
    """
    if len(texts) <= 1:
        return list(range(len(texts)))

    vecs = embed(texts, api_key)
    sim = pairwise_cosine(vecs)

    # 按长度排序：短文本优先保留
    order = sorted(range(len(texts)), key=lambda i: len(texts[i]))

    kept: List[int] = []
    for i in order:
        redundant = False
        for k in kept:
            if sim[i][k] >= threshold:
                redundant = True
                break
        if not redundant:
            kept.append(i)

    return sorted(kept)


def compute_similarity_to_history(
    texts: List[str],
    history_text: str,
    api_key: Optional[str],
) -> List[float]:
    """
    计算每个 text 与 history_text 的余弦相似度。
    返回每个位置的相似度分数 [0, 1]。
    """
    if not history_text or not texts:
        return [0.0] * len(texts)

    all = list(texts) + [history_text]
    vecs = embed(all, api_key)
    history_vec = vecs[-1]
    return [cosine(v, history_vec) for v in vecs[:-1]]
