#!/usr/bin/env bash
# ==============================================================================
# CellMate Evaluation Suite — Phase 2: Ablation Studies (消融实验对比)
# ==============================================================================
# Executes isolated ablation experiments:
#   1. Ablation 1: ± RAG Context (No-RAG Baseline vs With-RAG Grounded)
#   2. Ablation 2: ± excludeExercises (With vs Without Exercise Statement Filtering)
#   3. Ablation 3: ± Title+Content Embedding (Title-augmented vs Content-only Vectorization)
#
# Usage:
#   ./run_phase2_ablations.sh [--api-url <URL>] [--api-key <KEY>] [--model <MODEL>] [--sample <N>]
#
# Output:
#   rag-server/ablation_results.json
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
            echo "Usage: ./run_phase2_ablations.sh [--api-url <URL>] [--api-key <KEY>] [--model <MODEL>] [--sample <N>]"
            exit 0
            ;;
        *) echo "Unknown parameter: $1"; exit 1 ;;
    esac
    shift
done

echo "=============================================================================="
echo "🔬 CELLMATE EVALUATION — PHASE 2: ABLATION STUDIES"
echo "=============================================================================="
echo "Date:      $(date '+%Y-%m-%d %H:%M:%S')"
echo "Model:     $MODEL"
echo "API URL:   ${API_URL:-'(Not provided - Ablation 1 will be skipped)'}"
echo "Sample:    $([ "$SAMPLE" -eq 0 ] && echo "All queries" || echo "$SAMPLE queries")"
echo "=============================================================================="

ARGS=()
if [ -n "$API_URL" ]; then
    ARGS+=(--api-url "$API_URL")
fi
if [ -n "$API_KEY" ]; then
    ARGS+=(--api-key "$API_KEY")
fi
if [ -n "$MODEL" ]; then
    ARGS+=(--model "$MODEL")
fi
if [ "$SAMPLE" -gt 0 ]; then
    ARGS+=(--sample "$SAMPLE")
fi

python3 evaluate_ablations.py "${ARGS[@]}"

echo -e "\n=============================================================================="
echo "🎉 Phase 2 Ablation Studies Completed Successfully!"
echo "   Results saved to: rag-server/ablation_results.json"
echo "=============================================================================="
