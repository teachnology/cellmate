import { ExerciseContext } from "./contextCollector";

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

export function buildClassificationPrompt(context: ExerciseContext): string{
    if (isValidText(context.studentComment)) {
        return buildCommentClassifyPrompt(context);
    }
    return buildNoCommentClassifyPrompt(context);
}

// This function uses LLM to refine prompt.
export function buildCommentClassifyPrompt(context: ExerciseContext): string {
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
- Prioritize the student's comment, available test failure feedback, and current code state.
- Do not classify only from the exercise description or expected concept.
- Mentioning a programming concept does NOT automatically mean Concepts.
- Treat test failure feedback as supporting diagnostic evidence.
- Do not let test failure feedback override a clearly expressed student intention in the comment.

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
    A Concepts question does not need to be completely general or separate from the exercise.
    If the student is asking how a programming concept works or how it should be used
    in the current exercise, and the main difficulty is understanding that concept, classify as Concepts.
- Task processing steps:
    If the student understands the task or relevant concept but asks how to start,
    continue, structure, approach, or implement the solution, classify as Task processing steps.
    Use Task processing steps when the student already understands the relevant concept
    but does not know what solution action to take next.

Choose exactly ONE of the four categories.
Do not output Unknown.

Do not generate a hint.
Do not solve the exercise.
Return only valid JSON in this format:
    
{
    "category": "one of the allowed categories",
    "targetConcept": "concept name or empty string"
}
    
Exercise ID:
${context.exerciseId ?? "N/A"}
    
Exercise description:
${context.exerciseDescription ?? "N/A"}
    
Exercise concept:
${context.exerciseConcept ?? "N/A"}
    
Student code:
${context.studentCode || "No code provided."}
    
Student comment:
${context.studentComment}

Comment line: 
${context.studentCommentLine ?? "N/A"}

Code on the commented line:
${context.studentCommentCodeLine ?? "N/A"}
    
Test failure feedback:
${context.testFeedback ?? "N/A"}`.trim();
}

// This function uses LLM to refine prompt.
function buildNoCommentClassifyPrompt(context: ExerciseContext): string {
    return `
You are a classifier for a programming tutor system.

The student requested help but did Not provide a new explicit comment describing their difficulty.

Your task is to infer the most likely type of support the student needs from the available learning context.

Allowed categories:
- Task requirements
- Concepts
- Error correction
- Task processing steps

Category meanings:
- Task requirements:
    The main difficulty appears to be understanding what the exercise requires, including the goal,
    required output, constraints, expected format, or required programming constructs.
- Concepts:
    The main difficulty appears to be a lack of understanding of a programming concept, its syntax, 
    behaviour, or general usage.
- Error correction:
    The student has made a meaningful implementation attempt, but the current code or execution information
    indicates a syntax error, runtime error, logical error, unexpected behaviour, or incorrect result.
- Task processing steps:
    The student appears to need guidance on how to begin, continue, advancement on the task.
    
Classification rules:
Infer the support need carefully from multiple contextual signals rather than from a single field.

Use the evidence in approximately this order:
- Test failure feedback, if available.
- The student's current code and level of implementation progress.
- The relationship between the current code and the exercise requirements.
- The expected concepts of the exercise.
Additional rule:
- If test failure feedback is available, treat this as strong evidence for Error correction unless the broader context clearly indicates otherwise.

Chooes exactly ONE category.
Do not output Unknown.
Do not generate a hint.
Do not solve the exercise.

Return only valid JSON in this format:
{
    "category": "one of the allowed categories",
    "confidence": 0.0,
    "reason": "one sentence reason",
    "targetConcept": "concept name or empty string"
}

Exercise ID:
${context.exerciseId ?? "N/A"}

Exercise description
${context.exerciseDescription ?? "N/A"}

StudentCode:
${context.studentCode || "No code provided."}

Test failure feedback: 
${context.testFeedback ?? "N/A"}`.trim();
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