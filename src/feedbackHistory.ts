/**
 * Feedback History — tracks student submissions per exercise for iterative learning.
 *
 * Records are persisted in vscode.ExtensionContext.workspaceState so they
 * survive VS Code restarts within the same workspace.
 */

import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FeedbackRecord {
  timestamp: number;
  exerciseId: string;
  /** First 500 chars of student code (enough for diff context, saves storage) */
  codeSnippet: string;
  /** Detected classification level from LLM response */
  level: string;
  /** First 300 chars of the LLM feedback */
  feedbackSnippet: string;
  testsPassed: number;
  testsFailed: number;
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

let _ctx: vscode.ExtensionContext | undefined;

/** Call once during activation to bind the extension context. */
export function initFeedbackHistory(ctx: vscode.ExtensionContext): void {
  _ctx = ctx;
}

function storageKey(exerciseId: string): string {
  return `cellmate_feedback_history_${exerciseId}`;
}

/**
 * Get all feedback records for a given exercise, newest last.
 */
export function getHistory(exerciseId: string): FeedbackRecord[] {
  if (!_ctx) return [];
  return _ctx.workspaceState.get<FeedbackRecord[]>(storageKey(exerciseId), []);
}

/**
 * Append a new record and persist.  Keeps at most 20 records per exercise.
 */
export async function addRecord(record: FeedbackRecord): Promise<void> {
  if (!_ctx) return;
  const key = storageKey(record.exerciseId);
  const history = _ctx.workspaceState.get<FeedbackRecord[]>(key, []);
  history.push(record);
  // Cap at 20 to avoid unbounded growth
  if (history.length > 20) {
    history.splice(0, history.length - 20);
  }
  await _ctx.workspaceState.update(key, history);
}

/**
 * Clear history for an exercise (e.g., when student wants a fresh start).
 */
export async function clearHistory(exerciseId: string): Promise<void> {
  if (!_ctx) return;
  await _ctx.workspaceState.update(storageKey(exerciseId), []);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Extract the classification level from an LLM feedback string.
 * Looks for patterns like [BROKEN], [FAILING], [IMPROPER], [EXCELLENT]
 * or the emoji-based variants.
 */
export function extractLevel(feedback: string): string {
  // Try bracket-based: [BROKEN], [FAILING], etc.
  const bracketMatch = feedback.match(/\[(BROKEN|FAILING|IMPROPER|EXCELLENT|TARGETED|TACTICAL|STRATEGIC|CONCEPTUAL)\]/i);
  if (bracketMatch) return bracketMatch[1].toUpperCase();

  // Try emoji-based: 🚨 TARGETED, 🤔 TACTICAL, etc.
  const emojiMatch = feedback.match(/(?:🚨|🤔|🏗️|💡|✅)\s*(TARGETED|TACTICAL|STRATEGIC|CONCEPTUAL|EXCELLENT)/i);
  if (emojiMatch) return emojiMatch[1].toUpperCase();

  return 'UNKNOWN';
}

/**
 * Build a human-readable submission history string for the prompt.
 * Returns empty string if no history exists.
 */
export function formatHistoryForPrompt(exerciseId: string): string {
  const history = getHistory(exerciseId);
  if (history.length === 0) return '';

  const lines: string[] = [];
  lines.push(`### Submission History (${history.length} previous attempt${history.length > 1 ? 's' : ''} for this exercise)`);

  for (let i = 0; i < history.length; i++) {
    const rec = history[i];
    const ago = formatTimeAgo(rec.timestamp);
    const testInfo = rec.testsPassed + rec.testsFailed > 0
      ? ` | Tests: ${rec.testsPassed}/${rec.testsPassed + rec.testsFailed} passed`
      : '';
    lines.push(`- Attempt ${i + 1} (${ago}): [${rec.level}]${testInfo} — ${rec.feedbackSnippet}`);
  }

  lines.push('');
  lines.push(`This is now attempt #${history.length + 1}. `
    + 'If the student is repeating the same mistake, be more explicit about the concept they are missing. '
    + 'If they are making progress, acknowledge their improvement.');

  return lines.join('\n');
}

/**
 * Format a timestamp as a relative time string.
 */
function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
