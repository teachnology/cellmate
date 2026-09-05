// In this file, it uses LLM to generate the regular expression
// Define the structure of the student comment information
export interface StudentCommentInfo {
    text: string;
    lineIndex: number;
    codeOnLine?: string;
}

export function extractStudentComment(code: string): StudentCommentInfo[] {
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
        "exercise_id: ",
        "prompt_id: ",
        "write your answer to the exercise below"
    ];
    const isTemplateComment = templateComments.some(template => normalizedComment.startsWith(template));
    if (isTemplateComment) {
        return false; // It's a template comment
    }
    
    // Ignore commented-out assignment placeholders
    if (/^[A-Za-z_][A-Za-z0-9_]*\s*=\s*$/.test(comment.trim())) {
        return false;
    }
    return true; // Valid student comment
}
