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
    filter_teaching_chunks, _chunk_matches_concepts, tokenize, hash_id,
    EXERCISE_CONCEPTS
)
from evaluate_ragas_consolidated import (
    call_llm, parse_llm_json, safe_float,
    PRESTUDY_TEMPLATE, RAGAS_COMBINED_JUDGE_PROMPT
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

    # Filter teaching chunks once
    teaching_chunks = filter_teaching_chunks(chunks)
    teaching_indices = [i for i, c in enumerate(chunks) if not re.match(r"^Exercise\s+\d", c.title, re.IGNORECASE)]
    teaching_embs = chunk_embs[teaching_indices]
    model_emb = SentenceTransformer("all-MiniLM-L6-v2")

    for idx, q in enumerate(queries):
        ex_id = q["id"]
        title = q["title"]
        desc = q.get("desc", "")
        concepts = EXERCISE_CONCEPTS.get(ex_id, ["programming concepts", "Python syntax", "problem solving"])
        query_text = q.get("query_prestudy") or f"{title}\n{desc}"

        print(f"  [{idx+1}/{len(queries)}] {ex_id}: {title}...", flush=True)

        # 1. Retrieve RAG context (Dense Embedding)
        q_emb = model_emb.encode([query_text], show_progress_bar=False, normalize_embeddings=True)[0]
        retrieved = dense_retrieve(q_emb, teaching_chunks, teaching_embs, top_k=3)

        context_with_rag = "\n\n---\n\n".join([f"### {c.title}\n{c.content}" for c, _ in retrieved])
        chunks_with_ranks = "\n\n".join([f"[Chunk Rank {r+1}] ({c.source} | {c.title}):\n{c.content}" for r, (c, _) in enumerate(retrieved)])

        # A. Condition 1: No-RAG (Context is explicitly empty)
        prompt_no_rag = PRESTUDY_TEMPLATE.format(
            exercise_id=ex_id,
            title=title,
            description=desc,
            rag_context="(No course materials provided. Answer from general knowledge.)"
        )
        ans_no_rag = call_llm(prompt_no_rag, api_url, api_key, model, temperature=0.0)

        judge_prompt_no_rag = RAGAS_COMBINED_JUDGE_PROMPT.format(
            exercise_id=ex_id, title=title, description=desc, concepts=", ".join(concepts),
            chunks_with_ranks=chunks_with_ranks, question=query_text, answer=ans_no_rag
        )
        judge_no_rag = parse_llm_json(call_llm(judge_prompt_no_rag, api_url, api_key, model, temperature=0.0))

        f_no_rag = safe_float(judge_no_rag.get("faithfulness", 0.0))
        r_no_rag = safe_float(judge_no_rag.get("answer_relevancy", 0.0))
        results["No-RAG"]["faithfulness"].append(f_no_rag)
        results["No-RAG"]["answer_relevancy"].append(r_no_rag)

        # B. Condition 2: With-RAG
        prompt_with_rag = PRESTUDY_TEMPLATE.format(
            exercise_id=ex_id,
            title=title,
            description=desc,
            rag_context=context_with_rag
        )
        ans_with_rag = call_llm(prompt_with_rag, api_url, api_key, model, temperature=0.0)

        judge_prompt_with_rag = RAGAS_COMBINED_JUDGE_PROMPT.format(
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
        ex_id = q["id"]
        title = q["title"]
        desc = q.get("desc", "")
        concepts = EXERCISE_CONCEPTS.get(ex_id, ["programming concepts", "Python syntax", "problem solving"])
        query_text = q.get("query_prestudy") or f"{title}\n{desc}"
        target_lecture = q.get("gt_lecture", "")

        q_emb = model_emb.encode([query_text], show_progress_bar=False, normalize_embeddings=True)[0]

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


def run_ablation_3_title_embedding(
    queries: List[Dict[str, Any]],
    chunks: List[RagChunk],
) -> Dict[str, Any]:
    """Ablation 3: Compare Retrieval with Content-Only vs Title+Content Embedding."""
    print("\n" + "=" * 80)
    print("🔬 ABLATION 3: ± Title+Content Concatenation for Embedding")
    print("=" * 80)

    model_emb = SentenceTransformer("all-MiniLM-L6-v2")

    # Encode with Content Only
    content_only_texts = [c.content for c in chunks]
    embs_content_only = model_emb.encode(content_only_texts, show_progress_bar=False, normalize_embeddings=True)

    # Encode with Title + Content
    title_content_texts = [f"{c.title}\n{c.content}" for c in chunks]
    embs_title_content = model_emb.encode(title_content_texts, show_progress_bar=False, normalize_embeddings=True)

    results = {
        "Content-Only Embedding": {"hit@1": [], "hit@3": [], "hit@5": [], "mrr": []},
        "Title+Content Embedding": {"hit@1": [], "hit@3": [], "hit@5": [], "mrr": []},
    }

    for q in queries:
        ex_id = q["id"]
        title = q["title"]
        desc = q.get("desc", "")
        concepts = EXERCISE_CONCEPTS.get(ex_id, ["programming concepts", "Python syntax", "problem solving"])
        query_text = q.get("query_prestudy") or f"{title}\n{desc}"
        target_lecture = q.get("gt_lecture", "")

        q_emb = model_emb.encode([query_text], show_progress_bar=False, normalize_embeddings=True)[0]

        def eval_embs(embs):
            retrieved = dense_retrieve(q_emb, chunks, embs, top_k=5)
            hits = []
            for rank, (c, _) in enumerate(retrieved):
                is_rel = (target_lecture in c.source) and _chunk_matches_concepts(c, concepts)
                hits.append(1 if is_rel else 0)

            h1 = 1 if sum(hits[:1]) > 0 else 0
            h3 = 1 if sum(hits[:3]) > 0 else 0
            h5 = 1 if sum(hits[:5]) > 0 else 0
            first_hit = next((r + 1 for r, h in enumerate(hits) if h == 1), 0)
            mrr = 1.0 / first_hit if first_hit > 0 else 0.0
            return h1, h3, h5, mrr

        h1_c, h3_c, h5_c, mrr_c = eval_embs(embs_content_only)
        results["Content-Only Embedding"]["hit@1"].append(h1_c)
        results["Content-Only Embedding"]["hit@3"].append(h3_c)
        results["Content-Only Embedding"]["hit@5"].append(h5_c)
        results["Content-Only Embedding"]["mrr"].append(mrr_c)

        h1_tc, h3_tc, h5_tc, mrr_tc = eval_embs(embs_title_content)
        results["Title+Content Embedding"]["hit@1"].append(h1_tc)
        results["Title+Content Embedding"]["hit@3"].append(h3_tc)
        results["Title+Content Embedding"]["hit@5"].append(h5_tc)
        results["Title+Content Embedding"]["mrr"].append(mrr_tc)

    summary = {
        cond: {k: round(float(np.mean(v)) * (100 if "hit" in k else 1), 2 if "hit" in k else 4)
               for k, v in metrics.items()}
        for cond, metrics in results.items()
    }
    return {"summary": summary}


def main():
    parser = argparse.ArgumentParser(description="CellMate RAG Ablation Suite")
    parser.add_argument("--api-url", type=str, default=os.environ.get("CELLMATE_API_URL", ""),
                        help="LLM API endpoint")
    parser.add_argument("--api-key", type=str, default=os.environ.get("CELLMATE_API_KEY", ""),
                        help="API key")
    parser.add_argument("--model", type=str, default=os.environ.get("CELLMATE_MODEL", "gpt-oss:120b"),
                        help="Model name")
    parser.add_argument("--sample", type=int, default=0, help="Sample N queries (0 = all)")
    args = parser.parse_args()

    repo_path = os.environ.get("PROMPTFOLIO_PATH", "/Users/zq425/Desktop/promptfolio")
    if not os.path.exists(repo_path):
        repo_path = "/tmp/promptfolio_repo"
    if not os.path.exists(repo_path):
        repo_path = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

    knowledge_dir = os.path.join(repo_path, "knowledge")
    chunks = load_knowledge_base(knowledge_dir)
    queries = load_benchmark_queries(repo_path)
    if args.sample > 0 and args.sample < len(queries):
        import random
        random.seed(42)
        queries = random.sample(queries, args.sample)

    print(f"Loaded {len(chunks)} chunks and {len(queries)} queries.")

    # Base embedding for ablations 1 & 2
    model_emb = SentenceTransformer("all-MiniLM-L6-v2")
    chunk_texts = [f"{c.title}\n{c.content}" for c in chunks]
    chunk_embs = model_emb.encode(chunk_texts, show_progress_bar=False, normalize_embeddings=True)

    # 1. Ablation 3 (Pure IR: Title embedding)
    res_abl3 = run_ablation_3_title_embedding(queries, chunks)

    # 2. Ablation 2 (Pure IR: Filter exercises)
    res_abl2 = run_ablation_2_exercise_filter(queries, chunks, chunk_embs)

    # 3. Ablation 1 (LLM Generation: ± RAG) — only run if API credentials provided
    res_abl1 = None
    if args.api_url and args.api_key:
        res_abl1 = run_ablation_1_rag_effect(args.api_url, args.api_key, args.model, queries, chunks, chunk_embs)
    else:
        print("\n⚠️ Skipping Ablation 1 (± RAG Generation) because --api-url / --api-key were not provided.")

    all_ablations = {
        "ablation_1_rag_effect": res_abl1,
        "ablation_2_exercise_filter": res_abl2,
        "ablation_3_title_embedding": res_abl3,
    }

    # Print Summary Tables
    print("\n" + "=" * 90)
    print("📊 ABLATION STUDIES SUMMARY TABLE")
    print("=" * 90)

    if res_abl1:
        print("\n### Ablation 1: ± RAG Generation Quality")
        print(f"{'Condition':<25} | {'Faithfulness':<15} | {'Answer Relevancy':<15}")
        print("-" * 60)
        for cond, vals in res_abl1["summary"].items():
            print(f"{cond:<25} | {vals['faithfulness']:>13.4f} | {vals['answer_relevancy']:>15.4f}")

    print("\n### Ablation 2: ± Exercise Filtering (Pre-study Precision)")
    print(f"{'Condition':<35} | {'Prec@1':<8} | {'Prec@3':<8} | {'Prec@5':<8} | {'MRR':<8}")
    print("-" * 75)
    for cond, vals in res_abl2["summary"].items():
        print(f"{cond:<35} | {vals['prec@1']:>6.2f} | {vals['prec@3']:>6.2f} | {vals['prec@5']:>6.2f} | {vals['mrr']:>6.4f}")

    print("\n### Ablation 3: ± Title+Content Embedding (Retrieval Accuracy)")
    print(f"{'Condition':<30} | {'Hit@1 (%)':<10} | {'Hit@3 (%)':<10} | {'Hit@5 (%)':<10} | {'MRR':<8}")
    print("-" * 75)
    for cond, vals in res_abl3["summary"].items():
        print(f"{cond:<30} | {vals['hit@1']:>8.1f}% | {vals['hit@3']:>8.1f}% | {vals['hit@5']:>8.1f}% | {vals['mrr']:>6.4f}")

    out_file = os.path.join(os.path.dirname(__file__), "ablation_results.json")
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(all_ablations, f, indent=2)
    print(f"\nAll ablation results saved to {out_file}\n")


if __name__ == "__main__":
    main()
