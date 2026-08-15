"""
CellMate RAG System Evaluation Script
====================================
Evaluates Hit@K (K=1, 3, 5, 10), MRR (Mean Reciprocal Rank), MAP (Mean Average Precision),
and retrieval latency across:
  1. BM25-lite Keyword RAG (src/ragUtils.ts algorithm)
  2. Dense Embedding Vector RAG (all-MiniLM-L6-v2 cosine similarity)
  3. ChromaDB Backend (rag-server Chroma vector store)
  4. Hybrid RAG (BM25 + Dense RRF / Reciprocal Rank Fusion)

Across 3 Query Modalities for all 36 curriculum exercises:
  - Modality A: Pre-study / Metadata Query (Title + Description + Hints)
  - Modality B: Code / Debugging Query (Function definition + test failure analysis)
  - Modality C: Conceptual Query (Core Python concept & keywords)
"""

import os
import json
import math
import time
import re
import hashlib
from typing import List, Dict, Any, Tuple
import numpy as np
from sentence_transformers import SentenceTransformer
import chromadb
from chromadb.config import Settings

# ---------------------------------------------------------------------------
# 1. Stopwords & Tokenization (Exact match with src/ragUtils.ts)
# ---------------------------------------------------------------------------
STOPWORDS = set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
  'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
  'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
  'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each',
  'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
  'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
  'just', 'because', 'but', 'and', 'or', 'if', 'while', 'about', 'up',
  'that', 'this', 'it', 'its', 'i', 'me', 'my', 'we', 'our', 'you',
  'your', 'he', 'him', 'his', 'she', 'her', 'they', 'them', 'their',
  'what', 'which', 'who', 'whom', 'these', 'those',
])

def tokenize(text: str) -> List[str]:
    words = re.findall(r'[a-z0-9_]+', text.lower())
    return [w for w in words if len(w) > 1 and w not in STOPWORDS]

def hash_id(source: str, title: str) -> str:
    return hashlib.md5(f"{source}::{title}".encode('utf-8')).hexdigest()[:12]

# ---------------------------------------------------------------------------
# 2. Chunking Logic (Exact match with src/ragUtils.ts)
# ---------------------------------------------------------------------------
class RagChunk:
    def __init__(self, chunk_id: str, source: str, title: str, content: str, tokens: List[str]):
        self.id = chunk_id
        self.source = source
        self.title = title
        self.content = content
        self.tokens = tokens
        self.embedding = None

    def to_dict(self):
        return {
            'id': self.id,
            'source': self.source,
            'title': self.title,
            'content': self.content,
            'tokens': self.tokens
        }

def chunk_markdown(content: str, source: str, max_words: int = 500) -> List[RagChunk]:
    chunks = []
    sections = re.split(r'^(?=## )', content, flags=re.MULTILINE)
    for section in sections:
        trimmed = section.strip()
        if not trimmed:
            continue
        heading_match = re.search(r'^##\s+(.+)$', trimmed, flags=re.MULTILINE)
        title = heading_match.group(1).strip() if heading_match else os.path.basename(source)
        words = trimmed.split()
        if len(words) <= max_words:
            tokens = list(set(tokenize(trimmed)))
            chunks.append(RagChunk(hash_id(source, title), source, title, trimmed, tokens))
        else:
            paras = re.split(r'\n\n+', trimmed)
            buf = ''
            part_idx = 0
            for p in paras:
                if buf and len((buf + '\n\n' + p).split()) > max_words:
                    sub_title = f"{title} (part {part_idx + 1})"
                    tokens = list(set(tokenize(buf)))
                    chunks.append(RagChunk(hash_id(source, sub_title), source, sub_title, buf.strip(), tokens))
                    buf = p
                    part_idx += 1
                else:
                    buf = buf + '\n\n' + p if buf else p
            if buf.strip():
                sub_title = f"{title} (part {part_idx + 1})" if part_idx > 0 else title
                tokens = list(set(tokenize(buf)))
                chunks.append(RagChunk(hash_id(source, sub_title), source, sub_title, buf.strip(), tokens))
    return chunks

def chunk_python(content: str, source: str) -> List[RagChunk]:
    chunks = []
    blocks = re.split(r'^(?=(?:def |class ))', content, flags=re.MULTILINE)
    for block in blocks:
        trimmed = block.strip()
        if not trimmed:
            continue
        name_match = re.search(r'^(?:def|class)\s+(\w+)', trimmed)
        title = name_match.group(1) if name_match else os.path.basename(source)
        tokens = list(set(tokenize(trimmed)))
        chunks.append(RagChunk(hash_id(source, title), source, title, trimmed, tokens))
    if not chunks and content.strip():
        title = os.path.basename(source)
        tokens = list(set(tokenize(content)))
        chunks.append(RagChunk(hash_id(source, title), source, title, content.strip(), tokens))
    return chunks

