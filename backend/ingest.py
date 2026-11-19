"""Ingest knowledge files into the vector store.

用法：
    python ingest.py                # 扫描 knowledge/ 下所有 md/txt
    python ingest.py --reset        # 先清空再入库
    python ingest.py --source 案例库 # 只入指定来源

知识文件格式（markdown）：
    ---
    source: 案例库
    title: 夜市烤串引流案例
    author: 地摊顾问编辑部
    license: MIT
    ---

    这里是正文内容...

每个文件按 500 字切块，每块生成一个 chunk。
"""
import argparse
import re
from pathlib import Path
from typing import List, Dict, Any, Tuple

from embeddings import embed
from vector_store import VectorStore


KNOWLEDGE_DIR = Path(__file__).parent / 'knowledge'
SUPPORTED_EXT = {'.md', '.txt', '.markdown'}


def parse_file(file_path: Path) -> Tuple[Dict[str, Any], str]:
    """解析带 frontmatter 的 markdown 文件。"""
    text = file_path.read_text(encoding='utf-8')

    meta: Dict[str, Any] = {
        'author': 'unknown',
        'license': 'unknown',
        'uploaded_at': file_path.stat().st_mtime,
    }
    content = text

    # 解析 --- frontmatter ---
    fm_match = re.match(r'^---\s*\n(.*?)\n---\s*\n', text, re.DOTALL)
    if fm_match:
        fm_text = fm_match.group(1)
        content = text[fm_match.end():]
        for line in fm_text.strip().splitlines():
            if ':' in line:
                k, v = line.split(':', 1)
                meta[k.strip()] = v.strip()

    # 推断 source
    if 'source' not in meta:
        # 按目录名推断
        parent = file_path.parent.name
        meta['source'] = parent if parent != 'knowledge' else 'misc'

    return meta, content.strip()


def chunk_text(text: str, max_chars: int = 500, overlap: int = 50) -> List[str]:
    """按段落切块，每块 max_chars 左右，块间 overlap。"""
    paragraphs = [p.strip() for p in re.split(r'\n\s*\n', text) if p.strip()]

    chunks: List[str] = []
    current = ''
    for para in paragraphs:
        if len(current) + len(para) <= max_chars:
            current += ('\n\n' if current else '') + para
        else:
            if current:
                chunks.append(current)
            # 如果单段超长，硬切
            if len(para) > max_chars:
                for i in range(0, len(para), max_chars - overlap):
                    chunks.append(para[i:i + max_chars])
                current = ''
            else:
                current = para
    if current:
        chunks.append(current)

    return chunks


def discover_files() -> List[Path]:
    files: List[Path] = []
    for ext in SUPPORTED_EXT:
        files.extend(KNOWLEDGE_DIR.rglob(f'*{ext}'))
    return sorted(files)


def ingest(reset: bool = False, source_filter: str | None = None, jina_key: str | None = None):
    store = VectorStore()

    # 程序内调用（启动自动重建 / rebuild_db.py）不传 key 时会退回 256 维哈希兜底，
    # 向量库看似建好了但检索永远是空 —— 这里统一补上 config 里的 key
    if not jina_key:
        try:
            from config import settings
            jina_key = (
                getattr(settings, 'SILICONFLOW_API_KEY', None)
                or getattr(settings, 'DEEPSEEK_API_KEY', None)
                or None
            )
        except Exception:
            pass

    if reset:
        store.clear()
        print('[ingest] 已清空向量库')

    files = discover_files()
    print(f'[ingest] 发现 {len(files)} 个知识文件')

    if not files:
        print('[ingest] knowledge/ 目录下没有文件。放 .md/.txt 进去再跑。')
        return

    all_chunks: List[Tuple[str, str, str, str, str, Dict]] = []

    for fp in files:
        meta, content = parse_file(fp)
        if source_filter and meta.get('source') != source_filter:
            continue

        source = meta.get('source', 'misc')
        title = meta.get('title', fp.stem)
        chunks = chunk_text(content)

        print(f'  - {fp.name}  ({source}/{title}) → {len(chunks)} 块')

        for i, chunk in enumerate(chunks):
            chunk_id = f'{fp.stem}__{i}'
            all_chunks.append((chunk_id, chunk, source, title, meta))

    if not all_chunks:
        print('[ingest] 没有要处理的块')
        return

    # 批量生成 embedding
    texts = [c[1] for c in all_chunks]
    print(f'[ingest] 生成 {len(texts)} 条 embedding...')
    embeddings = embed(texts, api_key=jina_key, strict=True)

    # 写入 store
    items: List[Tuple[str, str, List[float], str, str, Optional[Dict]]] = []
    for (cid, content, source, title, meta), emb in zip(all_chunks, embeddings):
        items.append((cid, content, emb, source, title, meta))

    store.bulk_upsert(items)
    print(f'[ingest] ✅ 入库完成：{store.count()} 条')
    print('[ingest] 来源：')
    for s in store.list_sources():
        print(f'    · {s["source"]}: {s["chunks"]} 块')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--reset', action='store_true', help='清空向量库后重新入库')
    ap.add_argument('--source', default=None, help='只入指定来源的文件')
    ap.add_argument('--jina-key', default=None, help='Embedding API Key')
    args = ap.parse_args()

    # 没传 key 就从 config 读 DeepSeek key
    emb_key = args.jina_key
    if not emb_key:
        try:
            from config import settings
            emb_key = getattr(settings, 'SILICONFLOW_API_KEY', None) or getattr(settings, 'DEEPSEEK_API_KEY', None) or None
        except Exception:
            pass

    ingest(reset=args.reset, source_filter=args.source, jina_key=emb_key)
