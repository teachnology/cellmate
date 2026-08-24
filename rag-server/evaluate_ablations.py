"""
CellMate RAG Ablation Studies
=============================
Evaluates the isolated contributions of key RAG components:
  1. Ablation 1: ± RAG Context (No-RAG Baseline vs With-RAG Grounded)
  2. Ablation 2: ± excludeExercises (With vs Without Exercise Chunk Filtering)
  3. Ablation 3: ± Title+Content Embedding (Title-augmented vs Content-only Vectorization)

Usage:
  python evaluate_ablations.py --api-url <URL> --api-key <KEY> [--model <MODEL>] [--sample <N>]

Output:
  rag-server/ablation_results.json
"""

import os
import sys
import json
import time
import re
import argparse
from typing import List, Dict, Any, Tuple
import numpy as np
from sentence_transformers import SentenceTransformer

# Re-use utilities from evaluate_rag and evaluate_ragas_consolidated
sys.path.insert(0, os.path.dirname(__file__))
from evaluate_rag import (
    RagChunk, load_knowledge_base, load_benchmark_queries,
    bm25_lite_retrieve, dense_retrieve, hybrid_rrf_retrieve,
    filter_teaching_chunks, _chunk_matches_concepts, tokenize, hash_id
)
from evaluate_ragas_consolidated import (
    call_llm, parse_llm_json, safe_float, make_engines,
    PRESTUDY_STUDENT_PROMPT, PRESTUDY_JUDGE_PROMPT,
    FEEDBACK_STUDENT_PROMPT, FEEDBACK_JUDGE_PROMPT
)


def run_ablation_1_rag_effect(
    api_url: str,
    api_key: str,
    model: str,
    queries: List[Dict[str, Any]],
    chunks: List[RagChunk],
    chunk_embs: np.ndarray,
) -> Dict[str, Any]:
    """Ablation 1: Compare Generation Quality: No-RAG (Raw LLM) vs With-RAG (Dense Embedding)."""
    print("\n" + "=" * 80)
    print("🔬 ABLATION 1: ± RAG Context (No-RAG vs With-RAG Grounded)")
    print("=" * 80)

    results = {
        "No-RAG": {"faithfulness": [], "answer_relevancy": []},
        "With-RAG (Dense)": {"faithfulness": [], "answer_relevancy": []},
    }
    records = []

    for idx, q in enumerate(queries):
        ex_id = q["exercise_id"]
        title = q["title"]
        desc = q["description"]
        concepts = q["concepts"]

        print(f"  [{idx+1}/{len(queries)}] {ex_id}: {title}...", flush=True)

        # 1. Retrieve RAG context (Dense Embedding)
        query_text = f"{title} {desc}"
        teaching_chunks = filter_teaching_chunks(chunks)
        teaching_indices = [i for i, c in enumerate(chunks) if not c.title.startswith("Exercise")]
        teaching_embs = chunk_embs[teaching_indices]

        model_emb = SentenceTransformer("all-MiniLM-L6-v2")
        q_emb = model_emb.encode([query_text], show_progress_bar=False, normalize_embeddings=True)[0]
        retrieved = dense_retrieve(q_emb, teaching_chunks, teaching_embs, top_k=3)

        context_with_rag = "\n\n---\n\n".join([f"### {c.title}\n{c.content}" for c, _ in retrieved])
        chunks_with_ranks = "\n\n".join([f"[Chunk Rank {r+1}] ({c.source} | {c.title}):\n{c.content}" for r, (c, _) in enumerate(retrieved)])

        # A. Condition 1: No-RAG (Context is explicitly empty)
        prompt_no_rag = PRESTUDY_STUDENT_PROMPT.format(
            title=title, description=desc, context="(No course materials provided. Answer from general knowledge.)"
        )
        ans_no_rag = call_llm(prompt_no_rag, api_url, api_key, model, temperature=0.0)

        judge_prompt_no_rag = PRESTUDY_JUDGE_PROMPT.format(
            exercise_id=ex_id, title=title, description=desc, concepts=", ".join(concepts),
            chunks_with_ranks=chunks_with_ranks, question=query_text, answer=ans_no_rag
        )
        judge_no_rag = parse_llm_json(call_llm(judge_prompt_no_rag, api_url, api_key, model, temperature=0.0))

        f_no_rag = safe_float(judge_no_rag.get("faithfulness", 0.0))
        r_no_rag = safe_float(judge_no_rag.get("answer_relevancy", 0.0))
        results["No-RAG"]["faithfulness"].append(f_no_rag)
        results["No-RAG"]["answer_relevancy"].append(r_no_rag)

        # B. Condition 2: With-RAG
        prompt_with_rag = PRESTUDY_STUDENT_PROMPT.format(
            title=title, description=desc, context=context_with_rag
        )
        ans_with_rag = call_llm(prompt_with_rag, api_url, api_key, model, temperature=0.0)

        judge_prompt_with_rag = PRESTUDY_JUDGE_PROMPT.format(
            exercise_id=ex_id, title=title, description=desc, concepts=", ".join(concepts),
            chunks_with_ranks=chunks_with_ranks, question=query_text, answer=ans_with_rag
        )
        judge_with_rag = parse_llm_json(call_llm(judge_prompt_with_rag, api_url, api_key, model, temperature=0.0))

        f_with_rag = safe_float(judge_with_rag.get("faithfulness", 0.0))
        r_with_rag = safe_float(judge_with_rag.get("answer_relevancy", 0.0))
        results["With-RAG (Dense)"]["faithfulness"].append(f_with_rag)
        results["With-RAG (Dense)"]["answer_relevancy"].append(r_with_rag)

        print(f"    No-RAG:   Faith={f_no_rag:.2f}, Rel={r_no_rag:.2f}")
        print(f"    With-RAG: Faith={f_with_rag:.2f}, Rel={r_with_rag:.2f}", flush=True)

        records.append({
            "exercise_id": ex_id,
            "no_rag": {"faithfulness": f_no_rag, "relevancy": r_no_rag},
            "with_rag": {"faithfulness": f_with_rag, "relevancy": r_with_rag},
        })
        time.sleep(0.5)

    summary = {
        cond: {k: round(float(np.mean(v)), 4) for k, v in metrics.items()}
        for cond, metrics in results.items()
    }
    return {"summary": summary, "details": records}


