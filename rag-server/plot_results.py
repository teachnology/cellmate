"""
CellMate Experimental Results Plotter
=====================================
Generates publication-ready figures visualizing:
  1. Fig 1: Information Retrieval Benchmark across 4 Engines and 3 Modalities
  2. Fig 2: End-to-End RAGAs Evaluation (Pre-study Guide vs AI Feedback)
  3. Fig 3: Ablation 1 — Distribution of Faithfulness & Relevancy (No-RAG vs With-RAG)
  4. Fig 4: Ablation 2 & 3 — Exercise Filtering (Pre-study) and Title-Augmented Embedding
  5. Fig 5: Cross-Model Generalization Comparison

Usage:
    python3 plot_results.py

Outputs:
    rag-server/figures/*.png
"""

import os
import json
import numpy as np
import matplotlib.pyplot as plt

# Matplotlib configuration for academic publication
plt.rcParams.update({
    'font.family': 'sans-serif',
    'font.size': 11,
    'axes.labelsize': 12,
    'axes.titlesize': 13,
    'xtick.labelsize': 10,
    'ytick.labelsize': 10,
    'legend.fontsize': 10,
    'figure.titlesize': 14,
    'figure.dpi': 300,
    'axes.grid': True,
    'grid.alpha': 0.3,
    'grid.linestyle': '--',
})

PALETTE = {
    'primary': '#1f77b4',
    'secondary': '#ff7f0e',
    'green': '#2ca02c',
    'red': '#d62728',
    'purple': '#9467bd',
    'gray': '#7f7f7f',
    'light_blue': '#aec7e8',
    'light_orange': '#ffbb78',
}

RESULT_DIR = os.path.join(os.path.dirname(__file__), 'result')
FIG_DIR = os.path.join(os.path.dirname(__file__), 'figures')
os.makedirs(FIG_DIR, exist_ok=True)


def plot_fig1_ir_benchmark():
    """Figure 1: Information Retrieval Benchmark (Hit@K, MRR across engines and modalities)."""
    ir_file = os.path.join(RESULT_DIR, 'rag_eval_results_qwen3.7-plus-36exercises.json')
    if not os.path.exists(ir_file):
        ir_file = os.path.join(os.path.dirname(__file__), 'rag_eval_results.json')
    if not os.path.exists(ir_file):
        print("⚠️ IR result file not found, skipping Fig 1.")
        return

    with open(ir_file, 'r', encoding='utf-8') as f:
        data = json.load(f)

    modalities = list(data.keys())
    engines = ['BM25-lite (Keyword)', 'Dense Embedding (Cosine)', 'Hybrid (BM25 + Dense RRF)']

    fig, axes = plt.subplots(1, 3, figsize=(15, 4.5), sharey=True)

    colors = [PALETTE['primary'], PALETTE['green'], PALETTE['purple']]

    for ax, mod in zip(axes, modalities):
        x = np.arange(len(engines))
        width = 0.22

        h1 = [data[mod][eng]['hit@1'] for eng in engines]
        h3 = [data[mod][eng]['hit@3'] for eng in engines]
        mrr = [data[mod][eng]['mrr'] * 100 for eng in engines]

        r1 = ax.bar(x - width, h1, width, label='Hit@1 (%)', color=PALETTE['light_blue'], edgecolor='black', alpha=0.85)
        r2 = ax.bar(x, h3, width, label='Hit@3 (%)', color=PALETTE['primary'], edgecolor='black', alpha=0.85)
        r3 = ax.bar(x + width, mrr, width, label='MRR (×100)', color=PALETTE['secondary'], edgecolor='black', alpha=0.85)

        short_mod = mod.replace(' Query', '')
        ax.set_title(short_mod, fontweight='bold')
        ax.set_xticks(x)
        ax.set_xticklabels(['BM25', 'Dense', 'Hybrid RRF'], rotation=0)
        ax.set_ylim(0, 105)
        ax.set_ylabel('Performance Score (%)' if ax == axes[0] else '')

        # Value annotations on top of Hit@3
        for bar in r2:
            height = bar.get_height()
            ax.annotate(f'{height:.1f}%',
                        xy=(bar.get_x() + bar.get_width() / 2, height),
                        xytext=(0, 3), textcoords="offset points",
                        ha='center', va='bottom', fontsize=8, fontweight='bold')

    axes[0].legend(loc='lower right', frameon=True)
    fig.suptitle('Figure 1: Information Retrieval Accuracy Across Query Modalities (N = 36)', fontweight='bold', y=1.02)
    plt.tight_layout()
    out_path = os.path.join(FIG_DIR, 'fig1_ir_benchmark.png')
    plt.savefig(out_path, bbox_inches='tight')
    plt.close()
    print(f"  📊 Generated: {out_path}")