def chunk_notebook(content: str, source: str) -> List[RagChunk]:
    chunks = []
    try:
        nb = json.loads(content)
    except Exception:
        return chunks
    cells = nb.get('cells', [])
    md_buf = ''
    md_start_idx = -1

    def flush_md():
        nonlocal md_buf, md_start_idx
        if md_buf.strip():
            sec_source = f"{source} [cells {md_start_idx}+]"
            chunks.extend(chunk_markdown(md_buf, sec_source))
        md_buf = ''
        md_start_idx = -1

    for i, cell in enumerate(cells):
        src = cell.get('source', '')
        cell_src = "".join(src) if isinstance(src, list) else src
        if not cell_src.strip():
            continue
        cell_type = cell.get('cell_type', '')
        if cell_type == 'markdown':
            if md_start_idx < 0:
                md_start_idx = i
            md_buf += cell_src + '\n\n'
        elif cell_type == 'code':
            flush_md()
            code_source = f"{source} [cell {i}]"
            chunks.extend(chunk_python(cell_src, code_source))
    flush_md()
    return chunks

def load_knowledge_base(knowledge_dir: str) -> List[RagChunk]:
    chunks = []
    for root, _, files in os.walk(knowledge_dir):
        for f in sorted(files):
            full_path = os.path.join(root, f)
            rel_path = os.path.relpath(full_path, knowledge_dir)
            if f.endswith('.ipynb'):
                with open(full_path, 'r', encoding='utf-8') as fp:
                    chunks.extend(chunk_notebook(fp.read(), rel_path))
            elif f.endswith('.py'):
                with open(full_path, 'r', encoding='utf-8') as fp:
                    chunks.extend(chunk_python(fp.read(), rel_path))
            elif f.endswith(('.md', '.txt')):
                with open(full_path, 'r', encoding='utf-8') as fp:
                    chunks.extend(chunk_markdown(fp.read(), rel_path))
    return chunks

# ---------------------------------------------------------------------------
# 3. Retrieval Engines
# ---------------------------------------------------------------------------
def bm25_lite_retrieve(query: str, chunks: List[RagChunk], top_k: int = 10) -> List[Tuple[RagChunk, float]]:
    """Exact replica of BM25-lite keyword retrieval in src/ragUtils.ts"""
    query_tokens = list(set(tokenize(query)))
    if not query_tokens or not chunks:
        return []
    N = len(chunks)
    df = {}
    for token in query_tokens:
        count = sum(1 for c in chunks if token in c.tokens)
        df[token] = count
    
    scored = []
    for c in chunks:
        score = 0.0
        chunk_token_set = set(c.tokens)
        for token in query_tokens:
            if token in chunk_token_set:
                term_df = df.get(token, 0)
                score += math.log(N / (1.0 + term_df))
        scored.append((c, score))
    
    scored.sort(key=lambda x: x[1], reverse=True)
    return [s for s in scored[:top_k] if s[1] > 0]

def dense_retrieve(query_emb: np.ndarray, chunks: List[RagChunk], chunk_embs: np.ndarray, top_k: int = 10) -> List[Tuple[RagChunk, float]]:
    """Cosine similarity dense retrieval."""
    # Cosine similarity: dot product of normalized vectors
    scores = np.dot(chunk_embs, query_emb)
    ranked_indices = np.argsort(scores)[::-1][:top_k]
    return [(chunks[idx], float(scores[idx])) for idx in ranked_indices if scores[idx] > 0]

def hybrid_rrf_retrieve(bm25_res: List[Tuple[RagChunk, float]], dense_res: List[Tuple[RagChunk, float]], k: int = 60, top_k: int = 10) -> List[Tuple[RagChunk, float]]:
    """Reciprocal Rank Fusion (RRF) combining BM25 and Dense embeddings."""
    rrf_scores = {}
    chunk_map = {}
    
    for rank, (chunk, _) in enumerate(bm25_res):
        rrf_scores[chunk.id] = rrf_scores.get(chunk.id, 0.0) + (1.0 / (k + rank + 1))
        chunk_map[chunk.id] = chunk
        
    for rank, (chunk, _) in enumerate(dense_res):
        rrf_scores[chunk.id] = rrf_scores.get(chunk.id, 0.0) + (1.0 / (k + rank + 1))
        chunk_map[chunk.id] = chunk
        
    sorted_items = sorted(rrf_scores.items(), key=lambda x: x[1], reverse=True)
    return [(chunk_map[cid], score) for cid, score in sorted_items[:top_k]]

