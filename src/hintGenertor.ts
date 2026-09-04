import axios from 'axios';
import * as vscode from 'vscode';
import { ExerciseContext } from './contextCollector';
import { buildHintPrompt } from './promptLibrary';

// Fixed keyword Categories
export type KeywordCategory = 
    | "Task requirements"
    | "Concepts"
    | "Error correction"
    | "Task processing steps"

export interface KeywordClassification {
    category: KeywordCategory;
    confidence: number;
    source: "llm";
    reason?: string;
    targetConcept?: string; // Student ask about
    exerciseConcepts?: string[]; // Concepts from the exercise itself
}

export interface LLMConfig {
    apiUrl: string;
    apiKey: string;
    modelName: string;
}

export interface HintGenerationContext extends ExerciseContext {
    exerciseDescription?: string;
}

const allowedCategories: KeywordCategory[] = [
    "Task requirements",
    "Concepts",
    "Error correction",
    "Task processing steps",
];

function isLLMCategory(value: unknown): value is KeywordCategory {
    return (
        typeof value === "string" &&
        allowedCategories.includes(value as KeywordCategory)
    );
}

export function buildClassificationPrompt(
    context: HintGenerationContext
): string {
    const studentCommentText = 
        context.isDefaultComment ? "The student did not provide a real comment." 
        : context.studentComment ?? "N/A";

    return `
You are a classifier for a programming tutor system.

Your task is to decide what type of hint the student needs.

Allowed categories:
- Task requirements
- Concepts
- Error correction
- Task processing steps

Category meanings:
- Task requirements: 
    The student does not understand what the exercise asks,
    including its goal, input, output, constraints, or required format,
    or whether a particular programming construct or action is required.
- Concepts: 
    Mentioning a programming concept does NOT automatically mean the category is Concepts. 
    Classify as Concepts only when the student's primary intention is to understand the meaning, 
    syntax, behaviour, or general usage of the concept. 
    Examples:
    "What is a for loop?" -> Concepts
    "How does range() work?" -> Concepts
    "Can you explain list indexing?" -> Concepts
    But: 
    "Do I need a for loop for this exercise?" -> Task requirements 
    "I know I need a loop, but what should I do next?" -> Task processing steps 
    "Why is my loop giving the wrong result?" -> Error correction
- Error correction: 
    The student has attempted the task, but their code contains a syntax error,
    runtime error, logical error, or produces an incorrect result.
- Task processing steps: 
    The student understands the task but does not know how to start,
    what to do next, how to structure the solution, or how to improve it.
    
Classification rules:
- Classify the student's PRIMARY help-seeking intention.
- Prioritize the student's comment, shown error, and current code state.
- Do not classify only from the exercsie description or expected concept.
- Mentioning a programming concept does NOT automatically mean Concepts.

Use the following decision rules:
- Error correction:
    If the student describes code that does not work, an error, unexpected 
    behaviour, or incorrect output, classify as Error correction.
- Task requirements:
    If the student asks what the exercise required, expected, allows, or whether
    a particular construct or action is required, classify as Task requirements.
- Concepts:
    If the student's main goal is to understand the meaning, syntax, behavior, or
    general usage of a programming concept, classify as Concepts.
    A Concepts question does not need to be completely general or seperate from the exercise.
    If the student is asking how a programming concept works or how it should be used
    in the current exercise, and the main difficulty is understanding that concept, classify as Concepts.
- Task processing steps:
    If the student understands the task or relevant concept but asks how to start,
    continue, structure, approach, or implement the solution, classify as Task processing steps.
    Use Task processing steps when the student already understands the relevant concept
    but does not know what solution action to take next.

Chooes exactly ONE of the four categories.
Do not output Unknown.

Concept identification:
- Infer the main concepts involved in the exercise from the exercise description.
- Do not assume that the student knows the correct name of the concept.
- Infer concepts from meaning, not only from explicit keywords.
- "targetConcept" is the specific concept that the student appears to be
  confused about or asking about.
- "exerciseConcepts" are the main concepts involved in the exercise.
- targetConcept does NOT determine the hint category by itself.
- If the student asks how or why a concept works, classify as Concepts.
- If the student asks whether a concept is required, classify as Task requirements.
- If the student understands the concept but asks what to do next,
  classify as Task processing steps.
- If the student is using the concept incorrectly in an attempted solution,
  classify as Error correction.

Do not generate a hint.
Do not solve the exercise.
Return only valid JSON in this format:
    
{
    "category": "one of the allowed categories",
    "confidence": 0.0,
    "reason": "one sentence reason",
    "targetConcept": "concept name or empty string",
    "exerciseConcepts": ["concept1", "concept2"]
}

Exercise description:
${context.exerciseDescription ?? "N/A"}
    
Student code:
${context.studentCode || "No code provided."}
    
Student comment:
${studentCommentText}
    
Shown error:
${context.shownError ?? "N/A"}`.trim();
}

