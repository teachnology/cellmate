# Reproducibility Guide — CellMate Evaluation Suite

This document outlines the step-by-step instructions to independently reproduce all empirical results, benchmarks, and ablation studies reported in the CellMate project.

---

## 1. Computational Environment & System Requirements

* **Operating System**: macOS (Apple Silicon / Intel), Ubuntu Linux ($\ge 20.04$), or Windows 10/11 (via WSL2).
* **Python Version**: Python 3.10 or 3.11 (`python --version`).
* **Node.js Environment**: Node.js $\ge 18.0.0$ and npm $\ge 9.0.0$ (for VS Code extension builds).
* **Hardware Baseline**: Any modern CPU (x86_64 or Apple Silicon ARM64) with $\ge 8\text{ GB}$ RAM. GPU is optional (embeddings run on CPU via PyTorch in $<20\text{ ms}$).

---

## 2. Environment Setup & Dependency Installation

### Option A: Standard `venv` + `pip` (Recommended)
```bash
cd rag-server
python3 -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

### Option B: Conda / Mamba
```bash
cd rag-server
conda env create -f environment.yml
conda activate cellmate-rag
```

---

## 3. Dataset & Knowledge Base Placement

The benchmark evaluation requires the course materials and test suites:
* **Knowledge Base Directory**: `promptfolio/knowledge/` (contains 125 chunks across `lecture1.ipynb` to `lecture6.ipynb`).
* **Benchmark Exercises Directory**: `promptfolio/tests/` (contains 36 curriculum test cases).

The evaluation scripts automatically discover the companion repository via the environment variable `PROMPTFOLIO_PATH` or the default path `/Users/zq425/Desktop/promptfolio`. To override:
```bash
export PROMPTFOLIO_PATH="/path/to/promptfolio"
```

---

## 4. Deterministic Controls & Configuration

To eliminate stochastic variance across experimental runs:
1. **Random Seed**: Fixed to `random.seed(42)` for all deterministic subset sampling (`--sample N`).
2. **Decoding Temperature**: Hardcoded to `temperature=0.0` for LLM answer generation and LLM-as-a-Judge scoring.
3. **Embedding Model**: Pre-trained HuggingFace model `sentence-transformers/all-MiniLM-L6-v2` (384-dimensional dense vectors, normalized cosine similarity).

---

## 5. Reproduction Commands

### Step 1: Reproduce Phase 1 — Information Retrieval Benchmark (36 Exercises)
Evaluates Hit@1, Hit@3, Hit@5, Hit@10, MRR, MAP, and retrieval latency across 4 retrieval engines and 3 query modalities.

```bash
cd rag-server
python3 evaluate_rag.py
# Results are saved to: rag-server/rag_eval_results.json
```

### Step 2: Reproduce Phase 1 — End-to-End RAGAs Evaluation
Evaluates Faithfulness, Answer Relevancy, Context Recall, and Context Precision using LLM-as-a-Judge.

```bash
cd rag-server
./run_phase1_benchmarks.sh \
  --api-url "<YOUR_API_URL>" \
  --api-key "<YOUR_API_KEY>" \
  --model "qwen3.7-plus"
# Results are saved to: rag-server/ragas_eval_consolidated.json
```

### Step 3: Reproduce Phase 2 — Ablation Studies
Executes the three isolated ablation experiments:
1. `± RAG Context` (No-RAG vs With-RAG Grounded)
2. `± excludeExercises` (Exercise statement filtering on Pre-study)
3. `± Title+Content Embedding` (Title-augmented vectorization)

```bash
cd rag-server
./run_phase2_ablations.sh \
  --api-url "<YOUR_API_URL>" \
  --api-key "<YOUR_API_KEY>" \
  --model "qwen3.7-plus"
# Results are saved to: rag-server/ablation_results.json
```

---

## 6. Output Artifacts and Results Verification

All outputs are saved as structured JSON artifacts in `rag-server/` and `rag-server/result/`:
* `rag_eval_results_*.json`: Pure IR benchmark metrics.
* `ragas_eval_consolidated_*.json`: End-to-end RAGAs scores.
* `ablation_results-*.json`: Multi-condition ablation comparisons.
