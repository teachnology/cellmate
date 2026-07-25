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

