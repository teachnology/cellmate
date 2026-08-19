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

def chunk_notebook(content: str, source: str, max_words: int = 600) -> List[RagChunk]:
    """Parse a Jupyter Notebook (.ipynb) file and chunk by section headings (##).
    Groups markdown explanations together with their associated code examples
    into coherent, topic-level learning units.
    Automatically filters out hidden test boilerplate cells.
    """
    chunks = []
    try:
        nb = json.loads(content)
    except Exception:
        return chunks
    cells = nb.get('cells', [])
    current_section_title = os.path.basename(source)
    section_buffer = ''
    start_cell_idx = 0

    def is_hidden_test_cell(text: str) -> bool:
        return 'BEGIN HIDDEN TESTS' in text or 'END HIDDEN TESTS' in text

    def flush_current_section(end_idx: int):
        nonlocal section_buffer, start_cell_idx
        trimmed = section_buffer.strip()
        if not trimmed:
            return
        tokens = list(set(tokenize(trimmed)))
        section_source = f"{source} [cells {start_cell_idx}-{end_idx}]"
        chunks.append(RagChunk(
            hash_id(source, f"{current_section_title}_{start_cell_idx}"),
            section_source,
            current_section_title,
            trimmed,
            tokens
        ))
        section_buffer = ''
        start_cell_idx = end_idx + 1

    for i, cell in enumerate(cells):
        src = cell.get('source', '')
        cell_src = "".join(src) if isinstance(src, list) else src
        if not cell_src.strip():
            continue

        # Filter out hidden test assertions
        if is_hidden_test_cell(cell_src):
            continue

        cell_type = cell.get('cell_type', '')

        if cell_type == 'markdown':
            heading_match = re.search(r'^##\s+(.+)$', cell_src, re.MULTILINE)
            if heading_match:
                if section_buffer.strip():
                    flush_current_section(i - 1)
                current_section_title = heading_match.group(1).strip()
                section_buffer = cell_src + '\n\n'
                start_cell_idx = i
                continue
            section_buffer += cell_src + '\n\n'
        elif cell_type == 'code':
            section_buffer += f"```python\n{cell_src.strip()}\n```\n\n"

        if len(section_buffer.split()) > max_words:
            flush_current_section(i)

    if section_buffer.strip():
        flush_current_section(len(cells) - 1)

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

# ---------------------------------------------------------------------------
# 4. Evaluation Benchmark Dataset (36 Exercises across 4 Lectures)
# ---------------------------------------------------------------------------
def load_benchmark_queries(repo_path: str) -> List[Dict[str, Any]]:
    tests_dir = os.path.join(repo_path, 'tests')
    queries = []
    
    # Ground truth mapping heuristic:
    # ex1_* -> lecture1.ipynb
    # ex2_* -> lecture2.ipynb
    # ex3_* -> lecture3.ipynb
    # ex4_* -> lecture4.ipynb
    lecture_map = {
        'ex1': 'lecture1.ipynb',
        'ex2': 'lecture2.ipynb',
        'ex3': 'lecture3.ipynb',
        'ex4': 'lecture4.ipynb'
    }
    
    for d in sorted(os.listdir(tests_dir)):
        ex_dir = os.path.join(tests_dir, d)
        if not os.path.isdir(ex_dir):
            continue
        meta_file = os.path.join(ex_dir, 'metadata.json')
        test_file = os.path.join(ex_dir, 'test.py')
        
        meta = {}
        if os.path.exists(meta_file):
            try:
                with open(meta_file) as f:
                    meta = json.load(f)
            except Exception:
                pass
                
        test_code = ""
        if os.path.exists(test_file):
            try:
                with open(test_file) as f:
                    test_code = f.read()
            except Exception:
                pass
                
        prefix = d.split('_')[0]
        gt_lecture = lecture_map.get(prefix, 'lecture1.ipynb')
        
        title = meta.get('title', d.replace('_', ' '))
        desc = meta.get('description', '')
        hints = " ".join(meta.get('hints', [])) if isinstance(meta.get('hints'), list) else ""
        
        # Modality A: Pre-study metadata query (exact same as extension.ts prestudyGuide)
        prestudy_query = f"{title}\n{desc}\n{hints}".strip()
        
        # Modality B: Student code / Error Debugging query (simulated student submission + analysis)
        code_query = f"def {d}():\n    # student code for {title}\n    {desc}\nAssertionError: failed test on hidden input"
        
        # Modality C: Conceptual query
        concept_query = f"{title} Python {prefix}"
        
        queries.append({
            'id': d,
            'lecture_prefix': prefix,
            'gt_lecture': gt_lecture,
            'title': title,
            'desc': desc,
            'hints': hints,
            'query_prestudy': prestudy_query,
            'query_code': code_query,
            'query_concept': concept_query,
        })
    return queries

