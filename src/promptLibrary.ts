import { ExerciseContext } from "./contextCollector";
import { KeywordCategory, KeywordClassification } from "./hintClassifier";

// This file uses LLM to refine prompt.

type HintPromptBuilder = (
    Context: ExerciseContext,
    classification: KeywordClassification
) => string;

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

const specialPromptBuilders: Partial<Record<KeywordCategory, HintPromptBuilder>> = {
    "Concepts": buildConceptPrompt,
    "Task requirements": buildTaskRequirementPrompt,
    "Error correction": buildErrorCorrectionPrompt,
    "Task processing steps": buildTaskProcessingPrompt
};

function buildRelevantContext(
    context: ExerciseContext,
    classification: KeywordClassification
): string[] {
    const sections: string[] = [];

    switch (classification.category) {
        case "Task requirements":
            if (context.exerciseDescription) {
                sections.push(`Exercise Description:\n${context.exerciseDescription}`);
            }
            if (context.studentComment) {
                sections.push(`Student Comment:\n${context.studentComment}`);
            }
            if (context.studentCode) {
                sections.push(`Student Code:\n${context.studentCode}`);
            }
            break;

        case "Concepts":
            sections.push(`Target Concept:\n${getTargetConcept(context, classification)}`);
            if (context.exerciseConcept?.length) {
                sections.push(`Expected Exercise Concepts:\n${formatConceptList(context.exerciseConcept)}`);
            }
            if (context.studentComment) {
                sections.push(`Student Comment:\n${context.studentComment}`);
            }
            if (context.exerciseDescription) {
                sections.push(`Exercise Description:\n${context.exerciseDescription}`);
            }
            if (context.studentCode) {
                sections.push(`Student Code:\n${context.studentCode}`);
            }
            break;
        
        case "Task processing steps":
            if (context.exerciseDescription) {
                sections.push(`Exercise Description:\n${context.exerciseDescription}`);
            }
            if (context.exerciseConcept?.length) {
                sections.push(`Expected Concept:\n${formatConceptList(context.exerciseConcept)}`);
            }
            if (context.studentCode) {
                sections.push(`Student Code:\n${context.studentCode}`);
            }
            if (context.studentComment) {
                sections.push(`Student Comment:\n${context.studentComment}`);
            }
            break;

        case "Error correction":
            if (context.testFeedback) {
                sections.push(`Show Error:\n${context.testFeedback}`);
            }
            if (context.studentCode) {
                sections.push(`Student Code:\n${context.studentCode}`);
            }
            if (context.studentComment) {
                sections.push(`Student Comment:\n${context.studentComment}`);
            }
            break;

        default:
            if (context.exerciseDescription) {
                sections.push(`Exercise Description:\n${context.exerciseDescription}`);
            }
            if (context.studentCode) {
                sections.push(`Student Code:\n${context.studentCode}`);
            }
            if (context.studentComment) {
                sections.push(`Student Comment:\n${context.studentComment}`);
            }
            if (context.testFeedback) {
                sections.push(`Show Error:\n${context.testFeedback}`);
            }
            break;
    }
    return sections;
}

export function buildHintPrompt(
    exContext: ExerciseContext,
    classification: KeywordClassification
): string {
    const category = classification.category;
    const builder = specialPromptBuilders[category] ?? buildDefaultHintPrompt;
    const selectedPromptName = specialPromptBuilders[category]
        ? `${category} Prompt` : "Default Hint Prompt";
    console.warn("[Hint Prompt] selected prompt:", selectedPromptName);
    const finalPrompt = builder(exContext, classification);
    return finalPrompt;
}

