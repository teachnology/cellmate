import * as vscode from 'vscode';

// Define the structure of the student comment information
export interface StudentCommentInfo {
    text: string;
    lineIndex: number;
    codeOnLine?: string;
}

// Collect exercise context from the notebook and the selected code cell
export interface ExerciseContext {
    studentCode: string;
    studentComment?: string;
    isDefaultComment: boolean;
    hasNewStudentComment: boolean;
    shownError?: string;
    codeCellIndex: number;
    studentCommentLine?: number;
    studentCommentCodeLine?: string;
}

// Additional information needed to save the comment state
export interface CollectedExerciseContext {
    context: ExerciseContext;
    currentCommentSnapshot: StudentCommentInfo[];
    commentStateKey: string;
}

const DEFAULT_STUDENT_COMMENT = 'I do not know how to process';

export function collectExerciseContext(
    cell: vscode.NotebookCell,
    extensionContext: vscode.ExtensionContext
): CollectedExerciseContext {
    const studentCode = cell.document.getText();
    const currentComments = extractStudentComment(studentCode);
    const commentStateKey = getCommentStateKey(cell);
    const previousComments = extensionContext.workspaceState.get<StudentCommentInfo[]>(commentStateKey, []);
    const selectedComment = findNewOrChangedComment(currentComments, previousComments);
    const hasNewStudentComment = selectedComment !== undefined;
    
    const studentComment = selectedComment?.text ?? DEFAULT_STUDENT_COMMENT;
    const isDefaultComment = studentComment === undefined;

    return {
        context: {
            studentCode,
            studentComment,
            isDefaultComment,
            hasNewStudentComment,
            codeCellIndex: cell.index,
            studentCommentLine: selectedComment?.lineIndex,
            studentCommentCodeLine: selectedComment?.codeOnLine,
        },
        currentCommentSnapshot: currentComments,
        commentStateKey
    };
}

function extractStudentComment(code: string): StudentCommentInfo[] {
    const lines = code.split("\n");
    const comments: StudentCommentInfo[] = [];

    // The code cell is completely empty
    if (lines.length === 0 || lines.every(line => line.trim().length === 0)) {
        return comments;
    }

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const originalLine = lines[lineIndex];
        // Skip empty lines
        if (originalLine.trim().length === 0) {
            continue;
        }

        const commentStart = findPythonCommentStart(originalLine);
        // The line does not contain a comment
        if (commentStart === -1) {
            continue;
        }

        const codeOnLine = originalLine.slice(0, commentStart).trim();
        const commentText = originalLine.slice(commentStart + 1).trim();
        // The comment is empty or is a tamplate comment
        if (!isValidStudentComment(commentText)) {
            continue;
        }

        // Add the valid comment to the list
        comments.push({
            text: commentText,
            lineIndex: lineIndex,
            codeOnLine: codeOnLine.length > 0 ? codeOnLine : undefined,
        }); 
    }
    return comments;
} 

function findPythonCommentStart(line: string): number {
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let escaped = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (char === "\\") {
            escaped = true;
            continue;
        }
        if (char === "'" && !inDoubleQuote) {
            inSingleQuote = !inSingleQuote;
            continue;
        }
        if (char === '"' && !inSingleQuote) {
            inDoubleQuote = !inDoubleQuote;
            continue;
        }
        if (char === "#" && !inSingleQuote && !inDoubleQuote) {
            return i; // Found a comment start
        }
    }
    return -1; // No comment found
}

function isValidStudentComment(comment: string): boolean {
    const normalizedComment = comment.trim().replace(/\s+/g, " ").toLowerCase();

    if (normalizedComment.length === 0) {
        return false; // Empty comment
    }

    const templateComments = [
        "exercise: ",
        "write your answer to the exercise below"
    ];

    const isTemplateComment = templateComments.some(template => normalizedComment.startsWith(template));

    if (isTemplateComment) {
        return false; // It's a template comment
    }

    return true; // Valid student comment
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

function getCommentStateKey(cell: vscode.NotebookCell): string {
    const notebookUri = cell.notebook.uri.toString();

    return [
        "student-comment-snapshot",
        notebookUri,
        cell.index.toString()
    ].join(":");
}