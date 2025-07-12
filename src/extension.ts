import * as vscode from 'vscode';
import * as fs from 'fs';
import { existsSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as cp from 'child_process';
import axios from 'axios';
import simpleGit, { SimpleGit } from 'simple-git';
import * as tmp from 'tmp';

const GIT_REPO_URL = 'https://github.com/teachnology/promptfolio.git';
// const GIT_REPO_URL = 'https://github.com/esemsc-hz2024/promptfolio.git';
const LOCAL_REPO_PATH = path.join(os.tmpdir(), 'promptfolio_repo');


async function isValidRepo(dir: string): Promise<boolean> {
  const git: SimpleGit = simpleGit(dir);
  try {
    await git.revparse(['--is-inside-work-tree']);
    return true;                      // normal git package
  } catch {
    return false;                     // rev-parse fail => not valid
  }
}

async function syncGitRepo(): Promise<void> {
  const repoOk = existsSync(LOCAL_REPO_PATH) && await isValidRepo(LOCAL_REPO_PATH);

  if (!repoOk) {
    await fs.promises.rm(LOCAL_REPO_PATH, { recursive: true, force: true }).catch(() => {});
    await simpleGit().clone(GIT_REPO_URL, LOCAL_REPO_PATH, ['--depth', '1']);
    return;
  }

  try {
    await simpleGit(LOCAL_REPO_PATH).pull();
  } catch (err) {
    console.warn('pull failed, re-clone:', err);
    await fs.promises.rm(LOCAL_REPO_PATH, { recursive: true, force: true });
    await simpleGit().clone(GIT_REPO_URL, LOCAL_REPO_PATH, ['--depth', '1']);
  }
}

// async function syncGitRepo(): Promise<void> {
//   await fs.promises.rm(LOCAL_REPO_PATH, { recursive: true, force: true }).catch(()=>{});
//   await simpleGit().clone(GIT_REPO_URL, LOCAL_REPO_PATH, ['--depth','1']);
// }

async function getPromptContent(promptId: string): Promise<string> {
  const promptPath = path.join(LOCAL_REPO_PATH, 'prompts', `${promptId}.txt`);
  if (!fs.existsSync(promptPath)) throw new Error(`Prompt file ${promptId}.txt not found`);
  return fs.readFileSync(promptPath, 'utf8');
}

async function getTestFiles(exerciseId: string): Promise<{ test: string, metadata: any }> {
  const testDir = path.join(LOCAL_REPO_PATH, 'tests', exerciseId);
  const testFile = fs.readdirSync(testDir).find(f => f.startsWith('test_') && f.endsWith('.py'));
  const metadataFile = path.join(testDir, 'metadata.json');
  if (!testFile || !fs.existsSync(metadataFile)) throw new Error('Test or metadata not found');
  return {
    test: fs.readFileSync(path.join(testDir, testFile), 'utf8'),
    metadata: JSON.parse(fs.readFileSync(metadataFile, 'utf8'))
  };
}

// get notebook python path
async function getNotebookPythonPath(): Promise<string | undefined> {
  const editor = vscode.window.activeNotebookEditor;
  if (!editor) {
    return;
  }

  // activate Python extension API
  const pyExt = vscode.extensions.getExtension('ms-python.python');
  if (!pyExt) {
    return;
  }
  await pyExt.activate();
  const pyApi = pyExt.exports;

  // API file: https://github.com/microsoft/vscode-python/blob/main/src/api.ts
  const execCmd = pyApi.settings.getExecutionDetails(editor.notebook.uri).execCommand;
  return execCmd?.[0]; // execCmd [ '/Users/xxx/miniconda3/envs/py39/bin/python', ... ]
}

// check if python package is installed
function checkPytestInstalled(pythonPath: string, pkg: string): Promise<boolean> {
  return new Promise((resolve) => {
    cp.execFile(pythonPath, ['-m', 'pip', 'show', pkg], (err, stdout) => {
      resolve(!!stdout && !err && stdout.includes(`Name: ${pkg}`));
    });
  });
}

// auto install python dependencies
function ensurePythonDeps(pythonPath: string, pkgs: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    cp.execFile(pythonPath, ['-m', 'pip', 'install', ...pkgs], (err, stdout, stderr) => {
      if (err) {
        vscode.window.showErrorMessage(`install dependencies failed: ${stderr || err.message}`);
        resolve(false);
      } else {
        vscode.window.showInformationMessage(`installed: ${pkgs.join(', ')}`);
        resolve(true);
      }
    });
  });
}