def run_ablation_2_exercise_filter(
    queries: List[Dict[str, Any]],
    chunks: List[RagChunk],
    chunk_embs: np.ndarray,
) -> Dict[str, Any]:
    """Ablation 2: Compare Pre-study Retrieval Precision with and without excludeExercises filter."""
    print("\n" + "=" * 80)
    print("🔬 ABLATION 2: ± excludeExercises (Exercise Filter on Pre-study)")
    print("=" * 80)

    model_emb = SentenceTransformer("all-MiniLM-L6-v2")
    results = {
        "Unfiltered (excludeExercises=False)": {"prec@1": [], "prec@3": [], "prec@5": [], "mrr": []},
        "Filtered (excludeExercises=True)": {"prec@1": [], "prec@3": [], "prec@5": [], "mrr": []},
    }

    # Prepare chunk pools
    unfiltered_chunks = chunks
    unfiltered_embs = chunk_embs

    filtered_indices = [i for i, c in enumerate(chunks) if not re.match(r"^Exercise\s+\d", c.title, re.IGNORECASE)]
    filtered_chunks = [chunks[i] for i in filtered_indices]
    filtered_embs = chunk_embs[filtered_indices]

    for q in queries:
        query_text = f"{q['title']} {q['description']}"
        q_emb = model_emb.encode([query_text], show_progress_bar=False, normalize_embeddings=True)[0]
        concepts = q["concepts"]
        target_lecture = q["source_file"]

        def eval_pool(pool, embs):
            retrieved = dense_retrieve(q_emb, pool, embs, top_k=5)
            hits = []
            for rank, (c, _) in enumerate(retrieved):
                is_rel = (target_lecture in c.source) and _chunk_matches_concepts(c, concepts)
                # If chunk is an Exercise problem statement, it's non-teaching noise for pre-study
                is_exercise_noise = bool(re.match(r"^Exercise\s+\d", c.title, re.IGNORECASE))
                hits.append(1 if (is_rel and not is_exercise_noise) else 0)

            p1 = hits[0]
            p3 = sum(hits[:3]) / 3.0
            p5 = sum(hits[:5]) / 5.0
            first_hit = next((r + 1 for r, h in enumerate(hits) if h == 1), 0)
            mrr = 1.0 / first_hit if first_hit > 0 else 0.0
            return p1, p3, p5, mrr

        # Unfiltered
        u_p1, u_p3, u_p5, u_mrr = eval_pool(unfiltered_chunks, unfiltered_embs)
        results["Unfiltered (excludeExercises=False)"]["prec@1"].append(u_p1)
        results["Unfiltered (excludeExercises=False)"]["prec@3"].append(u_p3)
        results["Unfiltered (excludeExercises=False)"]["prec@5"].append(u_p5)
        results["Unfiltered (excludeExercises=False)"]["mrr"].append(u_mrr)

        # Filtered
        f_p1, f_p3, f_p5, f_mrr = eval_pool(filtered_chunks, filtered_embs)
        results["Filtered (excludeExercises=True)"]["prec@1"].append(f_p1)
        results["Filtered (excludeExercises=True)"]["prec@3"].append(f_p3)
        results["Filtered (excludeExercises=True)"]["prec@5"].append(f_p5)
        results["Filtered (excludeExercises=True)"]["mrr"].append(f_mrr)

    summary = {
        cond: {k: round(float(np.mean(v)), 4) for k, v in metrics.items()}
        for cond, metrics in results.items()
    }
    return {"summary": summary}


