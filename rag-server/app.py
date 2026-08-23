"""
CellMate Knowledge Base — Streamlit UI

Two pages:
  1. Upload: Upload files → split → MD5 dedup → index into ChromaDB
  2. Chat:   RAG chat with LangChain (Retrieval → Prompt → LLM → Stream)

Run:  streamlit run app.py
"""

import os
import re
import json
import hashlib
import datetime
import streamlit as st
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_openai import ChatOpenAI
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_core.messages import HumanMessage, AIMessage
from langchain_core.output_parsers import StrOutputParser

from config import chroma_client, collection, get_model, COLLECTION_NAME, EMBEDDING_MODEL

# ---------------------------------------------------------------------------
# Page config
# ---------------------------------------------------------------------------
st.set_page_config(
    page_title="CellMate Knowledge Base",
    page_icon="📚",
    layout="wide",
)

# ---------------------------------------------------------------------------
# Auto-config: read defaults from CELLMATE_* env vars → .vscode/settings.json
# ---------------------------------------------------------------------------
def _load_default_config() -> dict:
    """Load LLM config from environment variables or .vscode/settings.json.

    Priority: CELLMATE_* env vars → LLM_* env vars → .vscode/settings.json → empty.
    """
    cfg = {"api_url": "", "api_key": "", "model": ""}

    # 1. Environment variables (highest priority)
    cfg["api_url"] = os.environ.get("CELLMATE_API_URL") or os.environ.get("LLM_API_URL", "")
    cfg["api_key"] = os.environ.get("CELLMATE_API_KEY") or os.environ.get("LLM_API_KEY", "")
    cfg["model"] = os.environ.get("CELLMATE_MODEL") or os.environ.get("LLM_MODEL", "")

    # 2. Fallback: read from .vscode/settings.json (CellMate.* keys)
    vscode_settings_path = os.path.join(os.path.dirname(__file__), "..", ".vscode", "settings.json")
    if os.path.exists(vscode_settings_path):
        try:
            with open(vscode_settings_path, "r", encoding="utf-8") as f:
                settings = json.load(f)
            cfg["api_url"] = cfg["api_url"] or settings.get("CellMate.apiUrl", "")
            cfg["api_key"] = cfg["api_key"] or settings.get("CellMate.apiKey", "")
            cfg["model"] = cfg["model"] or settings.get("CellMate.modelName", "")
        except Exception:
            pass

    return cfg


_defaults = _load_default_config()

# ---------------------------------------------------------------------------
# Sidebar — Navigation + LLM config
# ---------------------------------------------------------------------------
st.sidebar.title("📚 CellMate KB")
page = st.sidebar.radio("Navigate", ["Upload", "Chat"], label_visibility="collapsed")

st.sidebar.markdown("---")
st.sidebar.subheader("🔧 LLM Configuration")
llm_api_url = st.sidebar.text_input(
    "API Base URL",
    value=_defaults["api_url"],
    placeholder="https://chat.ese.ic.ac.uk/api/generate",
)
llm_api_key = st.sidebar.text_input(
    "API Key",
    value=_defaults["api_key"],
    type="password",
    placeholder="your-api-key",
)
llm_model = st.sidebar.text_input(
    "Model",
    value=_defaults["model"] or "gpt-oss:120b",
    placeholder="gpt-oss:120b",
)

st.sidebar.markdown("---")
st.sidebar.caption(f"Embedding model: `{EMBEDDING_MODEL}`")
st.sidebar.caption(f"Chunks in KB: **{collection.count()}**")

# ---------------------------------------------------------------------------
# Prompt templates for Chat
# ---------------------------------------------------------------------------
PROMPT_TEMPLATES = {
    "Teaching Assistant": (
        "You are a helpful Python teaching assistant. "
        "Answer the student's question based on the following course materials. "
        "If the materials don't contain relevant information, say so honestly.\n\n"
        "Course Materials:\n{context}"
    ),
    "Socratic Tutor": (
        "You are a Socratic Python tutor. Instead of giving direct answers, "
        "guide the student to discover the solution themselves through questions and hints. "
        "Use the course materials below as your knowledge base, but never reveal code solutions directly.\n\n"
        "Course Materials:\n{context}"
    ),
    "Exam Revision Helper": (
        "You are an exam revision assistant for a Python programming course. "
        "Summarise key concepts, highlight common mistakes, and provide concise revision notes "
        "based on the course materials below.\n\n"
        "Course Materials:\n{context}"
    ),
}


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
        try:
            nb = json.loads(raw.decode("utf-8"))
            parts = []
            for cell in nb.get("cells", []):
                src = cell.get("source", [])
                text = "".join(src) if isinstance(src, list) else src
                if text.strip():
                    parts.append(text)
            return "\n\n".join(parts)
        except Exception as e:
            st.warning(f"⚠️ Failed to parse notebook `{name}`: {e}")
            return raw.decode("utf-8", errors="replace")
    else:
        return raw.decode("utf-8", errors="replace")


