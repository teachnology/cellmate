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