function buildDefaultHintPrompt (
    context: ExerciseContext,
    classification: KeywordClassification
): string {
    const sections: string[] = [];

    sections.push(`
You are a helpful programming tutor.

Your task is to give the student a useful scaffolding hint.

The student's request has been classified as:
${classification.category}

Rules:
- Respond directly to the student's current difficulty.
- Anchor the hint to the student's actual code, comment, error, or exercise context.
- Identify the exact variable, expression, condition, code structure, or task requirement the student
should focus on when that information is available.
- Avoid generic advice that could apply to many unrelated exercises.
- Give one concrete next action the student can take.
- Be specific about where the student should focus, while leaving the reasoning or correction
for the student to complete.
- Do not give the full solution.
- Do not provide complete task-specific code.
- Do not list all remaining operations or steps.
- Do not directly state the final answer, formula, condition, or correction.
- Give only one short, clear hint with some highlights.
- Use simple language.
`.trim());

    sections.push(...buildRelevantContext(context, classification));

    sections.push(`
    Output requirement:
    Return one short hint only.`.trim());

    return sections.join("\n\n");
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

function buildConceptPrompt(
    context: ExerciseContext,
    classification: KeywordClassification
): string {
    const concept = getTargetConcept(context, classification);
    const useDetailedExplanation = needsDetailedExplanation(context);
    
    if (useDetailedExplanation) {
        return `
    You are a programming tutor.
    
    The student is asking about an explanation of a specific local piece of code.
    
    Exercise description:
    ${context.exerciseDescription ?? "N/A"}
    
    Student commnet:
    ${context.studentComment ?? "N/A"}
    
    Student code:
    ${context.studentCode}
    
    Code associated with the student comment:
    ${context.studentCommentCodeLine ?? "N/A"}
    
    Rules:
    - Directly explain the student's specific misunderstanding or confusion.
    - Explain the referenced code line or expression is doing.
    - Explain how the relevant parts work together in this specific line.
    - Refer to the exercise description only when it is necessary to clarify the meaning of the referenced code.
    - Use simple language suitable for an introductory Python student.
    - Focus only on the code or behaviour the student asked about.
    - Do not discuss whether the concept is required by the exercise.
    - Keep the explanation focused and concise.
    - Do not explain later steps, later calculations, or what the result will be used for next.
    - Return only Markdown and use limited emphasis for key code elements or concepts.`.trim();
    }

    const conceptMatchesExercise = matchesExpectedConcept(concept, context.exerciseConcept ?? []);

    const relevanceStatement = conceptMatchesExercise 
        ? "The requested concept is relevant to the current exercise."
        : "The requested concept is not required by the current exercise.";

    const exerciseConnectionInstruction = conceptMatchesExercise
        ? `
        After the syntax example, add exactly one short sentence explaining where this
        concept may be useful in the current exercise.
        
        The sentence must:
        - refer to the student's current difficulty;
        - stay at a general level;
        - not reveal implementation details or the answer.` 
        : `
        After the syntax example, add exactly one short sentence explaining that this concept is 
        not required for the current exercise.
        
        The sentence must:
        - refer explicitly to the student's current misunderstanding, code element, or question when available.
        - Clarify why the concept is not necessary here;
        - not provide the task-specific implementation, completed expression, or final answer;`
    
    return `
You are a programming tutor.
    
The student needs help understanding a programming concept.
    
Target concept:
${concept}

Expected exercise concept:
${formatConceptList(context.exerciseConcept)}

Exercise description:
${context.exerciseDescription ?? "N/A"}

Student comment:
${context.studentComment ?? "N/A"}

Code associated with the student comment:
${context.studentCommentCodeLine ?? "N/A"}

Concept relevance judgement:
${relevanceStatement}

Rules:
- Briefly only explain the target programming concept relevant to the student's question.
- Respond directly to the misunderstanding shown in the student comment.
- Use simple language suitable for an introductor Python student.
- Do not give a generic explanation when a specific misunderstanding is visible.
- Be specific about what the student should understand or inspect, but leave the implementation to the student.
- Do not reveal the current exercise's answer.
- Do not provide task-specific code.
- Return only Markdown.
- Treat the concept relevance judgement as authoritative.
- If the concept is not required, do not try to make it appear useful in the exercise.
- Do not invent an extended or alternative version of the exercise.

Syntax example rules:
- Keep the basic syntax example generic.
- Do not use variable names, values, formulas, or expressions from the exercise.
- Show only the minimum syntax needed to illustrate the concept.
- Never place the exercise solution inside the syntax example.

Exercise connection instructions:
${exerciseConnectionInstruction}

You must follow exactly this Markdown structure:

A short explanation of the concept. 

Basic syntax:
            
\`\`\` python
a tiny generic syntax pattern
\`\`\`

One short sentence connecting the concept to the student's current difficulty.
`.trim();
}

function buildTaskRequirementPrompt(context: ExerciseContext, classification: KeywordClassification): string {
    return `
You are a programming tutor helping a beginner understand an exercise.

Exercise description:
${context.exerciseDescription ?? "N/A"}

Student code:
${context.studentCode ?? "N/A"}

Student question:
${context.studentComment ?? "N/A"}

Your task:
Answer only the student's question about the exercise requirements.

Rules:
- Clarify what the exercise expects the student to produce.
- Focus only on the relevant input, output, required behaviour, or constraints.
- Highlight some relevant input, output, required behaviour, or constraints.
- Avoid generic description of the task.
- Answer the exact requirement the student is confused about rather than restarting the whole exercise.
- Use the concrete input, output, behaviour, or constraint named in the exercise when
it is relevant to the student's question.
- Do not use question, especially in the last line.
- Do not analyse the student's code.
- Do not discuss errors, debugging, PyBryt, tests, or annotations.
- Do not explain the implementation steps.
- Do not suggest an algorithm.
- Do not provide formulas or task-specific code.
- Do not tell the student exactly how to solve the exercise.
- Use simple language suitable for introductory Python student.
- Write no more than 2 short sentences.
- Write as markdown format with some highlights.`.trim();
}

function buildErrorCorrectionPrompt(context: ExerciseContext, classification: KeywordClassification): string{
    return `
You are a programming tutor helping a beginner correct an error.

Exercise description
${context.exerciseDescription ?? "N/A"}

Student code:
${context.studentCode ?? "N/A"}

Internal test failure information:
${context.testFeedback ?? "N/A"}

Student comment:
${context.studentComment ?? "N/A"}

Your task:
Determine whether the code contains one clear issue or multiple independent issues.

If there is one clear issue:
- Identify only that issue.
- Explain what the student should inspect or change.
- Briefly state that this is the only issue they need to address based on the current context.

If there are multiple independent issues:
- Explain only the highest-priority issue.
- Briefly state that other issues may remain, but this one should be fixed first.
- Do not describe the remaining issues.

Rules:
- Base the response only on the provided code, error information, and student question.
- Highlight the key points in the error.
- Do not invent an error when no concrete error is visible.
- First determine whether a syntax or runtime error is present.
- If there is only one syntax or runtime error, explain only that error.
- If a syntax or runtime error and another independent error are both clearly present, present them as two short bullet points:
  Syntax/runtime error:explain the blocking syntax or runtime issue.
  Other error: explain the most important remaining logical or result-related issue.
- If there is no syntax or runtime error, focus only on the issue most directly responsible for the incorrect result.
- Do not list more than one non-syntax/runtime issue.
- Point to the relevant line, expression, condition, operation, variable, or code structure.
- Name the exact code element causing the problem when it can be identified from the provided context.
- Explain why the identified element is problematic, but do not provide the exact replacement code.
- Give one focused action for each reported issue.
- Do not use a question, especially in the last line.
- Do not add a separate topic or heading unless bullet points are required by the rules above.
- Do not provide a complete corrected solution.
- Do not give all remaining correction steps.
- Do not directly provide the final algorithm.
- For a logical error, do not provide the exact replacement expression when the student can reasonably determine it from the hint.
- Use simple language suitable for a beginner.
- Keep each explanation short and focused.
- Write no more than 3 short sentences when reporting one issue.
- When reporting two issues, use exactly two short bullet points.
- Return Markdown with light highlighting where useful.`.trim();
}

function buildTaskProcessingPrompt(context: ExerciseContext, classification: KeywordClassification): string {
    return `
You are a helpful programming tutor helping a beginner with a Python exercise.

Student code:
${context.studentCode ?? "N/A"}

Expected exercise concept:
${formatConceptList(context.exerciseConcept)}

Exercise description:
${context.exerciseDescription ?? "N/A"}

Student comment:
${context.studentComment ?? "N/A"}

Give the student only the earliest useful next step.

Rules:
- Base the hint on the student's current code and comment.
- Refer explicitly to the relevant varaible, expression, incomplete code structure, or current subgoal when one is visible.
- Tell the student exactly where to focus next, but not exactly what code to write.
- Prefer a concrete action such as inspecting, comparing, tracing, or testing one specific part of the current attempt.
- Avoid generic advice such as "think about the problem", "check your code", or "consider the next step" without identifying what to inspect.
- Do not use transition phrases such as "Now, think about...".
- Give only one small action, not the full solution.
- Do not list all remaining steps.
- Do not give a complete function, loop, formula, condition, or algorithm.
- Do not directly state the final answer.
- Use the student's exisiting code when deciding the next step.
- Keep the response to no more than two short sentences.
- Do not end with a guiding question.
- Return in markdown format with some highlights.
`.trim();
}