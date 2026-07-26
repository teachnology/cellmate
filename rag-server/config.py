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
# Singletons (loaded once per process)
# ---------------------------------------------------------------------------
print(f"[config] Loading embedding model: {EMBEDDING_MODEL} ...")
model = SentenceTransformer(EMBEDDING_MODEL)
print("[config] Embedding model loaded.")

chroma_client = chromadb.PersistentClient(path=CHROMA_PERSIST_DIR)
collection = chroma_client.get_or_create_collection(
    name=COLLECTION_NAME,
    metadata={"hnsw:space": "cosine"},
)
