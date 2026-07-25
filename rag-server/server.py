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
from config import chroma_client, collection as _collection, model, COLLECTION_NAME, EMBEDDING_MODEL

# Mutable reference so /index reset can reassign
collection = _collection

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
    if req.reset:
        chroma_client.delete_collection(COLLECTION_NAME)
        collection = chroma_client.get_or_create_collection(
            name=COLLECTION_NAME,
            metadata={"hnsw:space": "cosine"},
        )
    if not req.chunks:
        return IndexResponse(indexed=0, total=collection.count())
    ids = [c.id for c in req.chunks]
    documents = [c.content for c in req.chunks]
    metadatas = [{"source": c.source, "title": c.title} for c in req.chunks]
    embeddings = model.encode(documents, show_progress_bar=False).tolist()
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
    """Accept a query string, embed it, return top-K similar chunks."""
    if collection.count() == 0:
        return QueryResponse(results=[])
    query_embedding = model.encode([req.query], show_progress_bar=False).tolist()
    results = collection.query(
        query_embeddings=query_embedding,
        n_results=min(req.top_k, collection.count()),
        include=["documents", "metadatas", "distances"],
    )
    query_results: list[QueryResult] = []
    if results and results["ids"] and results["ids"][0]:
        for i in range(len(results["ids"][0])):
            distance = results["distances"][0][i] if results["distances"] else 0
            similarity = 1.0 - distance
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