def get_existing_ids() -> set:
    """Get all existing chunk IDs from ChromaDB."""
    if collection.count() == 0:
        return set()
    result = collection.get(include=[])
    return set(result["ids"])


def _extract_section_title(text: str, fallback: str) -> str:
    """Extract the nearest ## heading from a chunk's text, or use fallback."""
    match = re.search(r'^##\s+(.+)$', text, re.MULTILINE)
    return match.group(1).strip() if match else fallback


def _get_indexed_file_stats() -> dict:
    """Return {source_filename: chunk_count} from the current collection."""
    doc_count = collection.count()
    if doc_count == 0:
        return {}
    # Fetch all metadatas (ChromaDB get() returns everything when no IDs specified)
    all_data = collection.get(include=["metadatas"])
    stats = {}
    for meta in all_data["metadatas"]:
        src = meta.get("source", "unknown")
        stats[src] = stats.get(src, 0) + 1
    return stats


def _delete_chunks_by_source(source_name: str):
    """Delete all chunks belonging to a specific source file."""
    all_data = collection.get(include=["metadatas"])
    ids_to_delete = []
    for i, meta in enumerate(all_data["metadatas"]):
        if meta.get("source") == source_name:
            ids_to_delete.append(all_data["ids"][i])
    if ids_to_delete:
        collection.delete(ids=ids_to_delete)


def _export_conversation_md(messages: list) -> str:
    """Export conversation history as a Markdown string."""
    lines = [
        f"# CellMate KB Chat Export",
        f"*Exported at {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}*\n",
    ]
    for msg in messages:
        role = " Student" if msg["role"] == "user" else " Assistant"
        lines.append(f"### {role}\n")
        lines.append(msg["content"])
        if msg.get("sources"):
            lines.append(f"\n<details><summary>📎 Retrieved sources</summary>\n\n{msg['sources']}\n</details>")
        lines.append("")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Page 1: Upload & Knowledge Base Management
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
        model = get_model()
        existing_ids = get_existing_ids()

        total_chunks = 0
        new_chunks = 0
        skipped_chunks = 0
        errors = []

        progress = st.progress(0, text="Processing files...")

        for idx, uploaded_file in enumerate(uploaded_files):
            try:
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
                embed_batch = []
                metas_batch = []

                for doc in docs:
                    chunk_id = md5(doc.page_content)
                    total_chunks += 1

                    if chunk_id in existing_ids:
                        skipped_chunks += 1
                        continue

                    # Extract section title from ## heading if present
                    title = _extract_section_title(doc.page_content, uploaded_file.name)

                    ids_batch.append(chunk_id)
                    docs_batch.append(doc.page_content)
                    # Embed title + content together for better retrieval
                    embed_batch.append(f"{title}\n{doc.page_content}")
                    metas_batch.append({
                        "source": uploaded_file.name,
                        "title": title,
                    })
                    existing_ids.add(chunk_id)
                    new_chunks += 1

                # Embed and upsert new chunks
                if ids_batch:
                    embeddings = model.encode(embed_batch, show_progress_bar=False).tolist()
                    collection.upsert(
                        ids=ids_batch,
                        embeddings=embeddings,
                        documents=docs_batch,
                        metadatas=metas_batch,
                    )
            except Exception as e:
                errors.append(f"`{uploaded_file.name}`: {e}")

            progress.progress((idx + 1) / len(uploaded_files),
                              text=f"Processing {uploaded_file.name}...")

        progress.empty()

        # Results
        st.success(f"Done! Processed **{total_chunks}** chunks from **{len(uploaded_files)}** files.")
        col1, col2, col3 = st.columns(3)
        col1.metric("New chunks indexed", new_chunks)
        col2.metric("Duplicates skipped", skipped_chunks)
        col3.metric("Total in KB", collection.count())

        if errors:
            st.error("The following files had errors during processing:")
            for err in errors:
                st.markdown(f"- {err}")

    # -----------------------------------------------------------------------
    # Knowledge Base Management
    # -----------------------------------------------------------------------
    st.markdown("---")
    st.subheader("📊 Knowledge Base Management")

    doc_count = collection.count()
    st.info(f"Total chunks in ChromaDB: **{doc_count}**")

    if doc_count > 0:
        # File-level inventory
        file_stats = _get_indexed_file_stats()
        if file_stats:
            st.markdown("**Indexed files:**")
            for src, cnt in sorted(file_stats.items()):
                col_file, col_cnt, col_del = st.columns([5, 1, 1])
                col_file.markdown(f"`{src}`")
                col_cnt.markdown(f"**{cnt}** chunks")
                if col_del.button("🗑️", key=f"del_{src}", help=f"Delete all chunks from {src}"):
                    _delete_chunks_by_source(src)
                    st.success(f"Deleted all chunks from `{src}`.")
                    st.rerun()

        # Preview
        if st.button("🔍 Preview (first 10 chunks)"):
            preview = collection.peek(limit=10)
            for i, doc_id in enumerate(preview["ids"]):
                meta = preview["metadatas"][i] if preview["metadatas"] else {}
                content = preview["documents"][i] if preview["documents"] else ""
                with st.expander(f"**{meta.get('title', '?')}** — {meta.get('source', '?')} — {doc_id[:12]}..."):
                    st.code(content[:500], language="text")

        # Clear entire KB
        st.markdown("---")
        with st.expander("⚠️ Danger Zone"):
            st.warning("This will permanently delete all indexed documents from ChromaDB.")
            if st.button("🗑️ Clear Entire Knowledge Base", type="primary"):
                import config
                chroma_client.delete_collection(COLLECTION_NAME)
                config.collection = chroma_client.get_or_create_collection(
                    name=COLLECTION_NAME,
                    metadata={"hnsw:space": "cosine"},
                )
                st.success("Knowledge base cleared! All chunks have been deleted.")
                st.rerun()


