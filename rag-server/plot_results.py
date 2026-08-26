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
import glob
import re
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


def get_best_model_file(pattern, score_func):
    files = glob.glob(os.path.join(RESULT_DIR, pattern))
    best_file = None
    best_score = -float('inf')
    best_model = "unknown"
    for path in files:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        try:
            score = score_func(data)
            if score > best_score:
                best_score = score
                best_file = path
                m = re.search(r'[_|-](qwen3\.[0-9]+-[a-zA-Z]+)[\-_]', os.path.basename(path))
                if m:
                    best_model = m.group(1)
        except Exception:
            pass
    return best_file, best_model


def plot_fig1_ir_benchmark():
    """Figure 1: Information Retrieval Benchmark (Hit@K, MRR across engines and modalities)."""
    def score_ir(data):
        # Average MRR for Hybrid engine across all modalities
        return np.mean([data[m]['Hybrid (BM25 + Dense RRF)']['mrr'] for m in data])

    ir_file, model_name = get_best_model_file('rag_eval_results_*.json', score_ir)
    if not ir_file:
        print("⚠️ IR result file not found, skipping Fig 1.")
        return

    with open(ir_file, 'r', encoding='utf-8') as f:
        data = json.load(f)

    modalities = list(data.keys())
    engines = ['BM25-lite (Keyword)', 'Dense Embedding (Cosine)', 'Hybrid (BM25 + Dense RRF)']

    fig, axes = plt.subplots(3, 1, figsize=(10, 12), sharey=True)

    for ax, mod in zip(axes, modalities):
        x = np.arange(len(engines))
        width = 0.13

        h1 = [data[mod].get(eng, {}).get('hit@1', 0) for eng in engines]
        h3 = [data[mod].get(eng, {}).get('hit@3', 0) for eng in engines]
        h5 = [data[mod].get(eng, {}).get('hit@5', 0) for eng in engines]
        h10 = [data[mod].get(eng, {}).get('hit@10', 0) for eng in engines]
        mrr = [data[mod].get(eng, {}).get('mrr', 0) * 100 for eng in engines]
        map_score = [data[mod].get(eng, {}).get('map', 0) * 100 for eng in engines]

        r1 = ax.bar(x - 2.5*width, h1, width, label='Hit@1 (%)', color=PALETTE['light_blue'], edgecolor='black', alpha=0.85)
        r2 = ax.bar(x - 1.5*width, h3, width, label='Hit@3 (%)', color=PALETTE['primary'], edgecolor='black', alpha=0.85)
        r3 = ax.bar(x - 0.5*width, h5, width, label='Hit@5 (%)', color=PALETTE['purple'], edgecolor='black', alpha=0.85)
        r4 = ax.bar(x + 0.5*width, h10, width, label='Hit@10 (%)', color=PALETTE['green'], edgecolor='black', alpha=0.85)
        r5 = ax.bar(x + 1.5*width, mrr, width, label='MRR (%)', color=PALETTE['light_orange'], edgecolor='black', alpha=0.85)
        r6 = ax.bar(x + 2.5*width, map_score, width, label='MAP (%)', color=PALETTE['secondary'], edgecolor='black', alpha=0.85)

        short_mod = mod.replace(' Query', '')
        ax.set_title(short_mod, fontweight='bold')
        ax.set_xticks(x)
        ax.set_xticklabels(['BM25', 'Dense', 'Hybrid RRF'], rotation=0)
        ax.set_ylim(0, 110)
        ax.set_ylabel('Performance Score (%)')

        for bars in [r1, r2, r3, r4, r5, r6]:
            for bar in bars:
                height = bar.get_height()
                ax.annotate(f'{height:.1f}%',
                            xy=(bar.get_x() + bar.get_width() / 2, height),
                            xytext=(0, 3), textcoords="offset points",
                            ha='center', va='bottom', fontsize=7.5, fontweight='bold')

    axes[0].legend(loc='lower center', bbox_to_anchor=(0.5, 1.15), frameon=True, ncol=3)
    fig.suptitle(f'Figure 1: Information Retrieval Accuracy Across Query Modalities (N = 36, {model_name})', fontweight='bold', y=1.01)
    plt.tight_layout()
    out_path = os.path.join(FIG_DIR, f'fig1_ir_benchmark_{model_name}.png')
    plt.savefig(out_path, bbox_inches='tight')
    plt.close()
    print(f"  📊 Generated: {out_path}")


