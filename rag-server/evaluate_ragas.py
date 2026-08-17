"""
CellMate RAGAs: LLM-as-a-Judge Evaluation
==========================================
Evaluates CellMate's RAG pipeline using the RAGAs framework metrics,
implemented via direct LLM API calls (no ragas pip dependency needed).

Metrics evaluated:
  1. Faithfulness     — Is the answer grounded in the retrieved context?
  2. Answer Relevancy — Does the answer address the original question?
  3. Context Recall   — Does the retrieved context cover the ground truth?
  4. Context Precision — Are the relevant chunks ranked higher?

Evaluated across 3 retrieval engines × 2 RAG usage scenarios:
  - BM25-lite (Keyword mode)
  - Dense Embedding / ChromaDB (Semantic mode)
  - Hybrid (BM25 + Dense RRF)

Usage:
  python evaluate_ragas.py --api-url <URL> --api-key <KEY> [--model <MODEL>]

Environment variables:
  CELLMATE_API_URL   — LLM API endpoint (OpenAI-compatible /chat/completions)
  CELLMATE_API_KEY   — API key
  CELLMATE_MODEL     — Model name (default: gpt-oss:120b)
"""

import os
import sys
import json
import time
import math
import re
import hashlib
import argparse
import textwrap
from typing import List, Dict, Any, Tuple, Optional
import numpy as np

# ---------------------------------------------------------------------------
# Re-use chunking & retrieval from evaluate_rag.py
# ---------------------------------------------------------------------------
sys.path.insert(0, os.path.dirname(__file__))
from evaluate_rag import (
    RagChunk, load_knowledge_base, load_benchmark_queries,
    bm25_lite_retrieve, dense_retrieve, hybrid_rrf_retrieve
)

# ---------------------------------------------------------------------------
# LLM API Client
# ---------------------------------------------------------------------------
import requests

def call_llm(
    prompt: str,
    api_url: str,
    api_key: str,
    model: str,
    temperature: float = 0.0,
    max_tokens: int = 1024,
) -> str:
    """Call LLM API — auto-detects Ollama vs OpenAI format."""
    is_ollama = '/api/generate' in api_url or '/api/chat' in api_url
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }
    if is_ollama:
        body = {
            "model": model,
            "prompt": prompt,
            "stream": False,
            "options": {"temperature": temperature, "num_predict": max_tokens},
        }
    else:
        body = {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": False,
        }
    for attempt in range(3):
        try:
            resp = requests.post(api_url, json=body, headers=headers, timeout=120)
            resp.raise_for_status()
            data = resp.json()
            if is_ollama:
                return data.get("response", "").strip()
            else:
                return data["choices"][0]["message"]["content"].strip()
        except Exception as e:
            if attempt == 2:
                print(f"  [LLM ERROR] {e}")
                return ""
            time.sleep(2 ** attempt)
    return ""


# ---------------------------------------------------------------------------
# RAGAs Metric Prompts (LLM-as-a-Judge)
# ---------------------------------------------------------------------------

FAITHFULNESS_PROMPT = textwrap.dedent("""\
You are evaluating the faithfulness of an AI-generated answer.

Faithfulness measures whether ALL claims in the answer can be verified from the provided context. 
An answer is faithful if every factual statement it makes is supported by information in the context.

## Context (Retrieved Knowledge Chunks)
{context}

## Question
{question}

## AI-Generated Answer
{answer}

## Task
1. Extract each factual claim / statement from the AI answer.
2. For each claim, determine if it is supported by the context (YES/NO).
3. Compute: faithfulness_score = (number of supported claims) / (total claims)

Respond ONLY with a JSON object in this exact format (no markdown, no extra text):
{{"claims": [{{"claim": "...", "supported": true/false}}, ...], "score": <float 0.0-1.0>}}
""")

