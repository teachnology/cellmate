import * as vscode from 'vscode';
import { ExerciseContext } from "./contextCollector";
import { getPromptContent } from './gitUtils';

// This file uses LLM to refine prompt and generate the regular expression.
// Fixed keyword Categories
export type KeywordCategory = 
    | "Task requirements"
    | "Concepts"
    | "Error correction"
    | "Task processing steps"
    | "Unknown";

export interface KeywordClassification {
    category: KeywordCategory;
    targetConcept?: string;
};

const programmingConcepts: string[] = [
    // Control flow
    "for loop",
    "while loop",
    "if statement",
    "conditional",
    "break",
    "continue",

    // Functions
    "function",
    "parameter",
    "argument",
    "return",
    "lambda",

    // Collections
    "list",
    "tuple",
    "dictionary",
    "dict",
    "set",
    "array",

    // Common functions and methods
    "range",
    "len",
    "print",
    "input",

    // Indexing
    "index",
    "indexing",
    "slice",
    "slicing",

    // Types
    "string",
    "integer",
    "float",
    "double",
    "boolean",
];

type FixedRule = {
    category: Exclude<KeywordCategory, "Unknown">;
    patterns: RegExp[];
};

const fixedQuestionRules: FixedRule[] = [
    {
        category: "Error correction",
        patterns: [
            /\bwhat is the error\b/i,
            /\bwhat'?s the error\b/i,
            /\bwhat is wrong\b/i,
            /\bwhat'?s wrong\b/i,
            /\bwhat is wrong with (this|my code)\b/i,
            /\bwhy does (this|my code) not work\b/i,
            /\bwhy isn'?t (this|my code) working\b/i,
            /\bcan you (find|check|fix) the error\b/i
        ]
    },
    {
        category: "Task requirements",
        patterns: [
            /\bwhat does (this|the) exercise ask\b/i,
            /\bwhat does (this|the) task ask\b/i,
            /\bwhat are the requirements\b/i,
            /\bwhat do i need to do\b/i,
            /\bwhat should the output (be|include|contain|look like)\b/i,
            /\bdo i need to\b/i,
            /\bdo i have to\b/i,
            /\bam i supposed to\b/i,
            /\bshould i use\b/i,
            /\bshould i (print|return|create|write)\b/i
        ]
    },
    {
        category: "Task processing steps",
        patterns: [
            /\bhow do i start\b/i,
            /\bwhere do i start\b/i,
            /\bwhat should i do first\b/i,
            /\bwhat should i do next\b/i,
            /\bwhat is the next step\b/i,
            /\bhow do i continue\b/i,
            /\bi don'?t know how to (start|continue|proceed)\b/i,
            /\bhow should i approach\b/i,
            /\bhow do i approach\b/i,
            /\bi don'?t know how to implement\b/i,
            /\bi don'?t know how to solve\b/i,
            /\bhow should i structure\b/i,
            /\bwhat should i put\b/i,
            /\bhow do i use .* (here|in this exercise|for this task)\b/i
        ]
    }
];

function matchConceptQuestion(
    studentComment: string
): string | undefined {
    const normalizedComment = normalizeText(studentComment);

    const conceptQuestionPatterns: RegExp[] = [
        /\bwhat is\b/i,
        /\bexplain\b/i,
        /\bdefinition of\b/i,
        /\bmeaning of\b/i,
        /\bcan you give (me )?an example of\b/i
    ];

    const asksConceptQuestion = conceptQuestionPatterns.some(pattern =>
        pattern.test(normalizedComment)
    );
    if (!asksConceptQuestion) {
        return undefined;
    }

    const sortedConcepts = [...programmingConcepts].sort((a, b) => b.length - a.length);
    for (const concept of sortedConcepts) {
        const normalizedConcept = normalizeText(concept);
        if (normalizedComment.includes(normalizedConcept)) {
            return concept;
        }
    }
    return undefined;
}

