"""RAG retrieval — Phase 2: 真向量检索（numpy + sqlite cosine）。

Phase 1 是关键词 stub，现在换成真 embedding 相似度搜索。
"""
from typing import List
from dataclasses import dataclass

from embeddings import embed
from vector_store import VectorStore


@dataclass
class RetrievedChunk:
    source: str       # 知识来源（案例库 / 百科 / 法规）
    title: str        # 片段标题
    content: str      # 片段正文
    score: float = 0.0  # cosine similarity
    metadata: dict | None = None


# 全局 store 单例
_store: VectorStore | None = None


def _get_store() -> VectorStore:
    global _store
    if _store is None:
        _store = VectorStore()
    return _store


def retrieve(query: str, top_k: int = 4) -> List[RetrievedChunk]:
    """向量检索：query → embedding → cosine similarity top-k。"""
    store = _get_store()

    # 没有知识就返回空
    if store.count() == 0:
        return []

    # query embedding（用硅基流动 BAAI/bge-m3；key 已在 config）
    from config import settings
    emb_key = getattr(settings, 'SILICONFLOW_API_KEY', None) or getattr(settings, 'DEEPSEEK_API_KEY', None)
    emb = embed([query], api_key=emb_key)

    results = store.search(emb[0], top_k=top_k)

    return [RetrievedChunk(
        source=r['source'],
        title=r['title'],
        content=r['content'],
        score=r['score'],
        metadata=r.get('metadata'),
    ) for r in results]