ANSWER_RELEVANCY_PROMPT = textwrap.dedent("""\
You are evaluating the relevancy of an AI-generated answer to the original question.

Answer Relevancy measures how well the answer addresses what was asked.
A highly relevant answer directly addresses the question with appropriate detail.
An irrelevant answer is off-topic, too vague, or answers a different question.

## Question
{question}

## AI-Generated Answer
{answer}

## Task
Rate the answer's relevancy on a 0.0 to 1.0 scale:
- 1.0: Perfectly relevant, directly addresses every aspect of the question
- 0.7-0.9: Mostly relevant, addresses the core question with minor tangents
- 0.4-0.6: Partially relevant, addresses some aspects but misses key parts
- 0.1-0.3: Marginally relevant, mostly off-topic
- 0.0: Completely irrelevant

Respond ONLY with a JSON object (no markdown, no extra text):
{{"reasoning": "brief explanation", "score": <float 0.0-1.0>}}
""")

CONTEXT_RECALL_PROMPT = textwrap.dedent("""\
You are evaluating the recall of retrieved context for a programming exercise.

Context Recall measures whether the retrieved context contains ALL the information 
needed to correctly guide a student on this exercise.

## Exercise Information (Ground Truth)
- Exercise ID: {exercise_id}
- Title: {title}
- Description: {description}
- Key concepts needed: {concepts}

## Retrieved Context (Top-K Chunks)
{context}

## Task
Determine what fraction of the essential concepts / information needed for this 
exercise is present in the retrieved context.

For each key concept needed:
1. List the concept
2. Determine if it is covered in the retrieved context (YES/NO)
3. Compute: recall = (concepts covered) / (total concepts needed)

Respond ONLY with a JSON object (no markdown, no extra text):
{{"concepts": [{{"concept": "...", "covered": true/false}}, ...], "score": <float 0.0-1.0>}}
""")

CONTEXT_PRECISION_PROMPT = textwrap.dedent("""\
You are evaluating the precision of retrieved context for a programming exercise.

Context Precision measures whether the retrieved chunks are relevant and properly 
ranked — relevant chunks should appear before irrelevant ones.

## Exercise Information
- Exercise ID: {exercise_id}
- Title: {title}  
- Description: {description}

## Retrieved Chunks (in retrieval order, from rank 1 to N)
{chunks_with_ranks}

## Task
For each retrieved chunk, determine if it is relevant to solving or understanding 
this specific exercise (YES/NO). A chunk is relevant if it teaches a concept, 
technique, or provides an example directly applicable to this exercise.

Then compute Context Precision@K using the formula:
  precision@k = (1/K) × Σ (precision_at_i × relevance_i)
  where precision_at_i = (relevant chunks up to rank i) / i

Respond ONLY with a JSON object (no markdown, no extra text):
{{"chunks": [{{"rank": 1, "relevant": true/false, "reason": "brief"}}, ...], "score": <float 0.0-1.0>}}
""")

# ---------------------------------------------------------------------------
# Answer Generation (simulate CellMate Pre-study Guide)
# ---------------------------------------------------------------------------

PRESTUDY_TEMPLATE = textwrap.dedent("""\
# Role
You are an expert Python academic tutor responsible for distilling prerequisite knowledge from lecture materials before students attempt an exercise.

# Exercise Context
- Exercise ID: {exercise_id}
- Exercise Title: {title}
- Problem Description: {description}

# Retrieved Course Lecture Materials
{rag_context}

# Task
Based on the retrieved course lecture materials above, write a structured, easy-to-read "Pre-study Knowledge Guide" tailored to help the student understand the prerequisite concepts needed for this exercise.

# Strict Grounding & Quality Requirements
1. **Strict Context Grounding**: Every concept, syntax pattern, and common pitfall you describe MUST be directly grounded in and verifiable from the provided lecture materials above. Prefer terminology, function names, and code structures taught in the course materials.
2. **Pedagogical Alignment**:
   - For Beginners: Use clear explanations and relate ideas to simple mechanics introduced in the lectures.
   - For Advanced students: Explain the underlying algorithmic logic directly.
3. **No Solution Spoilers**: NEVER provide the complete code solution to the current exercise. Give guidance, conceptual building blocks, and syntax examples only.
4. **Structure**: Highlight exactly 3 Core Concepts and 2 Common Pitfalls derived from the lecture topics.
5. **Length**: Keep under 300 words.

## Output Format
## 📖 Pre-study Guide: {title}
### 🔑 Core Concepts
1. **[Concept 1 from lecture]** — [Explanation grounded in course materials]
2. **[Concept 2 from lecture]** — [Explanation grounded in course materials]
3. **[Concept 3 from lecture]** — [Explanation grounded in course materials]
### ⚠️ Common Pitfalls
1. **[Pitfall 1]** — [Common mistake and how to avoid it based on lecture warnings]
2. **[Pitfall 2]** — [Common mistake and how to avoid it based on lecture warnings]
### 💡 Quick Tip
[One actionable, grounded sentence summarizing the best coding practice for this topic]
""")

