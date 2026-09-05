import * as vscode from 'vscode';
import { StudentCommentInfo, extractStudentComment } from './commentUtils';
export type { StudentCommentInfo } from './commentUtils';
import { listLocalExercises } from './gitUtils';
import { extractExerciseId } from './promptUtils';

// This file, the idea uses workspace to store comment state comes from LLM.

// Collect exercise context from the notebook and the selected code cell
export interface ExerciseContext {
    exerciseId?: string;
    exerciseDescription?: string;
    exerciseConcept?: string[];
    studentCode: string;
    studentComment?: string;
    testFeedback?: string;
    studentCommentLine?: number;
    studentCommentCodeLine?: string;
}

// Additional information needed to save the comment state
export interface CollectedExerciseContext {
    context: ExerciseContext;
    currentCommentSnapshot: StudentCommentInfo[];
    commentStateKey: string;
}

// This function comes from LLM to store the comment state
export async function collectExerciseContext(
    cell: vscode.NotebookCell,
    extensionContext: vscode.ExtensionContext
): Promise<CollectedExerciseContext> {
    const studentCode = cell.document.getText();

    const exerciseId = extractExerciseId(studentCode) ?? findExerciseIdForCell(cell) ?? "";
    const exercises = await listLocalExercises();
    const exercise = exercises.find(ex => {return String(ex.id).trim() === exerciseId;});
    // Extract all valid comments currently in the student's code
    const currentComments = extractStudentComment(studentCode);
    // Load the previous comment snapshot for this cell
    const commentStateKey = getCommentStateKey(cell, exerciseId);
    const previousComments = extensionContext.workspaceState.get<StudentCommentInfo[]>(commentStateKey);
    const starterComments = exercise?.starterCode ? extractStudentComment(exercise.starterCode) : [];
    const baselineComments = previousComments ?? starterComments;
    const selectedComment = findNewOrChangedComment(currentComments, baselineComments);

    return {
        context: {
            exerciseId: exerciseId || undefined,
            exerciseDescription: exercise?.description ?? undefined,
            exerciseConcept: normalizeExpectedConcepts(exercise?.expectedConcept ?? exercise?.concept),
            studentCode,
            studentComment: selectedComment?.text,
            studentCommentLine: selectedComment?.lineIndex,
            studentCommentCodeLine: selectedComment?.codeOnLine,
        },
        currentCommentSnapshot: currentComments,
        commentStateKey
    };
}

function normalizeExpectedConcepts(concepts: string[] | string | undefined): string[] {
    if (!concepts) {
        return [];
    }

    if (typeof concepts === 'string') {
        return concepts.split(',').map(concept => concept.trim()).filter(concept => concept.length > 0);
    }
    return concepts.map(concept => concept.trim()).filter(concept => concept.length > 0);
}

function extractExerciseIdFromText(text: string): string | undefined {
    // <!-- Exercise_ID: 1.2 -->
    const markerMatch = text.match(
        /<!--\s*Exercise_ID:\s*([0-9]+(?:\.[0-9]+)*)\s*-->/i
    );
    if (markerMatch) {
        return markerMatch[1].trim();
    }

    // ### Exercise 1.2: Title, ## Exercise: 1.2
    const headingMatch = text.match(
        /^#{1,6}\s*Exercise\s*:?\s*([0-9]+(?:\.[0-9]+)*)\s*:?.*$/im
    );
    if (headingMatch) {
        return headingMatch[1].trim();
    }

    // # Exercise: 1.2
    const codeCommentMatch = text.match(
        /^#\s*Exercise\s*:?\s*([0-9]+(?:\.[0-9]+)*)\s*:?.*$/im
    );
    if (codeCommentMatch) {
        return codeCommentMatch[1].trim();
    }

    return undefined;
}


function findExerciseIdForCell(cell: vscode.NotebookCell): string | undefined {
    const notebook = cell.notebook;

    // First try current code cell
    const currentText = cell.document.getText();
    const currentCellId = extractExerciseIdFromText(currentText);
    if (currentCellId) {
        return currentCellId;
    }

    // Then search upward for the nearest markdown exercise cell
    for (let i = cell.index - 1; i >= 0; i--) {
        const previousCell = notebook.cellAt(i);
        if (previousCell.kind !== vscode.NotebookCellKind.Markup) {
            continue;
        }
        const markdownText = previousCell.document.getText();
        const exerciseId = extractExerciseIdFromText(markdownText);
        if (exerciseId) {
            return exerciseId;
        }
    }

    return undefined;
}

function normalizeCommentPart(value: string | undefined): string {
    return (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function isSameComment(currentComment: StudentCommentInfo, previousComment: StudentCommentInfo): boolean {
    const hasSameText = normalizeCommentPart(currentComment.text) === normalizeCommentPart(previousComment.text);
    const hasSameCodeOnLine = normalizeCommentPart(currentComment.codeOnLine) === normalizeCommentPart(previousComment.codeOnLine);
    return hasSameText && hasSameCodeOnLine;
}

function findNewOrChangedComment(
    currentComments: StudentCommentInfo[],
    previousComments: StudentCommentInfo[]
): StudentCommentInfo | undefined {
    // Case 1: There are no valid comments in the current cell
    if (currentComments.length === 0) {
        return undefined;
    }

    // Case 2: Find comments that were not present previously
    const newOrChangedComments = currentComments.filter(currentComment => {
        const alreadyProcessed = previousComments.some(
            previousComment => isSameComment(currentComment, previousComment)
        );
        return !alreadyProcessed;
    });

    // Case 3: No comment was newly added or modified
    if (newOrChangedComments.length === 0) {
        return undefined;
    }

    return newOrChangedComments[newOrChangedComments.length - 1]; // Return the last new or changed comment
}

// This function generated by LLM to store the CommentStateKey
function getCommentStateKey(cell: vscode.NotebookCell, exerciseId: string): string {
    const notebookUri = cell.notebook.uri.toString();

    return [
        "student-comment-snapshot",
        notebookUri,
        exerciseId,
        cell.index.toString()
    ].join(":");
}