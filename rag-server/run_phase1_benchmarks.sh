#!/usr/bin/env bash
# ==============================================================================
# CellMate Evaluation Suite — Phase 1: Core Benchmarks
# ==============================================================================
# Executes:
#   1. Step 1: Information Retrieval Evaluation (evaluate_rag.py)
#      - 36 curriculum exercises × 3 query modalities × 4 retrieval engines
#      - Metrics: Hit@1, Hit@3, Hit@5, Hit@10, MRR, MAP, Latency
#   2. Step 2: End-to-End Generation & RAGAs Quality (evaluate_ragas_consolidated.py)
#      - Pre-study Guide & AI Feedback scenarios
#      - Metrics: Faithfulness, Answer Relevancy, Context Recall, Context Precision
#
# Usage:
#   ./run_phase1_benchmarks.sh [--api-url <URL>] [--api-key <KEY>] [--model <MODEL>] [--sample <N>]
#
# Or set environment variables:
#   export CELLMATE_API_URL="https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
#   export CELLMATE_API_KEY="sk-..."
#   export CELLMATE_MODEL="qwen3.7-plus"
# ==============================================================================

set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

# Default values from environment or fallback
API_URL="${CELLMATE_API_URL:-$LLM_API_URL}"
API_KEY="${CELLMATE_API_KEY:-$LLM_API_KEY}"
MODEL="${CELLMATE_MODEL:-${LLM_MODEL:-gpt-oss:120b}}"
SAMPLE=0

# Parse command line arguments
while [[ "$#" -gt 0 ]]; do
    case $1 in
        --api-url) API_URL="$2"; shift ;;
        --api-key) API_KEY="$2"; shift ;;
        --model) MODEL="$2"; shift ;;
        --sample) SAMPLE="$2"; shift ;;
        -h|--help)
            echo "Usage: ./run_phase1_benchmarks.sh [--api-url <URL>] [--api-key <KEY>] [--model <MODEL>] [--sample <N>]"
            exit 0
            ;;
        *) echo "Unknown parameter: $1"; exit 1 ;;
    esac
    shift
done

echo "=============================================================================="
echo " CELLMATE EVALUATION — PHASE 1: CORE BENCHMARKS"
echo "=============================================================================="
echo "Date:      $(date '+%Y-%m-%d %H:%M:%S')"
echo "Model:     $MODEL"
echo "API URL:   ${API_URL:-'(Not provided)'}"
echo "Sample:    $([ "$SAMPLE" -eq 0 ] && echo "All 36 exercises" || echo "$SAMPLE exercises")"
echo "=============================================================================="

# ------------------------------------------------------------------------------
# Step 1: Run IR Evaluation (Hit@K, MRR, MAP, Latency)
# ------------------------------------------------------------------------------
echo -e "\n[1/2]  Running Information Retrieval Benchmark (evaluate_rag.py)..."
python3 evaluate_rag.py

echo -e "\n✅ Step 1 complete. IR benchmark results saved to rag_eval_results.json"

# ------------------------------------------------------------------------------
# Step 2: Run End-to-End RAGAs Evaluation
# ------------------------------------------------------------------------------
echo -e "\n[2/2]  Running End-to-End RAGAs Evaluation (evaluate_ragas_consolidated.py)..."

if [ -z "$API_URL" ] || [ -z "$API_KEY" ]; then
    echo "⚠️ Warning: CELLMATE_API_URL and CELLMATE_API_KEY are not set."
    echo "   Skipping Step 2 (RAGAs LLM evaluation)."
    echo "   To run Step 2, provide --api-url and --api-key or set environment variables."
else
    SAMPLE_ARG=""
    if [ "$SAMPLE" -gt 0 ]; then
        SAMPLE_ARG="--sample $SAMPLE"
    fi

    python3 evaluate_ragas_consolidated.py \
        --api-url "$API_URL" \
        --api-key "$API_KEY" \
        --model "$MODEL" \
        $SAMPLE_ARG

    echo -e "\n✅ Step 2 complete. RAGAs results saved to ragas_eval_consolidated.json"
fi

echo -e "\n=============================================================================="
echo " Phase 1 Evaluation Completed Successfully!"
echo "=============================================================================="
