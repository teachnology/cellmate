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


