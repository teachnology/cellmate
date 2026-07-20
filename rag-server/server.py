"""
CellMate RAG Server — ChromaDB + SentenceTransformers backend.

A standalone FastAPI service that handles embedding generation and
vector search for the CellMate VS Code extension.

Endpoints:
  GET  /health  — Health check, returns status + indexed document count
  POST /index   — Accept chunks, embed and upsert into ChromaDB
  POST /query   — Accept query text, return top-K relevant chunks
"""

import os
from typing import Optional
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import chromadb
from sentence_transformers import SentenceTransformer

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
CHROMA_PERSIST_DIR = os.path.join(os.path.dirname(__file__), "chroma_data")
COLLECTION_NAME = "cellmate_knowledge"
EMBEDDING_MODEL = os.environ.get("EMBEDDING_MODEL", "all-MiniLM-L6-v2")

# ---------------------------------------------------------------------------
# Initialisation
# ---------------------------------------------------------------------------
app = FastAPI(title="CellMate RAG Server", version="1.0.0")

# Allow requests from VS Code extension (localhost)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Load the embedding model once at startup
print(f"Loading embedding model: {EMBEDDING_MODEL} ...")
model = SentenceTransformer(EMBEDDING_MODEL)
print("Embedding model loaded.")

# Initialise ChromaDB with persistent storage
chroma_client = chromadb.PersistentClient(path=CHROMA_PERSIST_DIR)
collection = chroma_client.get_or_create_collection(
    name=COLLECTION_NAME,
    metadata={"hnsw:space": "cosine"},  # use cosine similarity
)

