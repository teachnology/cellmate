"""
CellMate Knowledge Base — Streamlit UI

Two pages:
  1. Upload: Upload files → split → MD5 dedup → index into ChromaDB
  2. Chat:   RAG chat with LangChain (Retrieval → Prompt → LLM → Stream)

Run:  streamlit run app.py
"""

import os
import hashlib
import streamlit as st
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_openai import ChatOpenAI
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_core.messages import HumanMessage, AIMessage
from langchain_core.output_parsers import StrOutputParser

from config import chroma_client, collection, model, COLLECTION_NAME, EMBEDDING_MODEL

# ---------------------------------------------------------------------------
# Page config
# ---------------------------------------------------------------------------
st.set_page_config(
    page_title="CellMate Knowledge Base",
    page_icon="📚",
    layout="wide",
)

# ---------------------------------------------------------------------------
# Sidebar — Navigation + LLM config
# ---------------------------------------------------------------------------
st.sidebar.title("📚 CellMate KB")
page = st.sidebar.radio("Navigate", ["Upload", "Chat"], label_visibility="collapsed")

st.sidebar.markdown("---")
st.sidebar.subheader("LLM Configuration")
llm_api_url = st.sidebar.text_input(
    "API Base URL",
    value=os.environ.get("LLM_API_URL", "https://api.openai.com/v1"),
)
llm_api_key = st.sidebar.text_input(
    "API Key",
    value=os.environ.get("LLM_API_KEY", ""),
    type="password",
)
llm_model = st.sidebar.text_input(
    "Model",
    value=os.environ.get("LLM_MODEL", "gpt-4o-mini"),
)

st.sidebar.markdown("---")
st.sidebar.caption(f"Embedding: `{EMBEDDING_MODEL}`")
st.sidebar.caption(f"Documents in KB: **{collection.count()}**")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def md5(text: str) -> str:
    """Compute MD5 hash of text content for dedup."""
    return hashlib.md5(text.encode("utf-8")).hexdigest()


def read_file_content(uploaded_file) -> str:
    """Read text content from an uploaded file."""
    name = uploaded_file.name
    raw = uploaded_file.read()

    if name.endswith(".ipynb"):
        import json
        try:
            nb = json.loads(raw.decode("utf-8"))
            parts = []
            for cell in nb.get("cells", []):
                src = cell.get("source", [])
                text = "".join(src) if isinstance(src, list) else src
                if text.strip():
                    parts.append(text)
            return "\n\n".join(parts)
        except Exception:
            return raw.decode("utf-8", errors="replace")
    else:
        return raw.decode("utf-8", errors="replace")


def get_existing_ids() -> set:
    """Get all existing chunk IDs from ChromaDB."""
    if collection.count() == 0:
        return set()
    result = collection.get(include=[])
    return set(result["ids"])


# ---------------------------------------------------------------------------
# Page 1: Upload
# ---------------------------------------------------------------------------
def page_upload():
    st.header("📤 Knowledge Base Upload")
    st.markdown("Upload course materials to build the knowledge base. "
                "Files are automatically split, deduplicated (MD5), and indexed into ChromaDB.")

    # File uploader
    uploaded_files = st.file_uploader(
        "Upload files",
        type=["md", "py", "txt", "ipynb"],
        accept_multiple_files=True,
    )

    # Splitter config
    col1, col2 = st.columns(2)
    with col1:
        chunk_size = st.number_input("Chunk size", value=500, min_value=100, max_value=2000, step=100)
    with col2:
        chunk_overlap = st.number_input("Chunk overlap", value=50, min_value=0, max_value=500, step=10)

    if uploaded_files and st.button("🚀 Index Files", type="primary"):
        splitter = RecursiveCharacterTextSplitter(
            chunk_size=chunk_size,
            chunk_overlap=chunk_overlap,
        )
        existing_ids = get_existing_ids()

        total_chunks = 0
        new_chunks = 0
        skipped_chunks = 0

        progress = st.progress(0, text="Processing files...")

        for idx, uploaded_file in enumerate(uploaded_files):
            content = read_file_content(uploaded_file)
            if not content.strip():
                continue

            # Split into chunks
            docs = splitter.create_documents(
                [content],
                metadatas=[{"source": uploaded_file.name}],
            )

            ids_batch = []
            docs_batch = []
            metas_batch = []

            for doc in docs:
                chunk_id = md5(doc.page_content)
                total_chunks += 1

                if chunk_id in existing_ids:
                    skipped_chunks += 1
                    continue

                ids_batch.append(chunk_id)
                docs_batch.append(doc.page_content)
                metas_batch.append({
                    "source": uploaded_file.name,
                    "title": f"{uploaded_file.name} (chunk)",
                })
                existing_ids.add(chunk_id)
                new_chunks += 1

            # Embed and upsert new chunks
            if ids_batch:
                embeddings = model.encode(docs_batch, show_progress_bar=False).tolist()
                collection.upsert(
                    ids=ids_batch,
                    embeddings=embeddings,
                    documents=docs_batch,
                    metadatas=metas_batch,
                )

            progress.progress((idx + 1) / len(uploaded_files),
                              text=f"Processing {uploaded_file.name}...")

        progress.empty()

        # Results
        st.success(f"Done! Processed **{total_chunks}** chunks from **{len(uploaded_files)}** files.")
        col1, col2, col3 = st.columns(3)
        col1.metric("New chunks indexed", new_chunks)
        col2.metric("Duplicates skipped", skipped_chunks)
        col3.metric("Total in KB", collection.count())

    # Current collection stats
    st.markdown("---")
    st.subheader("📊 Current Knowledge Base")
    doc_count = collection.count()
    st.info(f"Total documents in ChromaDB: **{doc_count}**")

    if doc_count > 0 and st.button("🔍 Preview (first 10 chunks)"):
        preview = collection.peek(limit=10)
        for i, doc_id in enumerate(preview["ids"]):
            meta = preview["metadatas"][i] if preview["metadatas"] else {}
            content = preview["documents"][i] if preview["documents"] else ""
            with st.expander(f"**{meta.get('source', 'unknown')}** — {doc_id[:12]}..."):
                st.code(content[:500], language="text")



