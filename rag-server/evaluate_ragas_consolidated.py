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
import re
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
    bm25_lite_retrieve, dense_retrieve, hybrid_rrf_retrieve,
    filter_teaching_chunks
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
    
    # Auto-append /chat/completions for OpenAI compatible endpoints if missing
    if not is_ollama and not api_url.endswith("/chat/completions"):
        api_url = api_url.rstrip("/") + "/chat/completions"
        
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
            resp = requests.post(api_url, json=body, headers=headers, timeout=180)
            resp.raise_for_status()
            data = resp.json()
            if is_ollama:
                raw = data.get("response", "").strip()
            else:
                raw = data["choices"][0]["message"]["content"].strip()
            # Strip Qwen3 thinking tags if present
            raw = re.sub(r'<think>.*?</think>', '', raw, flags=re.DOTALL).strip()
            return raw
        except Exception as e:
            if attempt == 2:
                print(f"  [LLM ERROR after 3 attempts] {e}", flush=True)
                return ""
            print(f"  [LLM RETRY {attempt+1}/3: {type(e).__name__}]", flush=True)
            time.sleep(2 ** attempt)
    return ""


# ---------------------------------------------------------------------------
# RAGAs Consolidated Metric Prompt (LLM-as-a-Judge)
# ---------------------------------------------------------------------------

RAGAS_COMBINED_JUDGE_PROMPT = textwrap.dedent("""\
You are an expert academic evaluator performing RAGAs evaluation on an AI programming tutor.

## Exercise Information
- Exercise ID: {exercise_id}
- Title: {title}
- Description: {description}
- Key concepts needed: {concepts}

## Retrieved Course Context (Top-K Chunks in rank order 1..N)
{chunks_with_ranks}

## Question / Problem Input
{question}

## AI Generated Answer
{answer}

## Evaluation Tasks & Metrics
1. **Faithfulness** (0.0 to 1.0): What fraction of factual statements in the AI answer are grounded in and verifiable from the retrieved course context? (1.0 = fully grounded, 0.0 = completely ungrounded/hallucinated).
2. **Answer Relevancy** (0.0 to 1.0): How relevant and helpful is the AI answer to the student's question and exercise requirements? (1.0 = highly relevant, 0.0 = irrelevant).
3. **Context Recall** (0.0 to 1.0): Does the retrieved course context cover the essential key concepts needed for this exercise? (1.0 = all concepts covered, 0.0 = none covered).
4. **Context Precision** (0.0 to 1.0): Are the retrieved chunks relevant to the exercise, and are more relevant chunks placed at higher ranks? (1.0 = perfect ranking, 0.0 = irrelevant).

Respond ONLY with a valid JSON object in this exact format (no markdown, no extra commentary):
{{"faithfulness": <float 0.0-1.0>, "answer_relevancy": <float 0.0-1.0>, "context_recall": <float 0.0-1.0>, "context_precision": <float 0.0-1.0>, "reasoning": "brief 1-sentence explanation"}}
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
    """Extract JSON from LLM response, handling markdown code fences and thinking tags."""
    if not text or not text.strip():
        return {"score": 0.0, "error": "Empty LLM response"}
    # Strip Qwen3 thinking tags if present
    text = re.sub(r'<think>.*?</think>', '', text, flags=re.DOTALL).strip()
    # Strip markdown code fences if present
    if text.startswith("```"):
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


def safe_float(value, default: float = 0.0) -> float:
    """Safely convert a value to float, returning default on failure."""
    try:
        v = float(value)
        return max(0.0, min(1.0, v))  # Clamp to [0, 1]
    except (TypeError, ValueError):
        return default