def plot_fig2_ragas_evaluation():
    """Figure 2: End-to-End RAGAs Generative Evaluation (Pre-study vs AI Feedback)."""
    def score_ragas(data):
        # Average of faithfulness and answer_relevancy for AI Feedback -> Dense
        d = data['summary']['AI Feedback']['Dense Embedding (ChromaDB)']
        return d['faithfulness'] + d['answer_relevancy']

    ragas_file_cons, model_name = get_best_model_file('ragas_eval_consolidated_*.json', score_ragas)
    if not ragas_file_cons:
        print("⚠️ RAGAs result file not found, skipping Fig 2.")
        return

    ragas_file_sep = ragas_file_cons.replace('consolidated', 'separate')

    with open(ragas_file_cons, 'r', encoding='utf-8') as f:
        data_cons = json.load(f).get('summary', {})
        
    data_sep = {}
    if os.path.exists(ragas_file_sep):
        with open(ragas_file_sep, 'r', encoding='utf-8') as f:
            data_sep = json.load(f).get('summary', {})

    scenarios = ['Pre-study Guide', 'AI Feedback']
    metrics = ['faithfulness', 'answer_relevancy', 'context_recall', 'context_precision']
    metric_labels = ['Faithfulness', 'Answer Rel.', 'Context Recall', 'Context Prec.']

    fig, axes = plt.subplots(2, 2, figsize=(13, 9.6), sharey=True)

    engines = ['BM25-lite (Keyword)', 'Dense Embedding (ChromaDB)', 'Hybrid (BM25 + Dense RRF)']
    engine_labels = ['BM25 Keyword', 'Dense ChromaDB', 'Hybrid RRF']
    colors = [PALETTE['light_blue'], PALETTE['primary'], PALETTE['purple']]
    
    datasets = [(data_cons, 'Consolidated'), (data_sep, 'Separate')]

    for row, (data, data_label) in enumerate(datasets):
        for col, scen in enumerate(scenarios):
            ax = axes[row, col]
            if scen not in data:
                continue
            x = np.arange(len(metrics))
            width = 0.25

            for i, (eng, label, c) in enumerate(zip(engines, engine_labels, colors)):
                if eng in data[scen]:
                    vals = [data[scen][eng].get(m, 0.0) for m in metrics]
                    offset = (i - 1) * width
                    bars = ax.bar(x + offset, vals, width, label=label if row == 0 and col == 0 else "", color=c, edgecolor='black', alpha=0.85)

                    for bar in bars:
                        height = bar.get_height()
                        if height > 0.05:
                            ax.annotate(f'{height:.2f}',
                                        xy=(bar.get_x() + bar.get_width() / 2, height),
                                        xytext=(0, 2), textcoords="offset points",
                                        ha='center', va='bottom', fontsize=8)

            ax.set_title(f'{data_label}: {scen}', fontweight='bold')
            ax.set_xticks(x)
            ax.set_xticklabels(metric_labels, rotation=15)
            ax.set_ylim(0, 1.15)
            if col == 0:
                ax.set_ylabel('RAGAs Metric Score [0.0, 1.0]')

    axes[0, 0].legend(loc='upper right', frameon=True)
    fig.suptitle(f'Figure 2: End-to-End Generative Evaluation via RAGAs (N = 6, {model_name})', fontweight='bold', y=1.01)
    plt.tight_layout()
    out_path = os.path.join(FIG_DIR, f'fig2_ragas_evaluation_{model_name}.png')
    plt.savefig(out_path, bbox_inches='tight')
    plt.close()
    print(f"  📊 Generated: {out_path}")