export function parseLLMResponse(rawResponse: string): {
    category: KeywordCategory;
    confidence: number;
    reason: string;
    targetConcept?: string;
    exerciseConcepts: string[];
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
    const parsedConfidence = Number(parsed.confidence);
    const confidence = Number.isFinite(parsedConfidence) ? Math.max(0, Math.min(1, parsedConfidence)) : 0.5;

    const reason = typeof parsed.reason === "string" ? parsed.reason : "Classified by LLM.";

    const targetConcept = typeof parsed.targetConcept === "string"
        && parsed.targetConcept.trim() ? parsed.targetConcept.trim() : undefined;

    const exerciseConcepts = Array.isArray(parsed.exerciseConcepts) ? parsed.exerciseConcepts
            .filter(
                (concept: unknown): concept is string => typeof concept === "string" &&
                    concept.trim().length > 0)
            .map((concept: string) => concept.trim()) : [];

    return {
        category,
        confidence,
        reason,
        targetConcept,
        exerciseConcepts,
    };
}

export async function generateHint(
    exerciseContext: HintGenerationContext,
    config: LLMConfig,
    _extensionContext: vscode.ExtensionContext
): Promise<string> {
    console.warn("[HintGenerator] generateHint called");

    const finalClassification = await getLLMClassification(exerciseContext, config);

    console.warn("[Hint Generator] final classification:", finalClassification.category);

    const prompt = buildHintPrompt(exerciseContext, finalClassification);

    return await callLLMAPI(prompt, config);
}

export async function callLLMAPI (
    prompt: string,
    config: LLMConfig
): Promise<string> {
    const isOpenAIEndpoint = config.apiUrl.includes('/chat/completions');

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
    };

    if (config.apiKey && config.apiKey.trim()) {
        headers['Authorization'] = `Bearer ${config.apiKey}`;
    }

    console.log('[LLM API] URL: ', config.apiUrl);
    console.log('[LLM API] Model: ', config.modelName);
    console.log('[LLM API] API key exists: ', Boolean(config.apiKey));
    console.log('[LLM API]: Authorization sent: ', Boolean(headers.Authorization));

    const body = isOpenAIEndpoint ? {
        model: config.modelName,
        messages: [
            {
                role: 'user',
                content: prompt,
            },
        ],
        max_tokens: 220,
    } : {
        model: config.modelName,
        prompt: prompt,
        stream: false,
    };

    try {
        const response = await axios.post(config.apiUrl, body, {headers, timeout: 60000});

        if (isOpenAIEndpoint) {
            const content = response.data?.choices?.[0]?.message?.content;

            if (!content) {
                throw new Error('Invalid OpenAI response format.');
            }
            return content.trim();
        }
        const content = response.data?.response;

        if (!content) {
            throw new Error('Invalid Ollama response format.');
        }
        return content.trim();
    } catch(error) {
        if (axios.isAxiosError(error)) {
            console.error("[LLM API] Request failed");
            console.error("[LLM API] Status:", error.response?.status);
            console.error("[LLM API] Response data:", error.response?.data);
            console.error("[LLM API] Request body:", error.config?.data);
            console.error("[LLM API] Request URL:", error.config?.url);
            console.error("[LLM API] Request method:", error.config?.method);
        } else {
            console.error("[LLM API] Unknwon error: ", error);
        }
        throw error;
    }
}

async function getLLMClassification(
    exerciseContext: HintGenerationContext,
    config: LLMConfig
): Promise<KeywordClassification> {
    const classifierPrompt = buildClassificationPrompt(
        exerciseContext,
    );

    try {
        const rawResponse = await callLLMAPI(classifierPrompt, config);

        const parsedClassification = parseLLMResponse(rawResponse);

        return {
            category: parsedClassification.category,
            confidence: parsedClassification.confidence,
            source: "llm",
            reason: parsedClassification.reason,
            targetConcept: parsedClassification.targetConcept,
            exerciseConcepts: parsedClassification.exerciseConcepts,
        };
    } catch (error) {
        console.error("Failed to get LLM classification:", error);
        throw error;
    }
}