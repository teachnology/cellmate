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

# ---------------------------------------------------------------------------
# Request / Response schemas
# ---------------------------------------------------------------------------

class ChunkInput(BaseModel):
    id: str
    source: str
    title: str
    content: str
class IndexRequest(BaseModel):
    chunks: list[ChunkInput]
    # If true, clear the existing collection before indexing
    reset: bool = False
class IndexResponse(BaseModel):
    indexed: int
    total: int
class QueryRequest(BaseModel):
    query: str
    top_k: int = 3
class QueryResult(BaseModel):
    source: str
    title: str
    content: str
    score: float
class QueryResponse(BaseModel):
    results: list[QueryResult]
class HealthResponse(BaseModel):
    status: str
    model: str
    documents: int

# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/health", response_model=HealthResponse)
def health():
    """Health check — returns status, model name, and indexed document count."""
    return HealthResponse(
        status="ok",
        model=EMBEDDING_MODEL,
        documents=collection.count(),
    )

@app.post("/index", response_model=IndexResponse)
def index_chunks(req: IndexRequest):
    """
    Accept knowledge chunks, embed them with SentenceTransformers,
    and upsert into ChromaDB.
    """
    if req.reset:
        # Drop and recreate the collection
        chroma_client.delete_collection(COLLECTION_NAME)
        global collection
        collection = chroma_client.get_or_create_collection(
            name=COLLECTION_NAME,
            metadata={"hnsw:space": "cosine"},
        )
    if not req.chunks:
        return IndexResponse(indexed=0, total=collection.count())
    # Prepare data for ChromaDB
    ids = [c.id for c in req.chunks]
    documents = [c.content for c in req.chunks]
    metadatas = [{"source": c.source, "title": c.title} for c in req.chunks]
    # Generate embeddings
    embeddings = model.encode(documents, show_progress_bar=False).tolist()
    # Upsert into ChromaDB (idempotent — same IDs overwrite)
    BATCH_SIZE = 100
    for i in range(0, len(ids), BATCH_SIZE):
        end = min(i + BATCH_SIZE, len(ids))
        collection.upsert(
            ids=ids[i:end],
            embeddings=embeddings[i:end],
            documents=documents[i:end],
            metadatas=metadatas[i:end],
        )
    return IndexResponse(indexed=len(ids), total=collection.count())

@app.post("/query", response_model=QueryResponse)
def query_chunks(req: QueryRequest):
    """
    Accept a query string, embed it, and return the top-K most similar
    chunks from ChromaDB.
    """
    if collection.count() == 0:
        return QueryResponse(results=[])
    # Embed the query
    query_embedding = model.encode([req.query], show_progress_bar=False).tolist()
    # Query ChromaDB
    results = collection.query(
        query_embeddings=query_embedding,
        n_results=min(req.top_k, collection.count()),
        include=["documents", "metadatas", "distances"],
    )
    # Format results
    query_results: list[QueryResult] = []
    if results and results["ids"] and results["ids"][0]:
        for i in range(len(results["ids"][0])):
            # ChromaDB returns cosine distance; convert to similarity
            distance = results["distances"][0][i] if results["distances"] else 0
            similarity = 1.0 - distance  # cosine distance → cosine similarity
            query_results.append(QueryResult(
                source=results["metadatas"][0][i].get("source", ""),
                title=results["metadatas"][0][i].get("title", ""),
                content=results["documents"][0][i] if results["documents"] else "",
                score=round(similarity, 4),
            ))
    return QueryResponse(results=query_results)

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8100)
