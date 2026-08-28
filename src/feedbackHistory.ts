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

// ---------------------------------------------------------------------------
// Scaffolding — Progressive Hint System
// ---------------------------------------------------------------------------

export type ScaffoldingTier = 'DIRECTION' | 'SPECIFIC' | 'GUIDED' | 'DETAILED';

/**
 * Determine the scaffolding tier based on attempt count and mistake patterns.
 *
 *  DIRECTION  — 1st attempt: brief directional hint
 *  SPECIFIC   — 2nd attempt: more specific, reference previous feedback
 *  GUIDED     — 3rd-4th attempt: concrete example / pseudocode hints
 *  DETAILED   — 5th+ attempt: step-by-step walkthrough (still no full solution)
 */
export function getScaffoldingTier(exerciseId: string): ScaffoldingTier {
  const history = getHistory(exerciseId);
  const attemptNumber = history.length + 1; // current attempt

  if (attemptNumber <= 1) return 'DIRECTION';
  if (attemptNumber <= 2) return 'SPECIFIC';
  if (attemptNumber <= 4) return 'GUIDED';
  return 'DETAILED';
}

/**
 * Detect if the student is repeating the same type of mistake.
 * Returns the repeated level if the last N attempts share the same level, or null.
 */
export function detectRepeatedMistake(exerciseId: string, windowSize: number = 2): string | null {
  const history = getHistory(exerciseId);
  if (history.length < windowSize) return null;

  const recent = history.slice(-windowSize);
  const levels = recent.map(r => r.level);
  const allSame = levels.every(l => l === levels[0]);

  if (allSame && levels[0] !== 'EXCELLENT' && levels[0] !== 'UNKNOWN') {
    return levels[0];
  }
  return null;
}

/**
 * Detect if the student is making progress (test pass rate improving).
 */
export function detectProgress(exerciseId: string): 'improving' | 'regressing' | 'stable' | 'none' {
  const history = getHistory(exerciseId);
  if (history.length < 2) return 'none';

  const recent = history.slice(-3); // look at last 3
  const rates = recent.map(r => {
    const total = r.testsPassed + r.testsFailed;
    return total > 0 ? r.testsPassed / total : 0;
  });

  if (rates.length >= 2) {
    const last = rates[rates.length - 1];
    const prev = rates[rates.length - 2];
    if (last > prev) return 'improving';
    if (last < prev) return 'regressing';
  }
  return 'stable';
}

/**
 * Generate explicit scaffolding instructions for the LLM prompt.
 * This tells the LLM exactly what depth of help to provide.
 */
export function formatScaffoldingInstructions(exerciseId: string): string {
  const history = getHistory(exerciseId);
  const attemptNumber = history.length + 1;
  const tier = getScaffoldingTier(exerciseId);
  const repeatedMistake = detectRepeatedMistake(exerciseId);
  const progress = detectProgress(exerciseId);

  const lines: string[] = [];
  lines.push(`### Scaffolding Instructions`);
  lines.push(`- **Current attempt**: #${attemptNumber}`);
  lines.push(`- **Scaffolding tier**: ${tier}`);

  if (repeatedMistake) {
    lines.push(`- ⚠️ **Repeated mistake detected**: Student has been stuck at [${repeatedMistake}] level for ${Math.min(history.length, 3)}+ consecutive attempts. They need a different angle of explanation.`);
  }

  if (progress === 'improving') {
    lines.push(`- 📈 **Progress detected**: Test pass rate is improving. Acknowledge this improvement!`);
  } else if (progress === 'regressing') {
    lines.push(`- 📉 **Regression detected**: Test pass rate decreased from previous attempt. The student may have introduced new bugs while fixing old ones.`);
  }

  lines.push('');

  switch (tier) {
    case 'DIRECTION':
      lines.push(`**DIRECTION tier (≤ 80 words)**: This is the student's first attempt.`);
      lines.push(`- Give a brief directional hint pointing at the CATEGORY of mistake`);
      lines.push(`- Do NOT explain the fix in detail`);
      lines.push(`- Example tone: "Your loop condition needs attention — think about what happens when the input is 0."`);
      break;

    case 'SPECIFIC':
      lines.push(`**SPECIFIC tier (≤ 100 words)**: This is the student's 2nd attempt.`);
      lines.push(`- Reference what was wrong in their previous attempt if the same issue persists`);
      lines.push(`- Name the specific line/concept that needs fixing (e.g., "your while condition on line 5")`);
      lines.push(`- Ask a Socratic question to guide their thinking`);
      lines.push(`- Example tone: "You fixed the syntax error — good progress! Now look at your while loop: what value does 'count' start at, and does that work when a=0?"`);
      break;

    case 'GUIDED':
      lines.push(`**GUIDED tier (≤ 150 words)**: The student has tried ${attemptNumber - 1} times already.`);
      lines.push(`- Explicitly name the concept they are missing`);
      lines.push(`- Provide a pseudocode hint or a small analogous example (NOT the actual solution)`);
      lines.push(`- Structure your hint as: (1) what's wrong, (2) the concept to review, (3) pseudocode pattern`);
      if (repeatedMistake) {
        lines.push(`- Since they're repeating [${repeatedMistake}], try a DIFFERENT explanation angle than previous feedback`);
      }
      lines.push(`- Example tone: "The issue is handling edge cases in your loop. Here's the pattern: first check if the input is a special case (like 0), handle it separately, then use your loop for everything else. Think: if a=0, how many digits does it have?"`);
      break;

    case 'DETAILED':
      lines.push(`**DETAILED tier (≤ 200 words)**: The student has tried ${attemptNumber - 1} times and needs significant help.`);
      lines.push(`- Give a step-by-step breakdown of the approach (without giving the final code)`);
      lines.push(`- Include a concrete pseudocode skeleton showing the structure`);
      lines.push(`- Point out exactly which part of their current code deviates from the correct approach`);
      lines.push(`- Be very explicit about the concept: define it, give a tiny example with numbers`);
      if (repeatedMistake) {
        lines.push(`- The student has been stuck at [${repeatedMistake}] for ${history.length} attempts. Consider explaining the concept from a completely different angle.`);
      }
      lines.push(`- Example pseudocode format:`);
      lines.push('  ```');
      lines.push(`  Step 1: Handle special case (a == 0 → return 1)`);
      lines.push(`  Step 2: Initialize counter = 0`);
      lines.push(`  Step 3: While a > 0: divide a by 10, increment counter`);
      lines.push(`  Step 4: Return counter`);
      lines.push('  ```');
      break;
  }

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

