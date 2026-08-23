"""
Shared configuration and initialisation for the CellMate RAG server.
Both server.py (FastAPI) and app.py (Streamlit) import from here
to share the same ChromaDB client and embedding model.
"""

import os
import chromadb
from sentence_transformers import SentenceTransformer

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
CHROMA_PERSIST_DIR = os.path.join(os.path.dirname(__file__), "chroma_data")
COLLECTION_NAME = "cellmate_knowledge"
EMBEDDING_MODEL = os.environ.get("EMBEDDING_MODEL", "all-MiniLM-L6-v2")

# ---------------------------------------------------------------------------
# Singletons (lazy-loaded to avoid blocking startup)
# ---------------------------------------------------------------------------
_model = None

def get_model() -> SentenceTransformer:
    """Lazily load the embedding model on first use."""
    global _model
    if _model is None:
        print(f"[config] Loading embedding model: {EMBEDDING_MODEL} ...")
        _model = SentenceTransformer(EMBEDDING_MODEL)
        print("[config] Embedding model loaded.")
    return _model

import shutil

def init_chroma():
    global chroma_client
    chroma_client = chromadb.PersistentClient(path=CHROMA_PERSIST_DIR)
    try:
        return chroma_client.get_or_create_collection(
            name=COLLECTION_NAME,
            metadata={"hnsw:space": "cosine"},
        )
    except Exception as e:
        print(f"[config] ChromaDB schema incompatibility detected ({e}). Resetting chroma_data...")
        try:
            if os.path.exists(CHROMA_PERSIST_DIR):
                shutil.rmtree(CHROMA_PERSIST_DIR, ignore_errors=True)
            os.makedirs(CHROMA_PERSIST_DIR, exist_ok=True)
        except Exception:
            pass
        chroma_client = chromadb.PersistentClient(path=CHROMA_PERSIST_DIR)
        return chroma_client.get_or_create_collection(
            name=COLLECTION_NAME,
            metadata={"hnsw:space": "cosine"},
        )

collection = init_chroma()