def plot_fig3_ablation_rag_effect():
    """Figure 3: Ablation 1 — Distribution of Faithfulness & Relevancy (No-RAG vs With-RAG)."""
    def score_abl1(data):
        return data['ablation_1_rag_effect']['summary']['With-RAG (Dense)']['faithfulness']

    abl_file, model_name = get_best_model_file('ablation_results-*.json', score_abl1)
    if not abl_file:
        print("⚠️ Ablation result file not found, skipping Fig 3.")
        return

    with open(abl_file, 'r', encoding='utf-8') as f:
        data = json.load(f)

    details = data.get('ablation_1_rag_effect', {}).get('details', [])
    if not details:
        return

    no_rag_faith = [d['no_rag']['faithfulness'] for d in details]
    with_rag_faith = [d['with_rag']['faithfulness'] for d in details]
    no_rag_rel = [d['no_rag']['relevancy'] for d in details]
    with_rag_rel = [d['with_rag']['relevancy'] for d in details]

    fig, axes = plt.subplots(1, 2, figsize=(11, 4.5))

    box_faith = axes[0].boxplot([no_rag_faith, with_rag_faith],
                                tick_labels=['No-RAG Baseline', 'With-RAG Grounded'],
                                patch_artist=True, widths=0.45,
                                medianprops=dict(color='black', linewidth=1.5))
    box_faith['boxes'][0].set_facecolor(PALETTE['light_orange'])
    box_faith['boxes'][1].set_facecolor(PALETTE['green'])

    np.random.seed(42)
    for i, pts in enumerate([no_rag_faith, with_rag_faith], start=1):
        x_jitter = np.random.normal(i, 0.05, size=len(pts))
        axes[0].scatter(x_jitter, pts, alpha=0.4, color='black', s=20, zorder=3)

    axes[0].set_title('A. Faithfulness', fontweight='bold')
    axes[0].set_ylabel('Faithfulness Score [0.0 - 1.0]')
    axes[0].set_ylim(-0.05, 1.1)
    axes[0].text(1, np.mean(no_rag_faith) - 0.08, f'μ = {np.mean(no_rag_faith):.2f}\n(σ = {np.std(no_rag_faith):.2f})', ha='center', fontsize=9, fontweight='bold')
    axes[0].text(2, np.mean(with_rag_faith) - 0.08, f'μ = {np.mean(with_rag_faith):.2f}\n(σ = {np.std(with_rag_faith):.2f})', ha='center', fontsize=9, fontweight='bold', color='darkgreen')

    box_rel = axes[1].boxplot([no_rag_rel, with_rag_rel],
                              tick_labels=['No-RAG Baseline', 'With-RAG Grounded'],
                              patch_artist=True, widths=0.45,
                              medianprops=dict(color='black', linewidth=1.5))
    box_rel['boxes'][0].set_facecolor(PALETTE['light_blue'])
    box_rel['boxes'][1].set_facecolor(PALETTE['primary'])

    for i, pts in enumerate([no_rag_rel, with_rag_rel], start=1):
        x_jitter = np.random.normal(i, 0.05, size=len(pts))
        axes[1].scatter(x_jitter, pts, alpha=0.4, color='black', s=20, zorder=3)

    axes[1].set_title('B. Answer Relevancy', fontweight='bold')
    axes[1].set_ylabel('Answer Relevancy Score [0.0 - 1.0]')
    axes[1].set_ylim(-0.05, 1.1)
    axes[1].text(1, np.mean(no_rag_rel) - 0.08, f'μ = {np.mean(no_rag_rel):.2f}\n(σ = {np.std(no_rag_rel):.2f})', ha='center', fontsize=9, fontweight='bold')
    axes[1].text(2, np.mean(with_rag_rel) - 0.08, f'μ = {np.mean(with_rag_rel):.2f}\n(σ = {np.std(with_rag_rel):.2f})', ha='center', fontsize=9, fontweight='bold')

    fig.suptitle(f'Figure 3: Ablation 1 — Distribution of Generation Metrics (N = 36, {model_name})', fontweight='bold', y=1.02)
    plt.tight_layout()
    out_path = os.path.join(FIG_DIR, f'fig3_ablation_rag_effect_{model_name}.png')
    plt.savefig(out_path, bbox_inches='tight')
    plt.close()
    print(f"  📊 Generated: {out_path}")


