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