async function runLocalTest(code: string, test: string, pythonPath: string): Promise<any> {
  // Create temporary directory
  const tmpDir = tmp.dirSync({ unsafeCleanup: true });
  const codePath = path.join(tmpDir.name, 'submission.py');
  const testPath = path.join(tmpDir.name, 'test_hidden.py');
  const reportPath = path.join(tmpDir.name, 'report.json');

  // Write user code and test code
  fs.writeFileSync(codePath, code, 'utf8');
  fs.writeFileSync(testPath, test, 'utf8');

  // Call pytest
  return new Promise((resolve) => {
    const cmd = [
      pythonPath, '-m', 'pytest', testPath,
      '--json-report', `--json-report-file=${reportPath}`,
      '--tb=short', '-v'
    ];
    const proc = cp.spawn(cmd[0], cmd.slice(1), { cwd: tmpDir.name });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (data) => stdout += data.toString());
    proc.stderr.on('data', (data) => stderr += data.toString());

    proc.on('close', () => {
      let report = {};
      if (fs.existsSync(reportPath)) {
        report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      }
      tmpDir.removeCallback();
      resolve({ stdout, stderr, report });
    });
  });
}

async function listLocalExercises(): Promise<any[]> {
  const exercisesDir = path.join(LOCAL_REPO_PATH, 'tests');
  if (!fs.existsSync(exercisesDir)) return [];
  const exerciseIds = fs.readdirSync(exercisesDir).filter(f => fs.statSync(path.join(exercisesDir, f)).isDirectory());
  return exerciseIds.map(id => {
    const metaPath = path.join(exercisesDir, id, 'metadata.json');
    let meta = {};
    if (fs.existsSync(metaPath)) {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    }
    return { id, ...meta };
  });
}

async function listLocalTemplates(): Promise<any[]> {
  const promptsDir = path.join(LOCAL_REPO_PATH, 'prompts');
  if (!fs.existsSync(promptsDir)) return [];
  return fs.readdirSync(promptsDir)
    .filter(f => f.endsWith('.txt'))
    .map(f => ({
      id: path.basename(f, '.txt'),
      filename: f
    }));
}

// Helper function: Extract error message
function extractErrorMessage(test: any): string {
  // Try to get error message from call.longrepr (most common for assertion errors)
  const call = test.call;
  if (call && typeof call === 'object') {
    const longrepr = call.longrepr;
    if (typeof longrepr === 'string' && longrepr.trim()) {
      return longrepr.trim();
    }
  }
  
  // Try to get from longrepr at test level
  const longrepr = test.longrepr;
  if (typeof longrepr === 'string' && longrepr.trim()) {
    return longrepr.trim();
  } else if (longrepr && typeof longrepr === 'object') {
    const msg = longrepr.longrepr || longrepr.reprcrash?.message || '';
    if (msg) return msg.trim();
  }
  
  // Try to get from setup or teardown
  for (const phase of ['setup', 'teardown']) {
    const phaseData = test[phase];
    if (phaseData && typeof phaseData === 'object') {
      const msg = phaseData.longrepr;
      if (typeof msg === 'string' && msg.trim()) {
        return msg.trim();
      }
    }
  }
  
  // Fallback to test name and outcome
  const testName = test.nodeid?.split('::').pop() || 'Unknown Test';
  const outcome = test.outcome || 'failed';
  return `${testName} ${outcome}`;
}

// Helper function: Extract expected value
function extractExpectedValue(errorMessage: string): string {
  const patterns = [
    /should return (\d+)/i,      // "should return 5"
    /expected (\d+)/i,           // "expected 5"
    /assert \d+ == (\d+)/i,      // "assert 0 == 5"
    /Expected:\s*(\d+)/i,        // "Expected: 5"
    /expected\s+([^,\n]+)/i,     // "expected True"
    /should be\s+([^,\n]+)/i,    // "should be True"
  ];
  
  for (const pattern of patterns) {
    const match = errorMessage.match(pattern);
    if (match) {
      return match[1].trim();
    }
  }
  
  return '';
}