def plot_fig2_ragas_evaluation():
    """Figure 2: End-to-End RAGAs Generative Evaluation (Pre-study vs AI Feedback)."""
    ragas_file = os.path.join(RESULT_DIR, 'ragas_eval_consolidated_qwen3.7-max-6exercises.json')
    if not os.path.exists(ragas_file):
        ragas_file = os.path.join(RESULT_DIR, 'ragas_eval_consolidated_qwen3.7-plus-6exercises.json')
    if not os.path.exists(ragas_file):
        print("⚠️ RAGAs result file not found, skipping Fig 2.")
        return

    with open(ragas_file, 'r', encoding='utf-8') as f:
        data = json.load(f).get('summary', {})

    scenarios = ['Pre-study Guide', 'AI Feedback']
    metrics = ['faithfulness', 'answer_relevancy', 'context_recall', 'context_precision']
    metric_labels = ['Faithfulness', 'Answer Rel.', 'Context Recall', 'Context Prec.']

    fig, axes = plt.subplots(1, 2, figsize=(13, 4.8), sharey=True)

    engines = ['BM25-lite (Keyword)', 'Dense Embedding (ChromaDB)', 'Hybrid (BM25 + Dense RRF)']
    engine_labels = ['BM25 Keyword', 'Dense ChromaDB', 'Hybrid RRF']
    colors = [PALETTE['light_blue'], PALETTE['primary'], PALETTE['purple']]

    for ax, scen in zip(axes, scenarios):
        if scen not in data:
            continue
        x = np.arange(len(metrics))
        width = 0.25

        for i, (eng, label, c) in enumerate(zip(engines, engine_labels, colors)):
            if eng in data[scen]:
                vals = [data[scen][eng].get(m, 0.0) for m in metrics]
                offset = (i - 1) * width
                bars = ax.bar(x + offset, vals, width, label=label, color=c, edgecolor='black', alpha=0.85)

                for bar in bars:
                    height = bar.get_height()
                    if height > 0.05:
                        ax.annotate(f'{height:.2f}',
                                    xy=(bar.get_x() + bar.get_width() / 2, height),
                                    xytext=(0, 2), textcoords="offset points",
                                    ha='center', va='bottom', fontsize=8)

        ax.set_title(f'Scenario: {scen}', fontweight='bold')
        ax.set_xticks(x)
        ax.set_xticklabels(metric_labels, rotation=15)
        ax.set_ylim(0, 1.15)
        ax.set_ylabel('RAGAs Metric Score [0.0, 1.0]' if ax == axes[0] else '')

    axes[0].legend(loc='upper right', frameon=True)
    fig.suptitle('Figure 2: End-to-End Generative Evaluation via RAGAs (LLM-as-a-Judge)', fontweight='bold', y=1.02)
    plt.tight_layout()
    out_path = os.path.join(FIG_DIR, 'fig2_ragas_evaluation.png')
    plt.savefig(out_path, bbox_inches='tight')
    plt.close()
    print(f"  📊 Generated: {out_path}")


