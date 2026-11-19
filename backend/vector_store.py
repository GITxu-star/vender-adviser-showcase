"""Vector store: sqlite3 + numpy cosine similarity.

零三方向量库依赖。数据存在本地 sqlite 文件里。
Schema:
  chunks(id, source, title, content, metadata_json, embedding, dim, created_at)
  embedding 存 BLOB（numpy float32），检索时读出来用 numpy 算 cosine。
"""
import sqlite3
import json
import math
import os
import numpy as np
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple


DEFAULT_DB_PATH = Path(__file__).parent / 'data' / 'vector.db'


class VectorStore:
    def __init__(self, db_path: Path = DEFAULT_DB_PATH):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    def _conn(self) -> sqlite3.Connection:
        return sqlite3.connect(str(self.db_path))

    def _init_schema(self):
        with self._conn() as conn:
            conn.execute('''
                CREATE TABLE IF NOT EXISTS chunks (
                    id          TEXT PRIMARY KEY,
                    source      TEXT NOT NULL,
                    title       TEXT,
                    content     TEXT NOT NULL,
                    metadata    TEXT,        -- JSON: {author, license, uploaded_at, ...}
                    embedding   BLOB NOT NULL,
                    dim         INTEGER NOT NULL,
                    created_at  TEXT DEFAULT CURRENT_TIMESTAMP
                )
            ''')
            conn.commit()

    # ============ 写入 ============

    def upsert(
        self,
        chunk_id: str,
        content: str,
        embedding: List[float],
        source: str,
        title: str = '',
        metadata: Optional[Dict[str, Any]] = None,
    ):
        vec = np.array(embedding, dtype=np.float32)
        blob = vec.tobytes()
        dim = vec.shape[0]
        meta_json = json.dumps(metadata or {}, ensure_ascii=False)

        with self._conn() as conn:
            conn.execute('''
                INSERT OR REPLACE INTO chunks (id, source, title, content, metadata, embedding, dim)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            ''', (chunk_id, source, title, content, meta_json, blob, dim))
            conn.commit()

    def bulk_upsert(self, items: List[Tuple[str, str, List[float], str, str, Optional[Dict]]]):
        """items: [(chunk_id, content, embedding, source, title, metadata)]"""
        rows = []
        for cid, content, emb, source, title, meta in items:
            vec = np.array(emb, dtype=np.float32)
            rows.append((cid, source, title, content,
                         json.dumps(meta or {}, ensure_ascii=False),
                         vec.tobytes(), vec.shape[0]))
        with self._conn() as conn:
            conn.executemany('''
                INSERT OR REPLACE INTO chunks (id, source, title, content, metadata, embedding, dim)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            ''', rows)
            conn.commit()

    # ============ 检索 ============

    def search(
        self,
        query_embedding: List[float],
        top_k: int = 4,
        source_filter: Optional[List[str]] = None,
    ) -> List[Dict[str, Any]]:
        """Cosine similarity search. 返回 top_k 最相似的 chunks。"""
        q = np.array(query_embedding, dtype=np.float32)
        query_norm = np.linalg.norm(q)
        if query_norm == 0:
            return []
        q = q / query_norm

        # 取出所有 chunks（向量检索一般数据量不大，全量加载；上亿条再接索引）
        with self._conn() as conn:
            sql = 'SELECT id, source, title, content, metadata, embedding FROM chunks'
            params: List[Any] = []
            if source_filter:
                placeholders = ','.join('?' * len(source_filter))
                sql += f' WHERE source IN ({placeholders})'
                params.extend(source_filter)
            rows = conn.execute(sql, params).fetchall()

        scored: List[Tuple[float, Dict[str, Any]]] = []
        for rid, source, title, content, meta_json, emb_blob in rows:
            vec = np.frombuffer(emb_blob, dtype=np.float32)
            norm = np.linalg.norm(vec)
            if norm < 1e-6 or vec.shape[0] != q.shape[0]:
                continue
            vec = vec / norm
            sim = float(np.dot(q, vec))

            meta = {}
            try:
                meta = json.loads(meta_json) if meta_json else {}
            except json.JSONDecodeError:
                pass

            scored.append((sim, {
                'id': rid,
                'source': source,
                'title': title,
                'content': content,
                'metadata': meta,
                'score': sim,
            }))

        # 降序
        scored.sort(key=lambda x: x[0], reverse=True)
        return [item[1] for item in scored[:top_k]]

    # ============ 管理 ============

    def count(self) -> int:
        with self._conn() as conn:
            return conn.execute('SELECT COUNT(*) FROM chunks').fetchone()[0]

    def delete_by_source(self, source: str):
        with self._conn() as conn:
            conn.execute('DELETE FROM chunks WHERE source = ?', (source,))
            conn.commit()

    def clear(self):
        with self._conn() as conn:
            conn.execute('DELETE FROM chunks')
            conn.commit()

    def list_sources(self) -> List[Dict[str, Any]]:
        with self._conn() as conn:
            rows = conn.execute('''
                SELECT source, COUNT(*) as cnt, MIN(created_at) as first_seen
                FROM chunks GROUP BY source
            ''').fetchall()
            return [{'source': r[0], 'chunks': r[1], 'first_seen': r[2]} for r in rows]