def plot_fig4_ablation_filters_and_embeddings():
    """Figure 4: Ablation 2 (Exercise Filtering) & Ablation 3 (Title-Augmented Embedding)."""
    def score_abl2(data):
        return data['ablation_2_exercise_filter']['summary']['Filtered (excludeExercises=True)']['mrr']

    abl_file, model_name = get_best_model_file('ablation_results-*.json', score_abl2)
    if not abl_file:
        return

    with open(abl_file, 'r', encoding='utf-8') as f:
        data = json.load(f)

    fig, axes = plt.subplots(1, 2, figsize=(12, 5))

    abl2 = data.get('ablation_2_exercise_filter', {}).get('summary', {})
    if abl2:
        metrics = ['prec@1', 'prec@3', 'prec@5', 'mrr']
        labels = ['Prec@1', 'Prec@3', 'Prec@5', 'MRR']
        x = np.arange(len(metrics))
        width = 0.35

        unfilt = [abl2['Unfiltered (excludeExercises=False)'][m] for m in metrics]
        filt = [abl2['Filtered (excludeExercises=True)'][m] for m in metrics]

        b1 = axes[0].bar(x - width/2, unfilt, width, label='Unfiltered (Baseline)', color=PALETTE['red'], alpha=0.75, edgecolor='black')
        b2 = axes[0].bar(x + width/2, filt, width, label='Filtered (excludeExercises=True)', color=PALETTE['green'], alpha=0.85, edgecolor='black')

        axes[0].set_title('A. Pre-study Retrieval: ± Exercise Statement Filtering', fontweight='bold')
        axes[0].set_xticks(x)
        axes[0].set_xticklabels(labels)
        axes[0].set_ylabel('Score [0.0 - 1.0]')
        axes[0].set_ylim(0, max(max(unfilt), max(filt)) + 0.1)
        axes[0].legend(loc='upper right', frameon=True)

        for bars in [b1, b2]:
            for bar in bars:
                height = bar.get_height()
                axes[0].annotate(f'{height:.2f}',
                                 xy=(bar.get_x() + bar.get_width() / 2, height),
                                 xytext=(0, 2), textcoords="offset points",
                                 ha='center', va='bottom', fontsize=8, fontweight='bold')

    abl3 = data.get('ablation_3_title_embedding', {}).get('summary', {})
    if abl3:
        metrics = ['hit@1', 'hit@3', 'hit@5', 'mrr']
        labels = ['Hit@1 (%)', 'Hit@3 (%)', 'Hit@5 (%)', 'MRR']
        x = np.arange(len(metrics))
        width = 0.35

        content_only = [abl3['Content-Only Embedding'].get(m, 0) if 'hit' in m else abl3['Content-Only Embedding'].get(m, 0)*100 for m in metrics]
        title_content = [abl3['Title+Content Embedding'].get(m, 0) if 'hit' in m else abl3['Title+Content Embedding'].get(m, 0)*100 for m in metrics]

        b_co = axes[1].bar(x - width/2, content_only, width, label='Content-Only', color=PALETTE['light_blue'], alpha=0.85, edgecolor='black')
        b_tc = axes[1].bar(x + width/2, title_content, width, label='Title + Content (Enhanced)', color=PALETTE['primary'], alpha=0.85, edgecolor='black')

        axes[1].set_title('B. Vectorization: ± Section Title Concatenation', fontweight='bold')
        axes[1].set_xticks(x)
        axes[1].set_xticklabels(labels)
        axes[1].set_ylabel('Retrieval Accuracy (%)')
        axes[1].set_ylim(min(min(content_only), min(title_content)) - 5, 102)
        axes[1].legend(loc='upper right', frameon=True)

        for bars in [b_co, b_tc]:
            for bar in bars:
                height = bar.get_height()
                axes[1].annotate(f'{height:.1f}%',
                                 xy=(bar.get_x() + bar.get_width() / 2, height),
                                 xytext=(0, 2), textcoords="offset points",
                                 ha='center', va='bottom', fontsize=8, fontweight='bold')

    fig.suptitle(f'Figure 4: Ablation Studies 2 & 3 (N = 36, {model_name})', fontweight='bold', y=1.02)
    plt.tight_layout()
    out_path = os.path.join(FIG_DIR, f'fig4_ablation_filters_and_embeddings_{model_name}.png')
    plt.savefig(out_path, bbox_inches='tight')
    plt.close()
    print(f"  📊 Generated: {out_path}")


