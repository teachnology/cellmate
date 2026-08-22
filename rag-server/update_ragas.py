import textwrap

UNIFIED_EVALUATION_PROMPT = textwrap.dedent("""\
You are an expert evaluator assessing an AI-generated answer for a programming exercise.

## Information
- Exercise ID: {exercise_id}
- Title: {title}
- Description: {description}
- Key concepts needed: {concepts}

## Retrieved Context (Top-K Chunks)
{chunks_with_ranks}

## AI-Generated Answer
{answer}

## Question
{question}

## Task
Evaluate the AI-generated answer and retrieved context across 4 metrics (0.0 to 1.0).

1. Faithfulness: Is the answer entirely supported by the retrieved context? (1.0 = fully supported, 0.0 = unsupported/hallucinated).
2. Answer Relevancy: How well does the answer address the question? (1.0 = perfectly relevant).
3. Context Recall: Does the context contain all necessary information to solve the exercise? (1.0 = covers all concepts).
4. Context Precision: Are the most relevant chunks ranked at the top? (1.0 = highly relevant chunks are at rank 1).

Respond ONLY with a JSON object in exactly this format (no markdown, no tags, no extra text):
{{"faithfulness": 0.0, "answer_relevancy": 0.0, "context_recall": 0.0, "context_precision": 0.0, "reasoning": "brief explanation"}}
""")