function normalizeText(text: string): string {
    return text.toLowerCase()
        .replace(/[_-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function isValidText(text: unknown): text is string {
    return typeof text === "string" && text.trim().length > 0;
}

export function classifyByRule(context: ExerciseContext): KeywordClassification {
    if (!isValidText(context.studentComment)) {
        return {
            category: "Unknown",
        };
    }

    const studentComment = context.studentComment.trim();
    const normalizedComment = normalizeText(studentComment);

    for (const rule of fixedQuestionRules) {
        const matchedPattern = rule.patterns.find(pattern =>
            pattern.test(normalizedComment)
        );
        if (matchedPattern) {
            return {
                category: rule.category
            };
        }
    }

    const targetConcept = matchConceptQuestion(studentComment);

    if (targetConcept) {
        return {
            category: "Concepts",
            targetConcept
        };
    }
    return {
        category: "Unknown"
    };
}

export function shouldUseLLMClassifier(classification: KeywordClassification): boolean {
    return classification.category === "Unknown";
}

export function getClassifierPromptId(context: ExerciseContext): string {
    if (isValidText(context.studentComment)) {
        return "hint_classifier_comment";
    }
    return "hint_classifier_no_comment";
}

const llmAllowedCategories = [
    "Task requirements",
    "Concepts",
    "Error correction",
    "Task processing steps",
] as const;

function isLLMCategory(value: unknown): value is Exclude<KeywordCategory, "Unknown">{
    return (
        typeof value === "string" && llmAllowedCategories.includes(value as typeof llmAllowedCategories[number])
    );
}

export function parseLLMResponse(rawResponse: string): {
    category: KeywordCategory;
    targetConcept?: string;
} {
    const cleanedResponse = rawResponse
        .trim().replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "").replace(/```$/i, "").trim();

    const jsonMatch = cleanedResponse.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
        throw new Error("LLM classification response does not contain valid JSON.");
    }

    const parsed = JSON.parse(jsonMatch[0]);

    if (!isLLMCategory(parsed.category)) {
        throw new Error(`Invalid LLM classification category: ${parsed.category}`);
    }
    const category: KeywordCategory = parsed.category;

    const targetConcept = typeof parsed.targetConcept === "string"
        && parsed.targetConcept.trim() ? parsed.targetConcept.trim() : undefined;

    return {
        category,
        targetConcept,
    };
}

function formatConcept(concept?: string): string {
    if(!concept) {
        return "N/A";
    }
    return concept.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function formatConceptList(concepts?: string[]): string {
    if (!concepts || concepts.length === 0) {
        return "N/A";
    }
    const validConcepts = concepts.map(concept => formatConcept(concept)).filter(concept => concept !== "N/A");
    return validConcepts.length > 0 ? validConcepts.join(", ") : "N/A";
}

function getTargetConcept (
    context: ExerciseContext,
    classification: KeywordClassification
): string {
    if (classification.targetConcept && classification.targetConcept.trim().length > 0) {
        return formatConcept(classification.targetConcept);
    }
    if (context.exerciseConcept?.length === 1) {
        return formatConcept(context.exerciseConcept[0]);
    }
    return "the programming concept mentioned by the student";
}

function normalizeConcept(concept: string): string {
    return concept.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function matchesExpectedConcept(
    targetConcept: string,
    expectedConcepts: string[]
): boolean {
    const normalizedTarget = normalizeConcept(targetConcept);
    if (normalizedTarget.length === 0) {
        return false;
    }

    return expectedConcepts.some(expectedConcept => {
        const normalizedExpected = normalizeConcept(expectedConcept);
        if (normalizedExpected.length === 0) {
            return false;
        }
        return (
            normalizedTarget === normalizedExpected ||
            normalizedTarget.includes(normalizedExpected) ||
            normalizedExpected.includes(normalizedTarget)
        );
    });
}

function needsDetailedExplanation(context: ExerciseContext): boolean {
    if (!context.studentComment || !context.studentCommentCodeLine) {
        return false;
    }

    const comment = context.studentComment.toLowerCase();
    const localReferencePatterns: RegExp[] = [
        /\bthis line\b/i,
        /\bthis part\b/i,
        /\bthis code\b/i
    ];
    return localReferencePatterns.some(pattern => pattern.test(comment));
}

export function getHintPromptId(
    context: ExerciseContext,
    classification: KeywordClassification
): string {
    switch (classification.category) {
        case "Concepts":
            if (needsDetailedExplanation(context)) {
                return "hint_concepts_local_explanation";}
            return "hint_concepts";
        case "Task requirements":
            return "hint_task_requirements";
        case "Error correction":
            return "hint_error_correction";
        case "Task processing steps":
            return "hint_task_processing_steps";
        default:
            return "hint_task_processing_steps";
    }
}

export function buildHintPromptValues(
    context: ExerciseContext,
    classification: KeywordClassification
): Record<string, string> {
    const targetConcept = getTargetConcept(context, classification);
    const conceptMatchesExercise = matchesExpectedConcept(targetConcept, context.exerciseConcept ?? []);

    const conceptRelevance = conceptMatchesExercise
        ? "The requested concept is relevant to the current exercise."
        : "The requested concept is not required by the current exercise.";
    const exerciseConnectionInstruction = conceptMatchesExercise
        ? `After the syntax example, add exactly one short sentence explaining where this concept may be useful in the current exercise.`
        : `After the syntax example, add exactly one short sentence explaining that this concept is not required for the current exercise.`;

    return {
        exercise_description: context.exerciseDescription ?? "N/A",
        exercise_concept: formatConceptList(context.exerciseConcept),
        student_code: context.studentCode ?? "N/A",
        student_comment: context.studentComment ?? "N/A",
        student_comment_code_line: context.studentCommentCodeLine ?? "N/A",
        test_feedback: context.testFeedback ?? "N/A",
        target_concept: targetConcept,
        concept_relevance: conceptRelevance,
        exercise_connection_instruction: exerciseConnectionInstruction,
    };
}

export async function classifyHintType(
    exerciseContext: ExerciseContext,
    callLLM: (prompt: string) => Promise<string>
): Promise<KeywordClassification> {
    const ruleClassification = classifyByRule(exerciseContext);
    if (!shouldUseLLMClassifier(ruleClassification)) {
        return ruleClassification;
    }
    return await getLLMClassification(exerciseContext, ruleClassification, callLLM);
}

function buildClassifierPromptValues(context: ExerciseContext): Record<string, string> {
    return {
        exercise_id: context.exerciseId ?? "N/A",
        exercise_description: context.exerciseDescription ?? "N/A",
        exercise_concept: context.exerciseConcept?.join(", ") ?? "N/A",
        student_code: context.studentCode || "No code provided.",
        student_comment: context.studentComment ?? "N/A",
        student_comment_line: context.studentCommentLine !== undefined ? String(context.studentCommentLine) : "N/A",
        student_comment_code_line: context.studentCommentCodeLine ?? "N/A",
        test_feedback: context.testFeedback ?? "N/A",
    };
}

async function getLLMClassification(
    exerciseContext: ExerciseContext,
    ruleClassification: KeywordClassification,
    callLLM: (prompt: string) => Promise<string>
): Promise<KeywordClassification> {
    try {
        const classifierPromptId = getClassifierPromptId(exerciseContext);
        const promptTemplate = await getPromptContent(classifierPromptId);
        const values = buildClassifierPromptValues(exerciseContext);
        const classifierPrompt = fillPromptValues(promptTemplate, values);
        const rawResponse = await callLLM(classifierPrompt);
        const parsedClassification = parseLLMResponse(rawResponse);

        return {
            ...ruleClassification,
            category: parsedClassification.category,
            targetConcept: parsedClassification.targetConcept ?? ruleClassification.targetConcept,
        };
    } catch (error) {
        console.error("Failed to get LLM classification:", error);
        return {
            ...ruleClassification,
            category: "Unknown",}
    }
}

export async function generateHint(
    exerciseContext: ExerciseContext,
    callLLM: (prompt: string) => Promise<string>,
    _extensionContext: vscode.ExtensionContext
): Promise<string> {
    const finalClassification = await classifyHintType(exerciseContext, callLLM);
    const promptId = getHintPromptId(exerciseContext, finalClassification);
    const promptTemplate = await getPromptContent(promptId);
    const values = buildHintPromptValues(exerciseContext, finalClassification);
    const prompt = fillPromptValues(promptTemplate, values);
    return await callLLM(prompt);
}

function fillPromptValues(template: string, values: Record<string, string>): string {
    let prompt = template;
    for (const [key, value] of Object.entries(values)) {
        prompt = prompt.replace(new RegExp(`{{${key}}}`, "g"), value);
    }
    return prompt.trim();
}