FEEDBACK_TEMPLATE = textwrap.dedent("""\
You are a Python teaching assistant for programming beginners. Given the uploaded code and hidden test results, offer concise code suggestions on improvement and fixing output errors without directly giving solutions. Be encouraging and constructive in your feedback.

**Problem description**
{description}

**Code**
```python
{student_code}
```

**Hidden-test analysis**
{test_analysis}

### Course Materials
Here are some relevant course materials that might help the student:
{rag_context}

### Grounding & Pedagogical Rules
1. **Course Grounding**: When suggesting conceptual fixes or terminology, align directly with the Course Materials provided above. If the lecture introduces a specific syntax, method, or idiom (e.g. while loops, accumulator patterns, list methods), refer to that style.
2. **Classify the submission**: BROKEN, FAILING, IMPROPER, or EXCELLENT
3. Provide a concise hint (≤80 words) pointing the student in the right direction.
4. Do NOT reveal hidden-test data or provide full code solutions.
""")

# ---------------------------------------------------------------------------
# Concept Extraction per Exercise (Ground Truth for Context Recall)
# ---------------------------------------------------------------------------

EXERCISE_CONCEPTS = {
    "ex1_7_gaussian": ["mathematical formulas", "function definition", "math module (exp, sqrt, pi)"],
    "ex1_9_period": ["Kepler's third law", "mathematical formula", "exponentiation"],
    "ex1_11_num_digits": ["while loop", "integer division", "counting iterations"],
    "ex1_13_odd_numbers": ["while loop", "modulo operator", "list append"],
    "ex1_14_even_numbers": ["for loop", "range function", "list construction"],
    "ex1_15_my_sum": ["for loop", "accumulator pattern", "iterating over lists"],
    "ex1_16_distance": ["list construction", "physics formula", "for loop with range"],
    "ex1_17_my_cumsum": ["cumulative sum", "list operations", "running total pattern"],
    "ex1_18_compute_heights": ["while loop", "list append", "physics/bouncing ball"],
    "ex1_19_calculate_pi": ["series approximation", "for loop", "alternating sum"],
    "ex2_1_mult": ["function definition", "multiplication", "return values"],
    "ex2_3_heaviside": ["conditional expressions", "piecewise function", "if/elif/else"],
    "ex2_4_my_factorial": ["recursion or loop", "factorial definition", "function design"],
    "ex2_5_path_length": ["list iteration", "distance formula", "sqrt function"],
    "ex2_6_approx_pi": ["series approximation", "convergence", "while loop"],
    "ex2_7_prime_list": ["prime number check", "nested loops", "list comprehension"],
    "ex2_8_h": ["Gaussian function", "math operations", "function composition"],
    "ex2_9_w_wbits": ["bitwise operations", "binary representation", "while loop"],
    "ex2_10_multiply": ["nested loops", "multiplication without operator", "accumulation"],
    "ex2_11_f_cubic": ["polynomial function", "function definition", "return values"],
    "ex2_12_f_mult": ["function as argument", "higher-order functions", "function composition"],
    "ex2_13_odd_bits": ["bitwise operations", "binary manipulation", "loop with shifts"],
    "ex3_4_displacement": ["numpy arrays", "vectorized operations", "physics formula"],
    "ex3_5_my_factorial": ["recursion", "factorial", "base case"],
    "ex3_6_wave_speed": ["formula implementation", "square root", "function parameters"],
    "ex3_8_read_temp_density": ["file I/O", "string parsing", "data extraction"],
    "ex3_9_compute_velocity": ["numerical differentiation", "arrays", "finite differences"],
    "ex4_1_read_constants": ["file reading", "dictionary construction", "string splitting"],
    "ex4_2_reverse_dict": ["dictionary operations", "key-value swap", "dict comprehension"],
    "ex4_3_triangle_area": ["geometry formula", "function definition", "math operations"],
    "ex4_4_read_densities": ["file I/O", "dictionary", "data parsing"],
    "ex4_5_class_F": ["class definition", "methods", "object-oriented programming"],
    "ex4_6_simple_class": ["class definition", "__init__", "instance methods"],
    "ex4_7_account_transactions": ["class design", "methods", "state management"],
    "ex4_8_line_class": ["class definition", "mathematical operations", "method implementation"],
    "ex4_9_quadratic_class": ["class definition", "quadratic formula", "methods"],
}