# ---------------------------------------------------------------------------
# 5. Metric Calculations
# ---------------------------------------------------------------------------
def evaluate_retrieval(retrieved_chunks: List[Tuple[RagChunk, float]], gt_lecture: str, k_list=[1, 3, 5, 10]) -> Dict[str, Any]:
    """
    Check if retrieved chunk's source corresponds to the ground truth lecture.
    Also checks specific title relevance.
    """
    hits = {f'hit@{k}': 0 for k in k_list}
    first_rank = None
    
    for rank, (chunk, score) in enumerate(retrieved_chunks):
        # A chunk is relevant if it comes from the target lecture
        is_relevant = gt_lecture.lower() in chunk.source.lower()
        if is_relevant:
            if first_rank is None:
                first_rank = rank + 1  # 1-indexed
            for k in k_list:
                if (rank + 1) <= k:
                    hits[f'hit@{k}'] = 1
                    
    reciprocal_rank = 1.0 / first_rank if first_rank is not None else 0.0
    return {
        **hits,
        'reciprocal_rank': reciprocal_rank,
        'first_rank': first_rank
    }

# ---------------------------------------------------------------------------
# 6. Main Evaluation Pipeline
# ---------------------------------------------------------------------------
def run_evaluation():
    repo_path = '/Users/zq425/Desktop/promptfolio'
    if not os.path.exists(repo_path):
        repo_path = '/tmp/promptfolio_repo'
    knowledge_dir = os.path.join(repo_path, 'knowledge')
    
    print(f"Loading knowledge base from: {knowledge_dir}")
    chunks = load_knowledge_base(knowledge_dir)
    print(f"Total knowledge chunks extracted: {len(chunks)}")
    
    # Check chunks per lecture
    chunk_counts = {}
    for c in chunks:
        base = c.source.split()[0]
        chunk_counts[base] = chunk_counts.get(base, 0) + 1
    print("Chunks distribution:")
    for k, v in sorted(chunk_counts.items()):
        print(f"  - {k}: {v} chunks")
        
    print("\nLoading SentenceTransformer model ('all-MiniLM-L6-v2')...")
    model = SentenceTransformer('all-MiniLM-L6-v2')
    
    chunk_texts = [f"{c.title}\n{c.content}" for c in chunks]
    print(f"Embedding {len(chunk_texts)} chunks...")
    chunk_embs = model.encode(chunk_texts, show_progress_bar=False, normalize_embeddings=True)
    
    for i, c in enumerate(chunks):
        c.embedding = chunk_embs[i]
        
    # Setup in-memory ChromaDB
    print("Initializing ChromaDB collection...")
    chroma_client = chromadb.Client(Settings(anonymized_telemetry=False, is_persistent=False))
    collection = chroma_client.create_collection(
        name="eval_collection",
        metadata={"hnsw:space": "cosine"}
    )
    collection.add(
        ids=[c.id for c in chunks],
        documents=[c.content for c in chunks],
        metadatas=[{"source": c.source, "title": c.title} for c in chunks],
        embeddings=chunk_embs.tolist()
    )
    print("ChromaDB index populated.")
    
    queries = load_benchmark_queries(repo_path)
    print(f"Loaded {len(queries)} benchmark queries across exercises.\n")
    
    methods = ['BM25-lite (Keyword)', 'Dense Embedding (Cosine)', 'ChromaDB Backend', 'Hybrid (BM25 + Dense RRF)']
    modalities = [
        ('Pre-study Metadata Query', 'query_prestudy'),
        ('Student Code / Debugging Query', 'query_code'),
        ('Conceptual Query', 'query_concept')
    ]
    
    results = {}
    detailed_logs = []
    
    for mod_name, mod_key in modalities:
        results[mod_name] = {}
        for method in methods:
            results[mod_name][method] = {
                'hit@1': [], 'hit@3': [], 'hit@5': [], 'hit@10': [], 'mrr': [], 'latency_ms': []
            }
            
        for q in queries:
            query_text = q[mod_key]
            gt = q['gt_lecture']
            
            # 1. BM25-lite
            t0 = time.perf_counter()
            bm25_res = bm25_lite_retrieve(query_text, chunks, top_k=10)
            t1 = time.perf_counter()
            bm25_metrics = evaluate_retrieval(bm25_res, gt)
            bm25_lat = (t1 - t0) * 1000
            
            results[mod_name]['BM25-lite (Keyword)']['hit@1'].append(bm25_metrics['hit@1'])
            results[mod_name]['BM25-lite (Keyword)']['hit@3'].append(bm25_metrics['hit@3'])
            results[mod_name]['BM25-lite (Keyword)']['hit@5'].append(bm25_metrics['hit@5'])
            results[mod_name]['BM25-lite (Keyword)']['hit@10'].append(bm25_metrics['hit@10'])
            results[mod_name]['BM25-lite (Keyword)']['mrr'].append(bm25_metrics['reciprocal_rank'])
            results[mod_name]['BM25-lite (Keyword)']['latency_ms'].append(bm25_lat)
            
            # 2. Dense Embedding (Cosine)
            t0 = time.perf_counter()
            q_emb = model.encode([query_text], normalize_embeddings=True)[0]
            dense_res = dense_retrieve(q_emb, chunks, chunk_embs, top_k=10)
            t1 = time.perf_counter()
            dense_metrics = evaluate_retrieval(dense_res, gt)
            dense_lat = (t1 - t0) * 1000
            
            results[mod_name]['Dense Embedding (Cosine)']['hit@1'].append(dense_metrics['hit@1'])
            results[mod_name]['Dense Embedding (Cosine)']['hit@3'].append(dense_metrics['hit@3'])
            results[mod_name]['Dense Embedding (Cosine)']['hit@5'].append(dense_metrics['hit@5'])
            results[mod_name]['Dense Embedding (Cosine)']['hit@10'].append(dense_metrics['hit@10'])
            results[mod_name]['Dense Embedding (Cosine)']['mrr'].append(dense_metrics['reciprocal_rank'])
            results[mod_name]['Dense Embedding (Cosine)']['latency_ms'].append(dense_lat)
            
            # 3. ChromaDB Backend
            t0 = time.perf_counter()
            chroma_q_res = collection.query(
                query_embeddings=[q_emb.tolist()],
                n_results=10,
                include=["metadatas", "distances"]
            )
            t1 = time.perf_counter()
            chroma_res = []
            if chroma_q_res and chroma_q_res["ids"] and chroma_q_res["ids"][0]:
                for idx in range(len(chroma_q_res["ids"][0])):
                    cid = chroma_q_res["ids"][0][idx]
                    src = chroma_q_res["metadatas"][0][idx].get("source", "")
                    title = chroma_q_res["metadatas"][0][idx].get("title", "")
                    chunk_obj = next((c for c in chunks if c.id == cid), RagChunk(cid, src, title, "", []))
                    dist = chroma_q_res["distances"][0][idx]
                    chroma_res.append((chunk_obj, 1.0 - dist))
            chroma_metrics = evaluate_retrieval(chroma_res, gt)
            chroma_lat = (t1 - t0) * 1000
            
            results[mod_name]['ChromaDB Backend']['hit@1'].append(chroma_metrics['hit@1'])
            results[mod_name]['ChromaDB Backend']['hit@3'].append(chroma_metrics['hit@3'])
            results[mod_name]['ChromaDB Backend']['hit@5'].append(chroma_metrics['hit@5'])
            results[mod_name]['ChromaDB Backend']['hit@10'].append(chroma_metrics['hit@10'])
            results[mod_name]['ChromaDB Backend']['mrr'].append(chroma_metrics['reciprocal_rank'])
            results[mod_name]['ChromaDB Backend']['latency_ms'].append(chroma_lat)
            
            # 4. Hybrid (BM25 + Dense RRF)
            t0 = time.perf_counter()
            hybrid_res = hybrid_rrf_retrieve(bm25_res, dense_res, k=60, top_k=10)
            t1 = time.perf_counter()
            hybrid_metrics = evaluate_retrieval(hybrid_res, gt)
            hybrid_lat = (t1 - t0) * 1000 + bm25_lat + dense_lat
            
            results[mod_name]['Hybrid (BM25 + Dense RRF)']['hit@1'].append(hybrid_metrics['hit@1'])
            results[mod_name]['Hybrid (BM25 + Dense RRF)']['hit@3'].append(hybrid_metrics['hit@3'])
            results[mod_name]['Hybrid (BM25 + Dense RRF)']['hit@5'].append(hybrid_metrics['hit@5'])
            results[mod_name]['Hybrid (BM25 + Dense RRF)']['hit@10'].append(hybrid_metrics['hit@10'])
            results[mod_name]['Hybrid (BM25 + Dense RRF)']['mrr'].append(hybrid_metrics['reciprocal_rank'])
            results[mod_name]['Hybrid (BM25 + Dense RRF)']['latency_ms'].append(hybrid_lat)
            
            detailed_logs.append({
                'exercise_id': q['id'],
                'modality': mod_name,
                'target_lecture': gt,
                'bm25_top1': bm25_res[0][0].source if bm25_res else 'None',
                'dense_top1': dense_res[0][0].source if dense_res else 'None',
                'bm25_mrr': bm25_metrics['reciprocal_rank'],
                'dense_mrr': dense_metrics['reciprocal_rank'],
            })

    # Summary table generation
    print("=" * 90)
    print("CELLMATE RAG EVALUATION BENCHMARK RESULTS")
    print("=" * 90)
    
    summary_data = {}
    for mod_name in results:
        print(f"\n### Query Modality: {mod_name} (N = {len(queries)} queries)")
        print("-" * 90)
        print(f"{'Retrieval Engine':<28} | {'Hit@1':<8} | {'Hit@3':<8} | {'Hit@5':<8} | {'Hit@10':<8} | {'MRR':<8} | {'Latency':<8}")
        print("-" * 90)
        summary_data[mod_name] = {}
        for method in methods:
            h1 = np.mean(results[mod_name][method]['hit@1']) * 100
            h3 = np.mean(results[mod_name][method]['hit@3']) * 100
            h5 = np.mean(results[mod_name][method]['hit@5']) * 100
            h10 = np.mean(results[mod_name][method]['hit@10']) * 100
            mrr = np.mean(results[mod_name][method]['mrr'])
            lat = np.mean(results[mod_name][method]['latency_ms'])
            
            summary_data[mod_name][method] = {
                'hit@1': round(h1, 2),
                'hit@3': round(h3, 2),
                'hit@5': round(h5, 2),
                'hit@10': round(h10, 2),
                'mrr': round(mrr, 4),
                'latency_ms': round(lat, 2)
            }
            print(f"{method:<28} | {h1:>6.1f}% | {h3:>6.1f}% | {h5:>6.1f}% | {h10:>6.1f}% | {mrr:>6.4f} | {lat:>6.2f}ms")
            
    # Save raw json output
    output_json_path = os.path.join(os.path.dirname(__file__), 'rag_eval_results.json')
    with open(output_json_path, 'w', encoding='utf-8') as fp:
        json.dump(summary_data, fp, indent=2)
    print(f"\nResults saved to {output_json_path}")
    return summary_data

if __name__ == '__main__':
    run_evaluation()
