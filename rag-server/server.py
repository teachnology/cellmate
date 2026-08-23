"""
CellMate RAG Server — ChromaDB + SentenceTransformers backend.

A standalone FastAPI service that handles embedding generation and
vector search for the CellMate VS Code extension.

Endpoints:
  GET  /health  — Health check, returns status + indexed document count
  POST /index   — Accept chunks, embed and upsert into ChromaDB
  POST /query   — Accept query text, return top-K relevant chunks
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import threading
from config import chroma_client, collection as _collection, get_model, COLLECTION_NAME, EMBEDDING_MODEL

# Mutable reference so /index reset can reassign
collection = _collection

# Lock to protect collection during reset (prevents query-during-reset race)
_index_lock = threading.Lock()

# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------
app = FastAPI(title="CellMate RAG Server", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------
class ChunkInput(BaseModel):
    id: str
    source: str
    title: str
    content: str
class IndexRequest(BaseModel):
    chunks: list[ChunkInput]
    reset: bool = False
class IndexResponse(BaseModel):
    indexed: int
    total: int
class QueryRequest(BaseModel):
    query: str
    top_k: int = 3
    filter_exercises: bool = False
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
    """Accept knowledge chunks, embed and upsert into ChromaDB."""
    global collection
    model = get_model()
    with _index_lock:
        if req.reset:
            chroma_client.delete_collection(COLLECTION_NAME)
            collection = chroma_client.get_or_create_collection(
                name=COLLECTION_NAME,
                metadata={"hnsw:space": "cosine"},
            )
        if not req.chunks:
            return IndexResponse(indexed=0, total=collection.count())
        ids = [c.id for c in req.chunks]
        # Embed title + content together for consistency with ragUtils.ts and benchmark
        documents = [f"{c.title}\n{c.content}" for c in req.chunks]
        metadatas = [{"source": c.source, "title": c.title} for c in req.chunks]
        # Store original content (without title prefix) as the document text
        raw_documents = [c.content for c in req.chunks]
        embeddings = model.encode(documents, show_progress_bar=False).tolist()
        BATCH_SIZE = 100
        for i in range(0, len(ids), BATCH_SIZE):
            end = min(i + BATCH_SIZE, len(ids))
            collection.upsert(
                ids=ids[i:end],
                embeddings=embeddings[i:end],
                documents=raw_documents[i:end],
                metadatas=metadatas[i:end],
            )
    return IndexResponse(indexed=len(ids), total=collection.count())

@app.post("/query", response_model=QueryResponse)
def query_chunks(req: QueryRequest):
    """Accept a query string, embed it, return top-K similar chunks."""
    import re
    model = get_model()
    if collection.count() == 0:
        return QueryResponse(results=[])
    query_embedding = model.encode([req.query], show_progress_bar=False).tolist()
    
    # If filtering exercises, query more chunks so we have enough after filtering
    fetch_k = min(req.top_k * 4 if req.filter_exercises else req.top_k, collection.count())
    results = collection.query(
        query_embeddings=query_embedding,
        n_results=fetch_k,
        include=["documents", "metadatas", "distances"],
    )
    query_results: list[QueryResult] = []
    exercise_pattern = re.compile(r'^Exercise\s+\d', re.IGNORECASE)

    if results and results["ids"] and results["ids"][0]:
        for i in range(len(results["ids"][0])):
            title = results["metadatas"][0][i].get("title", "")
            if req.filter_exercises and exercise_pattern.match(title):
                continue
            distance = results["distances"][0][i] if results["distances"] else 0
            similarity = 1.0 - distance
            query_results.append(QueryResult(
                source=results["metadatas"][0][i].get("source", ""),
                title=title,
                content=results["documents"][0][i] if results["documents"] else "",
                score=round(similarity, 4),
            ))
            if len(query_results) >= req.top_k:
                break
    return QueryResponse(results=query_results)

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8100)