def plot_fig5_cross_model_comparison():
    """Figure 5: Cross-Model Generalization (Comparing Faithfulness & Relevancy across model scales)."""
    files = glob.glob(os.path.join(RESULT_DIR, 'ablation_results-*.json'))
    if not files:
        return
        
    models = []
    no_rag_faiths = []
    with_rag_faiths = []
    no_rag_rels = []
    with_rag_rels = []
    unfilt_prec3 = []
    filt_prec3 = []
    co_mrr = []
    tc_mrr = []

    for path in sorted(files):
        m = re.search(r'[_|-](qwen3\.[0-9]+-[a-zA-Z]+)[\-_]', os.path.basename(path))
        if m:
            name = m.group(1)
            with open(path, 'r', encoding='utf-8') as f:
                data = json.load(f)
                d1 = data.get('ablation_1_rag_effect', {}).get('summary', {})
                models.append(name)
                no_rag_faiths.append(d1.get('No-RAG', {}).get('faithfulness', 0.0))
                with_rag_faiths.append(d1.get('With-RAG (Dense)', {}).get('faithfulness', 0.0))
                no_rag_rels.append(d1.get('No-RAG', {}).get('answer_relevancy', 0.0))
                with_rag_rels.append(d1.get('With-RAG (Dense)', {}).get('answer_relevancy', 0.0))

                abl2 = data.get('ablation_2_exercise_filter', {}).get('summary', {})
                unfilt_prec3.append(abl2.get('Unfiltered (excludeExercises=False)', {}).get('prec@3', 0.0) * 100)
                filt_prec3.append(abl2.get('Filtered (excludeExercises=True)', {}).get('prec@3', 0.0) * 100)

                abl3 = data.get('ablation_3_title_embedding', {}).get('summary', {})
                co_mrr.append(abl3.get('Content-Only Embedding', {}).get('mrr', 0.0) * 100)
                tc_mrr.append(abl3.get('Title+Content Embedding', {}).get('mrr', 0.0) * 100)

    if not models:
        return

    fig, axes = plt.subplots(2, 2, figsize=(13, 9))
    x = np.arange(len(models))
    width = 0.35

    b_nf = axes[0, 0].bar(x - width/2, no_rag_faiths, width, label='No-RAG', color=PALETTE['light_orange'], edgecolor='black', alpha=0.85)
    b_wf = axes[0, 0].bar(x + width/2, with_rag_faiths, width, label='With-RAG', color=PALETTE['green'], edgecolor='black', alpha=0.85)
    axes[0, 0].set_title('A. Faithfulness Across Models', fontweight='bold')
    axes[0, 0].set_xticks(x)
    axes[0, 0].set_xticklabels(models, rotation=15)
    axes[0, 0].set_ylabel('Faithfulness Score [0.0 - 1.0]')
    axes[0, 0].set_ylim(0, 1.15)
    axes[0, 0].legend(loc='upper right', frameon=True)

    for bars in [b_nf, b_wf]:
        for bar in bars:
            height = bar.get_height()
            axes[0, 0].annotate(f'{height:.2f}', xy=(bar.get_x() + bar.get_width() / 2, height),
                             xytext=(0, 2), textcoords="offset points", ha='center', va='bottom', fontsize=8, fontweight='bold')

    b_nr = axes[0, 1].bar(x - width/2, no_rag_rels, width, label='No-RAG', color=PALETTE['light_blue'], edgecolor='black', alpha=0.85)
    b_wr = axes[0, 1].bar(x + width/2, with_rag_rels, width, label='With-RAG', color=PALETTE['primary'], edgecolor='black', alpha=0.85)
    axes[0, 1].set_title('B. Answer Relevancy Across Models', fontweight='bold')
    axes[0, 1].set_xticks(x)
    axes[0, 1].set_xticklabels(models, rotation=15)
    axes[0, 1].set_ylabel('Answer Relevancy Score [0.0 - 1.0]')
    axes[0, 1].set_ylim(0, 1.15)
    axes[0, 1].legend(loc='upper right', frameon=True)

    for bars in [b_nr, b_wr]:
        for bar in bars:
            height = bar.get_height()
            axes[0, 1].annotate(f'{height:.2f}', xy=(bar.get_x() + bar.get_width() / 2, height),
                             xytext=(0, 2), textcoords="offset points", ha='center', va='bottom', fontsize=8, fontweight='bold')

    b_unf = axes[1, 0].bar(x - width/2, unfilt_prec3, width, label='Unfiltered', color=PALETTE['red'], edgecolor='black', alpha=0.75)
    b_fil = axes[1, 0].bar(x + width/2, filt_prec3, width, label='Filtered (Exclude)', color=PALETTE['green'], edgecolor='black', alpha=0.85)
    axes[1, 0].set_title('C. Retrieval: ± Exercise Filter (Prec@3)', fontweight='bold')
    axes[1, 0].set_xticks(x)
    axes[1, 0].set_xticklabels(models, rotation=15)
    axes[1, 0].set_ylabel('Prec@3 (%)')
    if unfilt_prec3 and filt_prec3:
        axes[1, 0].set_ylim(0, max(max(unfilt_prec3), max(filt_prec3)) + 10)
    axes[1, 0].legend(loc='upper right', frameon=True)

    for bars in [b_unf, b_fil]:
        for bar in bars:
            height = bar.get_height()
            axes[1, 0].annotate(f'{height:.1f}%', xy=(bar.get_x() + bar.get_width() / 2, height),
                             xytext=(0, 2), textcoords="offset points", ha='center', va='bottom', fontsize=8, fontweight='bold')

    b_co = axes[1, 1].bar(x - width/2, co_mrr, width, label='Content-Only', color=PALETTE['light_blue'], edgecolor='black', alpha=0.85)
    b_tc = axes[1, 1].bar(x + width/2, tc_mrr, width, label='Title + Content', color=PALETTE['primary'], edgecolor='black', alpha=0.85)
    axes[1, 1].set_title('D. Vectorization: ± Section Title (MRR)', fontweight='bold')
    axes[1, 1].set_xticks(x)
    axes[1, 1].set_xticklabels(models, rotation=15)
    axes[1, 1].set_ylabel('MRR (%)')
    if co_mrr and tc_mrr:
        axes[1, 1].set_ylim(min(min(co_mrr), min(tc_mrr)) - 10, 105)
    axes[1, 1].legend(loc='upper right', frameon=True)

    for bars in [b_co, b_tc]:
        for bar in bars:
            height = bar.get_height()
            axes[1, 1].annotate(f'{height:.1f}%', xy=(bar.get_x() + bar.get_width() / 2, height),
                             xytext=(0, 2), textcoords="offset points", ha='center', va='bottom', fontsize=8, fontweight='bold')

    fig.suptitle('Figure 5: Cross-Model Robustness (N = 36)', fontweight='bold', y=1.02)
    plt.tight_layout()
    out_path = os.path.join(FIG_DIR, 'fig5_cross_model_comparison.png')
    plt.savefig(out_path, bbox_inches='tight')
    plt.close()
    print(f"  📊 Generated: {out_path}")


def main():
    print("=" * 80)
    print("🎨 GENERATING EXPERIMENTAL FIGURES FOR THESIS")
    print("=" * 80)
    plot_fig1_ir_benchmark()
    plot_fig2_ragas_evaluation()
    plot_fig3_ablation_rag_effect()
    plot_fig4_ablation_filters_and_embeddings()
    plot_fig5_cross_model_comparison()
    print("\n🎉 All figures successfully generated and saved to rag-server/figures/!")


if __name__ == '__main__':
    main()