// Helper function: Extract actual value
function extractActualValue(errorMessage: string): string {
  const patterns = [
    /but got (\d+)/i,            // "but got 0"
    /got (\d+)/i,                // "got 0"
    /assert (\d+) == \d+/i,      // "assert 0 == 5"
    /Actual:\s*(\d+)/i,          // "Actual: 0"
    /got\s+([^,\n]+)/i,          // "got False"
    /returned\s+([^,\n]+)/i,     // "returned False"
  ];
  
  for (const pattern of patterns) {
    const match = errorMessage.match(pattern);
    if (match) {
      return match[1].trim();
    }
  }
  
  return '';
}

// Helper function: Generate improvement suggestions
function generateSuggestions(failedTests: any[], metadata: any): string[] {
  const suggestions = new Set<string>();
  
  for (const test of failedTests) {
    const errorMessage = extractErrorMessage(test);
    
    if (errorMessage.includes('NotImplementedError')) {
      suggestions.add('Please ensure the required function is defined');
    } else if (errorMessage.includes('TypeError')) {
      suggestions.add('Please check function parameter types and count');
    } else if (errorMessage.includes('RecursionError')) {
      suggestions.add('Recursion depth too large, consider using iteration');
    } else if (errorMessage.includes('AssertionError')) {
      suggestions.add('Please check if the function return value is correct');
    } else if (errorMessage.includes('NameError')) {
      suggestions.add('Please check if the function name is correct');
    } else if (errorMessage.includes('IndentationError')) {
      suggestions.add('Please check if the code indentation is correct');
    } else if (errorMessage.includes('SyntaxError')) {
      suggestions.add('Please check if the code syntax is correct');
    } else if (errorMessage.toLowerCase().includes('timeout')) {
      suggestions.add('Code execution timeout, possible infinite loop');
    }
  }
  
  // Add hints from metadata
  const hints = metadata?.hints || [];
  hints.slice(0, 2).forEach((hint: string) => suggestions.add(hint));
  
  return Array.from(suggestions);
}

// Helper function: Generate concise test summary
function generateConciseTestSummary(failedTests: any[], totalTests: number): string {
  if (failedTests.length === 0) {
    return '';
  }
  
  const passed = totalTests - failedTests.length;
  const successRate = Math.round((passed / totalTests) * 100);
  
  // Extract test cases with expected vs actual values
  const testCases = [];
  
  for (const test of failedTests) {
    const testName = test.nodeid.split('::').pop() || 'Unknown Test';
    const errorMessage = extractErrorMessage(test);
    const expectedValue = extractExpectedValue(errorMessage);
    const actualValue = extractActualValue(errorMessage);
    
    // Try to extract input parameter from test name
    let inputParam = '';
    const inputMatch = testName.match(/\((\d+)\)/);
    if (inputMatch) {
      inputParam = inputMatch[1];
    }
    
    if (expectedValue && actualValue) {
      testCases.push({
        test: testName,
        input: inputParam,
        expected: expectedValue,
        actual: actualValue
      });
    }
  }
  
  // Select representative cases (first 2 with different patterns)
  const representativeCases = [];
  const seenPatterns = new Set();
  
  for (const testCase of testCases) {
    const pattern = `${testCase.expected}-${testCase.actual}`;
    if (representativeCases.length < 2 && !seenPatterns.has(pattern)) {
      representativeCases.push(testCase);
      seenPatterns.add(pattern);
    }
  }
  
  // Generate summary
  let summary = `## Test Summary\n`;
  summary += `- ${totalTests} tests, ${passed} passed, ${failedTests.length} failed (${successRate}%)\n\n`;
  
  if (representativeCases.length > 0) {
    summary += `### Representative Failures\n`;
    summary += `| Test | n | Expected | Actual |\n`;
    summary += `|:----:|:--:|:--------:|:------:|\n`;
    
    for (const testCase of representativeCases) {
      // Extract function name and parameter for cleaner display
      const funcMatch = testCase.test.match(/^(\w+)\((\d+)\)$/);
      if (funcMatch) {
        summary += `| ${funcMatch[1]}(${funcMatch[2]}) | ${funcMatch[2]} | ${testCase.expected} | ${testCase.actual} |\n`;
      } else {
        summary += `| ${testCase.test} | ${testCase.input} | ${testCase.expected} | ${testCase.actual} |\n`;
      }
    }
    summary += `\n`;
  }
  
  return summary;
}