# ---------------------------------------------------------------------------
# Parse LLM JSON responses safely
# ---------------------------------------------------------------------------

def parse_llm_json(text: str) -> dict:
    """Extract JSON from LLM response, handling markdown code fences."""
    # Strip markdown code fences if present
    text = text.strip()
    if text.startswith("```"):
        # Remove first line (```json or ```) and last line (```)
        lines = text.split("\n")
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # Try to find JSON object in text
        match = re.search(r'\{.*\}', text, re.DOTALL)
        if match:
            try:
                return json.loads(match.group())
            except json.JSONDecodeError:
                pass
        return {"score": 0.0, "error": "Failed to parse LLM response"}


# ---------------------------------------------------------------------------
# Main RAGAs Evaluation
# ---------------------------------------------------------------------------

def run_ragas_evaluation(api_url: str, api_key: str, model: str, sample_size: int = 0):
    """Run full RAGAs evaluation across all retrieval engines."""
    repo_path = '/Users/zq425/Desktop/promptfolio'
    if not os.path.exists(repo_path):
        repo_path = '/tmp/promptfolio_repo'
    knowledge_dir = os.path.join(repo_path, 'knowledge')

    print("=" * 70)
    print("CellMate RAGAs: LLM-as-a-Judge Evaluation")
    print(f"Model: {model}")
    print(f"API: {api_url}")
    print("=" * 70)

    # 1. Load knowledge base and embeddings
    print("\n[1/5] Loading knowledge base...")
    chunks = load_knowledge_base(knowledge_dir)
    print(f"  → {len(chunks)} chunks loaded")

    from sentence_transformers import SentenceTransformer
    print("[2/5] Loading embedding model...")
    emb_model = SentenceTransformer('all-MiniLM-L6-v2')
    chunk_texts = [f"{c.title}\n{c.content}" for c in chunks]
    chunk_embs = emb_model.encode(chunk_texts, show_progress_bar=False, normalize_embeddings=True)
    for i, c in enumerate(chunks):
        c.embedding = chunk_embs[i]

    # 2. Load benchmark queries
    print("[3/5] Loading benchmark queries...")
    all_queries = load_benchmark_queries(repo_path)
    if sample_size > 0 and sample_size < len(all_queries):
        # Deterministic sampling across all lecture prefixes
        import random
        random.seed(42)
        all_queries = random.sample(all_queries, sample_size)
    print(f"  → {len(all_queries)} exercises to evaluate")

    # 3. Define retrieval engines to evaluate
    engines = {
        "BM25-lite (Keyword)": lambda query: bm25_lite_retrieve(query, chunks, top_k=3),
        "Dense Embedding (ChromaDB)": lambda query: dense_retrieve(
            emb_model.encode([query], normalize_embeddings=True)[0],
            chunks, chunk_embs, top_k=3
        ),
        "Hybrid (BM25 + Dense RRF)": lambda query: hybrid_rrf_retrieve(
            bm25_lite_retrieve(query, chunks, top_k=10),
            dense_retrieve(
                emb_model.encode([query], normalize_embeddings=True)[0],
                chunks, chunk_embs, top_k=10
            ),
            k=60, top_k=3
        ),
    }

