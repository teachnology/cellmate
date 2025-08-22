import * as vscode from 'vscode';

/**
 * Extract prompt ID from code comments
 */
export function extractPromptId(code: string): string | null {
  const m = code.match(/^[ \t]*#\s*PROMPT_ID\s*:\s*(.+)$/m);
  return m ? m[1].trim() : null;
}

/**
 * Extract exercise ID from code comments
 */
export function extractExerciseId(code: string): string | null {
  const m = code.match(/^\s*#\s*EXERCISE_ID\s*:\s*([A-Za-z0-9_\-]+)/m);
  return m ? m[1] : null;
}

/**
 * Get all placeholder keys from a template string
 */
export function getTemplatePlaceholderKeys(template: string): Set<string> {
  const keys = new Set<string>();
  const regex = /\{\{([\w\-:+=]+)\}\}/g;
  let match;
  while ((match = regex.exec(template)) !== null) {
    keys.add(match[1]);
  }
  return keys;
}

/**
 * Extract all cell prompt placeholder content, supporting <!-- prompt:key -->, # prompt:key, and multi-block sections
 */
export function extractPromptPlaceholders(notebook: vscode.NotebookDocument, currentCellIdx: number, placeholderKeys?: Set<string>): Map<string, string> {
  console.log('=== extractPromptPlaceholders START ===');
  console.log('Current cell index:', currentCellIdx);
  console.log('Total cells:', notebook.cellCount);

  const placeholderMap = new Map<string, string>();
  const htmlCommentRe = /<!--\s*prompt:\s*([\w\-]+)\s*-->/g;
  const hashCommentRe = /^\s*#\s*prompt:\s*([\w\-]+)\s*$/gm;
  const blockStartRe = /<!--\s*prompt:\s*([\w\-]+):start\s*-->/g;
  const blockEndRe = /<!--\s*prompt:\s*([\w\-]+):end\s*-->/g;

  // 1. Single cell comments
  console.log('\n--- 1. Scan single cell comments ---');
  // Scan from current cell upwards to find the nearest placeholder values
  for (let i = currentCellIdx; i >= 0; --i) {
    const cell = notebook.cellAt(i);
    const text = cell.document.getText();
    console.log(`Cell ${i} (${cell.kind === vscode.NotebookCellKind.Markup ? 'Markdown' : 'Code'}):`, text.substring(0, 100) + (text.length > 100 ? '...' : ''));

    let match: RegExpExecArray | null;
    // HTML comments
    while ((match = htmlCommentRe.exec(text)) !== null) {
      const key = match[1];
      console.log(`  Found HTML comment: prompt:${key}`);
      // Only set if this key hasn't been found yet (closest to current cell takes precedence)
      if (!placeholderMap.has(key)) {
        // Extract the content after the comment, not the whole cell
        const afterComment = text.substring(match.index + match[0].length).trim();
        placeholderMap.set(key, afterComment);
      }
    }
    // Hash (#) comments
    while ((match = hashCommentRe.exec(text)) !== null) {
      const key = match[1];
      console.log(`  Found hash comment: prompt:${key}`);
      // Only set if this key hasn't been found yet (closest to current cell takes precedence)
      if (!placeholderMap.has(key)) {
        // Extract the content after the comment, not the whole cell
        const afterComment = text.substring(match.index + match[0].length).trim();
        placeholderMap.set(key, afterComment);
      }
    }
  }

  // 2. Multi-block sections (allow auto-concatenation of multiple blocks for the same key)
  console.log('\n--- 2. Scan multi-block sections ---');
  for (let i = 0; i < notebook.cellCount; ++i) {
    const cell = notebook.cellAt(i);
    const text = cell.document.getText();
    let startMatch: RegExpExecArray | null;
    blockStartRe.lastIndex = 0;
    while ((startMatch = blockStartRe.exec(text)) !== null) {
      const key = startMatch[1];
      console.log(`  Found block start: prompt:${key}:start in cell ${i}`);

      // Find the corresponding end
      let content = '';
      let foundEnd = false;
      console.log(`    Searching for end marker across cells starting from cell ${i}`);
      for (let j = i; j < notebook.cellCount; ++j) {
        const c = notebook.cellAt(j);
        const t = c.document.getText();
        console.log(`    Checking cell ${j}:`, t.substring(0, 100) + (t.length > 100 ? '...' : ''));

        if (j === i) {
          // Content after start marker
          const afterStart = t.split(startMatch[0])[1] || '';
          content += afterStart + '\n';
          console.log(`    Added start cell content:`, afterStart.substring(0, 50) + (afterStart.length > 50 ? '...' : ''));
        } else {
          // Check for end
          blockEndRe.lastIndex = 0;
          let endMatch;
          if ((endMatch = blockEndRe.exec(t)) !== null && endMatch[1] === key) {
            // Content before end marker
            const beforeEnd = t.split(endMatch[0])[0] || '';
            content += beforeEnd + '\n';
            foundEnd = true;
            console.log(`    Found block end: prompt:${key}:end in cell ${j}`);
            console.log(`    Added end cell content:`, beforeEnd.substring(0, 50) + (beforeEnd.length > 50 ? '...' : ''));
            break;
          } else {
            // If this cell has no end marker, add the entire cell's content
            content += t + '\n';
            console.log(`    Added full cell ${j} content:`, t.substring(0, 50) + (t.length > 50 ? '...' : ''));
          }
        }
      }
      if (foundEnd) {
        // Auto-concatenate multi-block
        const prev = placeholderMap.get(key) || '';
        const newContent = prev + content.trim() + '\n';
        placeholderMap.set(key, newContent);
        console.log(`    Block content for ${key}:`, newContent.substring(0, 100) + (newContent.length > 100 ? '...' : ''));
      } else {
        console.log(`    Warning: No matching end for block ${key}`);
      }
    }
  }

  // 3. Scan special cell reference placeholders (cell:1, cell:2, ..., cell:N, cell:this, cell:-1, cell:+1)
  console.log('\n--- 3. Scan special cell reference placeholders ---');
  const cellRefPatterns = [
    /prompt:\s*(cell:this)/,

    // With type filter, must appear after prompt marker
    /prompt:\s*(cell:-?\d+:(md|cd))/, // # prompt: cell:-1:md, <!-- prompt: cell:+1:cd -->
    /prompt:\s*(cell:\+\d+:(md|cd))/, // # prompt: cell:+1:md, <!-- prompt: cell:+2:cd -->
    /prompt:\s*(cell:[1-9]\d*:(md|cd))/, // # prompt: cell:1:md, <!-- prompt: cell:2:cd -->

    // Without type, no colon allowed after, must appear after prompt marker
    /prompt:\s*(cell:-?\d+(?!:))/, // # prompt: cell:-1, <!-- prompt: cell:+1 -->
    /prompt:\s*(cell:\+\d+(?!:))/, // # prompt: cell:+1, <!-- prompt: cell:+2 -->
    /prompt:\s*(cell:[1-9]\d*(?!:))/ // # prompt: cell:1, <!-- prompt: cell:2 -->
  ];

  for (let i = 0; i < notebook.cellCount; ++i) {
    const cell = notebook.cellAt(i);
    const text = cell.document.getText();

    for (const pattern of cellRefPatterns) {
      const matches = text.match(pattern);
      if (matches) {
        matches.forEach(match => {
          // 提取 prompt: 后面的实际 key
          const key = match.replace(/^prompt:\s*/, '');
          // 只处理模板中出现的 key
          if (!placeholderKeys || placeholderKeys.has(key)) {
            console.log(`  Found cell reference: ${key} in cell ${i} (from: ${match})`);
            // Mark the found cell reference as declared, but do not set a specific value
            placeholderMap.set(key, '');
          }
        });
      }
    }
  }

  // 4. Record current cell index for cell:this
  placeholderMap.set('__currentCellIdx__', String(currentCellIdx));

  console.log('\n--- Final placeholder map ---');
  for (const [key, value] of placeholderMap.entries()) {
    if (key !== '__currentCellIdx__') {
      console.log(`  ${key}:`, value.substring(0, 100) + (value.length > 100 ? '...' : ''));
    }
  }
  console.log('=== extractPromptPlaceholders END ===\n');

  return placeholderMap;
}

/**
 * Fill the template, only replace the placeholders that are declared in the notebook
 */
export function fillPromptTemplate(template: string, placeholderMap: Map<string, string>, notebook: vscode.NotebookDocument): string {
  let result = template.replace(/\{\{([\w\-:+=]+)\}\}/g, (m, key) => {
    let cellMatch;
    console.log(`  Processing placeholder: {{${key}}}`);

    // only replace the placeholders that are declared in the notebook
    if (placeholderMap.has(key)) {
      // for special cell reference placeholders, need to dynamically calculate the content
      if (key.startsWith('cell:')) {
        const currentIdx = Number(placeholderMap.get('__currentCellIdx__') || 0);
        console.log(`    Processing cell reference: ${key}, current index: ${currentIdx}`);
        // 1. 相对cell: cell:+N:md / cell:-N:cd
        if ((cellMatch = key.match(/^cell:([+-]\d+):(md|cd)$/))) {
          const rel = Number(cellMatch[1]);
          const type = cellMatch[2];
          let foundIdx = -1;
          let count = Math.abs(rel);
          if (rel > 0) {
            // Search downward
            for (let i = currentIdx + 1; i < notebook.cellCount; ++i) {
              const cell = notebook.cellAt(i);
              if ((type === 'md' && cell.kind === vscode.NotebookCellKind.Markup) ||
                  (type === 'cd' && cell.kind === vscode.NotebookCellKind.Code)) {
                count--;
                if (count === 0) {
                  foundIdx = i;
                  break;
                }
              }
            }
          } else {
            // Search upward
            for (let i = currentIdx - 1; i >= 0; --i) {
              const cell = notebook.cellAt(i);
              if ((type === 'md' && cell.kind === vscode.NotebookCellKind.Markup) ||
                  (type === 'cd' && cell.kind === vscode.NotebookCellKind.Code)) {
                count--;
                if (count === 0) {
                  foundIdx = i;
                  break;
                }
              }
            }
          }
          if (foundIdx >= 0 && foundIdx < notebook.cellCount) {
            const content = notebook.cellAt(foundIdx).document.getText();
            console.log(`    Found ${type} cell at index ${foundIdx}:`, content.substring(0, 50) + (content.length > 50 ? '...' : ''));
            return content;
          } else {
            console.log(`    No matching ${type} cell found for ${key}`);
            return '';
          }
        }
        // 2. 简单相对cell: cell:-1, cell:+1 (不区分类型)
        else if ((cellMatch = key.match(/^cell:([+-]\d+)$/))) {
          const rel = Number(cellMatch[1]);
          const targetIdx = currentIdx + rel;
          if (targetIdx >= 0 && targetIdx < notebook.cellCount) {
            const content = notebook.cellAt(targetIdx).document.getText();
            console.log(`    Found cell at index ${targetIdx}:`, content.substring(0, 50) + (content.length > 50 ? '...' : ''));
            return content;
          } else {
            console.log(`    No matching cell found for ${key}`);
            return '';
          }
        }
        // 3. 绝对cell: cell:N / cell:N:md / cell:N:cd
        else if ((cellMatch = key.match(/^cell:(\d+)(?::(md|cd))?$/))) {
          const absIdx = Number(cellMatch[1]);
          const type = cellMatch[2]; // 可能为 undefined
          let foundIdx = -1, count = 0;
          for (let i = 0; i < notebook.cellCount; ++i) {
            const cell = notebook.cellAt(i);
            if (!type || (type === 'md' && cell.kind === vscode.NotebookCellKind.Markup) ||
                (type === 'cd' && cell.kind === vscode.NotebookCellKind.Code)) {
              count++;
              if (count === absIdx) {
                foundIdx = i;
                break;
              }
            }
          }
          if (foundIdx >= 0 && foundIdx < notebook.cellCount) {
            const content = notebook.cellAt(foundIdx).document.getText();
            console.log(`    Found cell at index ${foundIdx}:`, content.substring(0, 50) + (content.length > 50 ? '...' : ''));
            return content;
          } else {
            console.log(`    No matching cell found for ${key}`);
            return '';
          }
        }
      }

      // for normal placeholders, just return the value
      const value = placeholderMap.get(key) ?? '';
      console.log(`    Found in placeholderMap: ${key} ->`, value.substring(0, 50) + (value.length > 50 ? '...' : ''));
      return value;
    }

    console.log(`    Placeholder not declared in notebook, replacing with empty string: {{${key}}}`);
    return ''; // return empty string
  });

  console.log('Template after replacement:', result.substring(0, 200) + (result.length > 200 ? '...' : ''));
  console.log('=== fillPromptTemplate END ===\n');

  // combine multiple empty lines into one
  result = result.replace(/([ \t]*\n){3,}/g, '\n\n');

  return result;
} 