function extractPromptId(code: string): string | null {
  const m = code.match(/^[ \t]*#\s*PROMPT_ID\s*:\s*(.+)$/m);
  return m ? m[1].trim() : null;
}

function extractExerciseId(code: string): string | null {
  const m = code.match(/^\s*#\s*EXERCISE_ID\s*:\s*([A-Za-z0-9_\-]+)/m);
  return m ? m[1] : null;
}

// ───────────────────────────────────────────────────────────
// delete ANSI code
function stripAnsi(str: string): string {
  // match 0x1B  CSI / OSC sequence
  return str.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

/**
 * read cell output
 * - support stdout / stderr
 *   (application/vnd.code.notebook.{stdout|stderr})
 * - support text/plain
 * - support error item (application/vnd.code.notebook.error)
 *   delete ANSI code
 */
function getCellOutput(
  cell: vscode.NotebookCell
): { hasOutput: boolean; output: string; executionError: boolean } {
  let outputText = '';
  let hasOutput = false;
  let executionError = false;

  const decoder = new TextDecoder();

  for (const output of cell.outputs ?? []) {
    hasOutput = true;

    for (const item of output.items) {
      const mime = item.mime;
      const raw = decoder.decode(item.data);

      // ── 1. normal text / stdout / stderr ──────────────────────
      if (
        mime === 'text/plain' ||
        mime === 'application/vnd.code.notebook.stdout' ||
        mime === 'application/vnd.code.notebook.stderr'
      ) {
        outputText += stripAnsi(raw) + '\n';
        continue;
      }

      // ── 2. execution error object ─────────────────────────────────
      if (mime === 'application/vnd.code.notebook.error') {
        try {
          const errObj = JSON.parse(raw);
          const pretty =
            `${errObj.name}: ${errObj.message}\n` +
            stripAnsi(errObj.stack || '');
          outputText += '[ERROR] ' + pretty + '\n';
        } catch {
          // JSON 解析失败时退化为原始字符串
          outputText += '[ERROR] ' + stripAnsi(raw) + '\n';
        }
        executionError = true;
        continue;
      }

      // ── 3. text/html to text ────────────────────────
      if (mime === 'text/html') {
        const textOnly = raw.replace(/<[^>]*>/g, '');
        outputText += stripAnsi(textOnly) + '\n';
        continue;
      }

      // ── 4. other types ────────────────────────
      outputText += stripAnsi(raw) + '\n';
    }
  }

  return { hasOutput, output: outputText.trim(), executionError };
}

// insert markdown cell below the specified cell
async function insertMarkdownCellBelow(notebook: vscode.NotebookDocument, cellIndex: number, content: string) {
  const edit = new vscode.WorkspaceEdit();
  const newCell = new vscode.NotebookCellData(
    vscode.NotebookCellKind.Markup,
    content,
    'markdown'
  );
  // insert at cellIndex+1
  const notebookEdit = vscode.NotebookEdit.insertCells(cellIndex + 1, [newCell]);
  edit.set(notebook.uri, [notebookEdit]);
  await vscode.workspace.applyEdit(edit);
}

// 提取所有 cell 的 prompt 占位符内容，支持 <!-- prompt:key -->、# prompt:key、以及多段区块
function extractPromptPlaceholders(notebook: vscode.NotebookDocument, currentCellIdx: number, placeholderKeys?: Set<string>): Map<string, string> {
  console.log('=== extractPromptPlaceholders START ===');
  console.log('Current cell index:', currentCellIdx);
  console.log('Total cells:', notebook.cellCount);
  
  const placeholderMap = new Map<string, string>();
  const htmlCommentRe = /<!--\s*prompt:([\w\-]+)\s*-->/g;
  const hashCommentRe = /^\s*#\s*prompt:([\w\-]+)\s*$/gm;
  const blockStartRe = /<!--\s*prompt:([\w\-]+):start\s*-->/g;
  const blockEndRe = /<!--\s*prompt:([\w\-]+):end\s*-->/g;

  // 1. 单 cell 注释
  console.log('\n--- 1. Scan single cell comments ---');
  for (let i = 0; i < notebook.cellCount; ++i) {
    const cell = notebook.cellAt(i);
    const text = cell.document.getText();
    console.log(`Cell ${i} (${cell.kind === vscode.NotebookCellKind.Markup ? 'Markdown' : 'Code'}):`, text.substring(0, 100) + (text.length > 100 ? '...' : ''));
    
    let match: RegExpExecArray | null;
    // HTML 注释
    while ((match = htmlCommentRe.exec(text)) !== null) {
      const key = match[1];
      console.log(`  Found HTML comment: prompt:${key}`);
      // 提取注释后面的内容，而不是整个 cell
      const afterComment = text.substring(match.index + match[0].length).trim();
      placeholderMap.set(key, afterComment);
    }
    // # 注释
    while ((match = hashCommentRe.exec(text)) !== null) {
      const key = match[1];
      console.log(`  Found hash comment: prompt:${key}`);
      // 提取注释后面的内容，而不是整个 cell
      const afterComment = text.substring(match.index + match[0].length).trim();
      placeholderMap.set(key, afterComment);
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
    
    // 带类型过滤，必须出现在 prompt 标记后面
    /prompt:\s*(cell:-?\d+:(md|cd))/, // # prompt: cell:-1:md, <!-- prompt: cell:+1:cd -->
    /prompt:\s*(cell:\+\d+:(md|cd))/, // # prompt: cell:+1:md, <!-- prompt: cell:+2:cd -->
    /prompt:\s*(cell:[1-9]\d*:(md|cd))/, // # prompt: cell:1:md, <!-- prompt: cell:2:cd -->
    
    // 不带类型，后面禁止再出现冒号，必须出现在 prompt 标记后面
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

// 1. 提取模板中的所有占位符 key
function getTemplatePlaceholderKeys(template: string): Set<string> {
  const keys = new Set<string>();
  const regex = /\{\{([\w\-:+=]+)\}\}/g;
  let match;
  while ((match = regex.exec(template)) !== null) {
    keys.add(match[1]);
  }
  return keys;
}

// fill the template, only replace the placeholders that are declared in the notebook
function fillPromptTemplate(template: string, placeholderMap: Map<string, string>, notebook: vscode.NotebookDocument): string {  
  const result = template.replace(/\{\{([\w\-:+=]+)\}\}/g, (m, key) => {
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
  
  return result;
}

export function activate(ctx: vscode.ExtensionContext) {
  const provider: vscode.NotebookCellStatusBarItemProvider = {
    provideCellStatusBarItems(cell) {
      if (cell.document.languageId !== 'python') {
        return [];
      }
      const item = new vscode.NotebookCellStatusBarItem(
        '$(zap) 🧠 AI Feedback',
        vscode.NotebookCellStatusBarAlignment.Right
      );
      item.priority = 100;
      item.command = {
        command: 'jupyterAiFeedback.sendNotebookCell',
        title: 'Send to AI',
        arguments: [cell]
      };
      return [item];
    }
  };
  ctx.subscriptions.push(
    vscode.notebooks.registerNotebookCellStatusBarItemProvider('*', provider)
  );

  // Command executed when button is clicked
  ctx.subscriptions.push(
    vscode.commands.registerCommand(
      'jupyterAiFeedback.sendNotebookCell',
      async (cell: vscode.NotebookCell) => {
        const editor = vscode.window.activeNotebookEditor;
        if (!editor) {
          return vscode.window.showErrorMessage('No active Notebook editor');
        }

        // Read user configuration
        const cfg = vscode.workspace.getConfiguration('jupyterAiFeedback');
        const apiUrl = cfg.get<string>('apiUrl') || '';
        const apiKey = cfg.get<string>('apiKey') || '';
        const modelName = cfg.get<string>('modelName') || '';
        const templateId = cfg.get<string>('templateId', '1');
        const useHiddenTests = cfg.get<boolean>('useHiddenTests', true);
        
        // Debug configuration
        console.log('=== Configuration Debug ===');
        console.log('All jupyterAiFeedback config:', cfg);
        console.log('useHiddenTests raw value:', cfg.get('useHiddenTests'));
        console.log('useHiddenTests with default:', useHiddenTests);
        console.log('Configuration source:', cfg.inspect('useHiddenTests'));
        console.log('=== End Debug ===');
        console.log('templateId:', templateId);
        console.log('useHiddenTests:', useHiddenTests);
        console.log('modelName:', modelName);

        if (!apiUrl || !apiKey || !modelName) {
          return vscode.window.showErrorMessage(
            'Please configure jupyterAiFeedback.apiUrl, apiKey, and modelName in settings'
          );
        }
        
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath || '';

        // Get code from cell
        const code = cell.document.getText();
        
        // 1. Sync GitHub repository
        await syncGitRepo();

        // 2. Get prompt content
        const promptIdFromCell = extractPromptId(code);
        const promptId = promptIdFromCell || cfg.get<string>('templateId', '');

        // check if prompt id exists in local prompt list
        const templates = await listLocalTemplates();
        const promptExists = templates.some(t => t.id === promptId);

        if (!promptExists) {
          vscode.window.showErrorMessage(`Prompt ID "${promptId}" not found in the prompt repository`);
          return;
        }

        const promptContent = await getPromptContent(promptId);

        // 3. Initialize analysis variable
        let analysis = '';
        
        // 4. If useHiddenTests is enabled, get test content and run tests
        if (useHiddenTests) {
          const exId = extractExerciseId(code);
          if (!exId) {
            vscode.window.showWarningMessage('No # EXERCISE_ID found in code');
            return;
          }
          const { test, metadata } = await getTestFiles(exId);

          // Get notebook Python path
          const pythonPath = await getNotebookPythonPath();
          console.log("pythonPath:", pythonPath)
          if (!pythonPath) {
            vscode.window.showErrorMessage('cannot detect the Python environment of the current Notebook, please select the kernel first');
            return;
          }

          const requiredPkgs = ['pytest', 'pytest-json-report'];
          for (const pkg of requiredPkgs) {
            const hasPkg = await checkPytestInstalled(pythonPath, pkg);
            if (!hasPkg) {
              const ok = await ensurePythonDeps(pythonPath, [pkg]);
              if (!ok) return;
            }
          }

          // Run tests locally
          const testResult = await runLocalTest(code, test, pythonPath);

          // Parse test results and generate analysis
          if (testResult.report && testResult.report.tests) {
            const total = testResult.report.tests.length;
            const passed = testResult.report.tests.filter((t: any) => t.outcome === 'passed').length;
            const failed = total - passed;
            
            analysis += `## Test Results Overview\n`;
            analysis += `- **Total Tests:** ${total}\n`;
            analysis += `- **Passed:** ${passed} \n`;
            analysis += `- **Failed:** ${failed} \n`;
            analysis += `- **Success Rate:** ${Math.round((passed / total) * 100)}%\n\n`;
            
            if (failed > 0) {
              analysis += `## Failed Test Details\n\n`;
              const failedTests = testResult.report.tests.filter((t: any) => t.outcome === 'failed');
              
              // Generate concise test summary
              const conciseSummary = generateConciseTestSummary(failedTests, total);
              if (conciseSummary) {
                analysis += conciseSummary;
              }
              
              // Generate improvement suggestions
              const suggestions = generateSuggestions(failedTests, metadata);
              if (suggestions.length > 0) {
                analysis += `## Improvement Suggestions\n`;
                suggestions.forEach(suggestion => {
                  analysis += `- ${suggestion}\n`;
                });
                analysis += `\n`;
              }
            } else {
              analysis += `## Test Results\n`;
              analysis += `- All ${total} tests passed! ✅\n\n`;
            }
          } else {
            analysis += `## Test Execution Issues\n`;
            if (testResult.stderr) {
              analysis += `**Error Output:** ${testResult.stderr}\n`;
            }
            if (testResult.stdout) {
              analysis += `**Standard Output:** ${testResult.stdout}\n`;
            }
            analysis += `\nPossible causes:\n`;
            analysis += `- Code syntax errors\n`;
            analysis += `- Import module failures\n`;
            analysis += `- Incomplete function definitions\n`;
            analysis += `- Test file format issues\n`;
          }
        }

        // 5. Assemble prompt
        console.log("promptContent:", promptContent)
        console.log("analysis:", analysis)
        let prompt = promptContent;
        
        // 6. Extract and fill placeholders
        const placeholderKeys = getTemplatePlaceholderKeys(promptContent);
        const placeholderMap = extractPromptPlaceholders(editor.notebook, cell.index, placeholderKeys);
        
        // Add special placeholders for backward compatibility
        placeholderMap.set('cell', code);
        
        // Check if prompt contains placeholders before getting content
        const hasProblemDescription = prompt.includes('{{problem_description}}');
        const hasCodeOutput = prompt.includes('{{code_output}}');
        
        // Only get markdown above if placeholder exists and not already set by comments
        // if (hasProblemDescription && !placeholderMap.has('problem_description')) {
        //   const markdownAbove = getMarkdownAbove(editor.notebook, cell.index);
        //   if (markdownAbove) {
        //     placeholderMap.set('problem_description', markdownAbove);
        //     console.log("markdownAbove:", markdownAbove)
        //   } else {
        //     placeholderMap.set('problem_description', '');
        //   }
        // }
        
        // Only get cell output if placeholder exists
        if (hasCodeOutput) {
          const cellOutput = getCellOutput(cell);
          if (cellOutput.hasOutput) {
            placeholderMap.set('code_output', cellOutput.output);
            console.log("cellOutput:", cellOutput.output)
          } else {
            placeholderMap.set('code_output', '');
          }
        }
        
        // Add analysis to prompt only if useHiddenTests is enabled and analysis exists
        if (useHiddenTests && analysis) {
          placeholderMap.set('hidden_tests', analysis);
        } else {
          placeholderMap.set('hidden_tests', '');
        }
        
        // Fill only declared placeholders, keep others unchanged
        prompt = fillPromptTemplate(prompt, placeholderMap, editor.notebook);
        // console.log("Final prompt after filling placeholders:", prompt);
        
        // Add system role to the beginning of the prompt
        const system_role = "You are a Python teaching assistant for programming beginners. Given the uploaded code and optional hidden test results, offer concise code suggestions on improvement and fixing output errors without directly giving solutions. Be encouraging and constructive in your feedback. ";
        
        const fullPrompt = system_role + prompt;
        console.log("fullPrompt:", fullPrompt)

        // Ollama API format
        const body = {
          model: modelName,
          prompt: fullPrompt
        };
        
        // Call the LLM interface
        let feedback: string;
        try {
          console.log('=== API Request Debug ===');
          console.log('API URL:', apiUrl);
          console.log('Model Name:', modelName);
          // console.log('Request Body:', JSON.stringify(body, null, 2));
          console.log('=== End API Request Debug ===');
          
          const resp = await axios.post(
            apiUrl,
            body,
            {
                headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`
                },
                responseType: 'text'
            }
          );
          
          console.log('=== API Response Debug ===');
          console.log('Response Status:', resp.status);
          // console.log('Response Data:', resp.data);
          console.log('Response Headers:', resp.headers);
          console.log('=== End API Response Debug ===');
          
          // Parse streaming response
          const lines = resp.data.split('\n').filter((line: string) => line.trim());
          let fullResponse = '';
          
          for (const line of lines) {
            try {
              const jsonResponse = JSON.parse(line);
              if (jsonResponse.response) {
                fullResponse += jsonResponse.response;
              }
            } catch (e) {
              console.warn('Failed to parse JSON line:', line);
            }
          }
          
          if (!fullResponse) {
            console.error('No valid response content found');
            return vscode.window.showErrorMessage('No valid response content received from API.');
          }
          feedback = fullResponse;
          console.log('feedback:', feedback)

        } catch (e: any) {
          console.error('=== API Error Debug ===');
          console.error('Error:', e);
          console.error('Error Response:', e.response?.data);
          console.error('Error Status:', e.response?.status);
          console.error('Error Headers:', e.response?.headers);
          console.error('=== End API Error Debug ===');
          
          let errorMessage = 'AI API call failed: ' + e.message;
          if (e.response?.data) {
            errorMessage += '\nResponse: ' + JSON.stringify(e.response.data, null, 2);
          }
          return vscode.window.showErrorMessage(errorMessage);
        }

        const notebook = editor.notebook;
        const cellIndex = cell.index;
        const content = `# **AI Feedback**\n\n${feedback.replace(/\n/g, '  \n')}`;
        await insertMarkdownCellBelow(notebook, cellIndex, content);
      }
    )
  );

  // Template management commands
  ctx.subscriptions.push(
    vscode.commands.registerCommand(
      'jupyterAiFeedback.listTemplates',
      async () => {
        await syncGitRepo();
        const templates = await listLocalTemplates();
        if (templates.length === 0) {
          vscode.window.showInformationMessage('No templates available');
          return;
        }
        const output = vscode.window.createOutputChannel('Template List');
        output.show();
        output.appendLine('Available Templates:');
        output.appendLine('==================');
        templates.forEach(t => {
          output.appendLine(`ID: ${t.id}\nFile: ${t.filename}\n`);
        });
      }
    )
  );

  // Exercise management command
  ctx.subscriptions.push(
    vscode.commands.registerCommand(
      'jupyterAiFeedback.listExercises',
      async () => {
        await syncGitRepo();
        const exercises = await listLocalExercises();
        if (exercises.length === 0) {
          vscode.window.showInformationMessage('No exercises available');
          return;
        }
        const output = vscode.window.createOutputChannel('Exercise List');
        output.show();
        output.appendLine('Available Exercises:');
        output.appendLine('==================');
        exercises.forEach(e => {
          output.appendLine(`ID: ${e.id}\nTitle: ${e.title || ''}\nDesc: ${e.description || ''}\n`);
        });
      }
    )
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand(
      'jupyterAiFeedback.selectTemplate',
      async () => {
        await syncGitRepo();
        const templates = await listLocalTemplates();
        if (templates.length === 0) {
          vscode.window.showInformationMessage('No available templates');
          return;
        }
        // 生成下拉选项
        const items = templates.map(t => ({
          label: t.id,
          description: t.filename
        }));
        const pick = await vscode.window.showQuickPick(items, {
          placeHolder: 'Please select a template'
        });
        if (pick) {
          // 写入配置
          await vscode.workspace.getConfiguration('jupyterAiFeedback')
            .update('templateId', pick.label, vscode.ConfigurationTarget.Global);
          vscode.window.showInformationMessage(`Selected template: ${pick.label}`);
        }
      }
    )
  );

  // Sync GitHub repository command
  ctx.subscriptions.push(
    vscode.commands.registerCommand(
      'jupyterAiFeedback.syncGitRepo',
      async () => {
        try {
          vscode.window.showInformationMessage('Syncing GitHub repository...');
          await syncGitRepo();
          vscode.window.showInformationMessage('GitHub repository synced successfully!');
        } catch (error) {
          console.error('Sync failed:', error);
          vscode.window.showErrorMessage(`Failed to sync repository: ${error}`);
        }
      }
    )
  );

  // Show prompt content command
  ctx.subscriptions.push(
    vscode.commands.registerCommand(
      'jupyterAiFeedback.showPromptContent',
      async () => {
        try {
          await syncGitRepo();
          const templates = await listLocalTemplates();
          if (templates.length === 0) {
            vscode.window.showInformationMessage('No available templates');
            return;
          }
          
          // 生成下拉选项
          const items = templates.map(t => ({
            label: t.id,
            description: t.filename
          }));
          const pick = await vscode.window.showQuickPick(items, {
            placeHolder: 'Please select a prompt to view'
          });
          
          if (pick) {
            const promptContent = await getPromptContent(pick.label);
            const output = vscode.window.createOutputChannel(`Prompt: ${pick.label}`);
            output.show();
            output.appendLine(`Prompt ID: ${pick.label}`);
            output.appendLine('='.repeat(50));
            output.appendLine(promptContent);
          }
        } catch (error) {
          console.error('Show prompt content failed:', error);
          vscode.window.showErrorMessage(`Failed to show prompt content: ${error}`);
        }
      }
    )
  );
}

export function deactivate() {}