# ---------------------------------------------------------------------------
# Page 2: Chat
# ---------------------------------------------------------------------------
def page_chat():
    st.header("💬 Knowledge Base Chat")
    st.markdown("Ask questions about your course materials. "
                "Answers are grounded in the knowledge base via RAG retrieval.")

    # Initialise session state
    if "messages" not in st.session_state:
        st.session_state.messages = []

    # Display chat history
    for msg in st.session_state.messages:
        with st.chat_message(msg["role"]):
            st.markdown(msg["content"])
            if msg.get("sources"):
                with st.expander("📎 Retrieved sources"):
                    st.markdown(msg["sources"])

    # Chat input
    if prompt := st.chat_input("Ask a question about the course materials..."):
        # Show user message
        st.session_state.messages.append({"role": "user", "content": prompt})
        with st.chat_message("user"):
            st.markdown(prompt)

        # Retrieve from ChromaDB
        retrieved_context = ""
        sources_display = ""
        if collection.count() > 0:
            model = get_model()
            query_embedding = model.encode([prompt], show_progress_bar=False).tolist()
            results = collection.query(
                query_embeddings=query_embedding,
                n_results=min(3, collection.count()),
                include=["documents", "metadatas", "distances"],
            )
            if results and results["ids"] and results["ids"][0]:
                context_parts = []
                source_parts = []
                for i in range(len(results["ids"][0])):
                    doc = results["documents"][0][i] if results["documents"] else ""
                    meta = results["metadatas"][0][i] if results["metadatas"] else {}
                    dist = results["distances"][0][i] if results["distances"] else 0
                    sim = round(1.0 - dist, 3)
                    context_parts.append(doc)
                    source_parts.append(
                        f"- **{meta.get('source', '?')}** (similarity: {sim})\n  > {doc[:150]}..."
                    )
                retrieved_context = "\n\n---\n\n".join(context_parts)
                sources_display = "\n".join(source_parts)

        # Build LangChain chain
        if not llm_api_key:
            with st.chat_message("assistant"):
                st.error("Please configure LLM API Key in the sidebar.")
            return

        llm = ChatOpenAI(
            base_url=llm_api_url,
            api_key=llm_api_key,
            model=llm_model,
            streaming=True,
        )

        # Build message history for the LLM
        history_messages = []
        for msg in st.session_state.messages[:-1]:  # exclude the current user message
            if msg["role"] == "user":
                history_messages.append(HumanMessage(content=msg["content"]))
            else:
                history_messages.append(AIMessage(content=msg["content"]))

        chat_prompt = ChatPromptTemplate.from_messages([
            ("system",
             "You are a helpful Python teaching assistant. "
             "Answer the student's question based on the following course materials. "
             "If the materials don't contain relevant information, say so honestly.\n\n"
             "Course Materials:\n{context}"),
            MessagesPlaceholder(variable_name="history"),
            ("human", "{question}"),
        ])

        chain = chat_prompt | llm | StrOutputParser()

        # Stream the response
        with st.chat_message("assistant"):
            response = st.write_stream(
                chain.stream({
                    "context": retrieved_context or "(No relevant materials found in the knowledge base.)",
                    "history": history_messages,
                    "question": prompt,
                })
            )
            if sources_display:
                with st.expander("📎 Retrieved sources"):
                    st.markdown(sources_display)

        # Save assistant message
        st.session_state.messages.append({
            "role": "assistant",
            "content": response,
            "sources": sources_display,
        })

    # Sidebar: conversation controls
    if st.session_state.messages:
        if st.sidebar.button("🗑️ Clear conversation"):
            st.session_state.messages = []
            st.rerun()


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------
if page == "Upload":
    page_upload()
else:
    page_chat()
