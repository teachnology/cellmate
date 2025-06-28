import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as cp from 'child_process';
import axios from 'axios';
import simpleGit, { SimpleGit } from 'simple-git';
import * as tmp from 'tmp';

const GIT_REPO_URL = 'https://github.com/esemsc-sg524/leveled_prompt.git';
const LOCAL_REPO_PATH = path.join(os.tmpdir(), 'leveled_prompt_repo');
let cachedTemplates: { id: string, filename: string, description?: string }[] = [];
let extensionContext: vscode.ExtensionContext;

// ========== Template Storage Functions ==========
function getCurrentTemplateId(): string {
  return extensionContext.globalState.get('templateId', 'leveled_feedback');
}

async function setCurrentTemplateId(templateId: string): Promise<void> {
  await extensionContext.globalState.update('templateId', templateId);
  updateStatusBar();
}

async function syncGitRepo() {
  const git: SimpleGit = simpleGit();
  if (!fs.existsSync(LOCAL_REPO_PATH)) {
    await git.clone(GIT_REPO_URL, LOCAL_REPO_PATH);
  } else {
    await git.cwd(LOCAL_REPO_PATH).pull();
  }
}

async function refreshTemplateCache(): Promise<void> {
  try {
    await syncGitRepo();
    cachedTemplates = await listLocalTemplates();
    console.log('📝 Templates loaded:', cachedTemplates.length);
  } catch (error) {
    console.error('❌ Failed to load templates:', error);
  }
}

async function getAvailableTemplates(): Promise<{ id: string, filename: string, description?: string }[]> {
  if (cachedTemplates.length === 0) {
    await refreshTemplateCache();
  }
  return cachedTemplates;
}

async function getPromptContent(promptId: string): Promise<string> {
  const promptPath = path.join(LOCAL_REPO_PATH, 'prompts', `${promptId}.txt`);
  if (!fs.existsSync(promptPath)) throw new Error(`Prompt file ${promptId}.txt not found`);
  return fs.readFileSync(promptPath, 'utf8');
}

// ========== Hidden Tests Functions ==========
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

async function runLocalTest(code: string, test: string): Promise<any> {
  const tmpDir = tmp.dirSync({ unsafeCleanup: true });
  const codePath = path.join(tmpDir.name, 'submission.py');
  const testPath = path.join(tmpDir.name, 'test_hidden.py');
  const reportPath = path.join(tmpDir.name, 'report.json');

  fs.writeFileSync(codePath, code, 'utf8');
  fs.writeFileSync(testPath, test, 'utf8');

  return new Promise((resolve) => {
    const python = process.platform === 'win32' ? 'python' : 'python3';
    const cmd = [
      python, '-m', 'pytest', testPath,
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

function extractExerciseId(code: string): string | null {
  const m = code.match(/^\s*#\s*EXERCISE_ID\s*:\s*([A-Za-z0-9_\-]+)/m);
  return m ? m[1] : null;
}

function extractErrorMessage(test: any): string {
  const call = test.call;
  if (call && typeof call === 'object') {
    const longrepr = call.longrepr;
    if (typeof longrepr === 'string' && longrepr.trim()) {
      return longrepr.trim();
    }
  }
  
  const longrepr = test.longrepr;
  if (typeof longrepr === 'string' && longrepr.trim()) {
    return longrepr.trim();
  } else if (longrepr && typeof longrepr === 'object') {
    const msg = longrepr.longrepr || longrepr.reprcrash?.message || '';
    if (msg) return msg.trim();
  }
  
  for (const phase of ['setup', 'teardown']) {
    const phaseData = test[phase];
    if (phaseData && typeof phaseData === 'object') {
      const msg = phaseData.longrepr;
      if (typeof msg === 'string' && msg.trim()) {
        return msg.trim();
      }
    }
  }
  
  const testName = test.nodeid?.split('::').pop() || 'Unknown Test';
  const outcome = test.outcome || 'failed';
  return `${testName} ${outcome}`;
}

function extractExpectedValue(errorMessage: string): string {
  const patterns = [
    /should return (\d+)/i,
    /expected (\d+)/i,
    /assert \d+ == (\d+)/i,
    /Expected:\s*(\d+)/i,
    /expected\s+([^,\n]+)/i,
    /should be\s+([^,\n]+)/i,
  ];
  
  for (const pattern of patterns) {
    const match = errorMessage.match(pattern);
    if (match) return match[1].trim();
  }
  return '';
}

function extractActualValue(errorMessage: string): string {
  const patterns = [
    /but got (\d+)/i,
    /got (\d+)/i,
    /assert (\d+) == \d+/i,
    /Actual:\s*(\d+)/i,
    /got\s+([^,\n]+)/i,
    /returned\s+([^,\n]+)/i,
  ];
  
  for (const pattern of patterns) {
    const match = errorMessage.match(pattern);
    if (match) return match[1].trim();
  }
  return '';
}

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
  
  const hints = metadata?.hints || [];
  hints.slice(0, 2).forEach((hint: string) => suggestions.add(hint));
  
  return Array.from(suggestions);
}

async function listLocalTemplates(): Promise<{ id: string, filename: string, description?: string }[]> {
  const promptsDir = path.join(LOCAL_REPO_PATH, 'prompts');
  if (!fs.existsSync(promptsDir)) return [];
  
  const templates = [];
  const files = fs.readdirSync(promptsDir).filter(f => f.endsWith('.txt'));
  
  for (const file of files) {
    const id = path.basename(file, '.txt');
    let description = '';
    
    try {
      const content = fs.readFileSync(path.join(promptsDir, file), 'utf8');
      const lines = content.split('\n').slice(0, 10);
      
      for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine.startsWith('**Description:**')) {
          description = trimmedLine.replace('**Description:**', '').trim();
          break;
        } else if (trimmedLine.startsWith('**Purpose:**')) {
          description = trimmedLine.replace('**Purpose:**', '').trim();
          break;
        } else if (trimmedLine.includes('Description:') || trimmedLine.includes('Purpose:')) {
          description = trimmedLine.split(':')[1]?.trim() || '';
          if (description) break;
        }
      }
      
      if (!description) {
        if (id === 'leveled_feedback') description = 'Five-level structured feedback system';
        else if (id === 'four_level') description = 'Original four-level feedback system';
        else if (id.includes('beginner')) description = 'Beginner-friendly feedback approach';
        else if (id.includes('advanced')) description = 'Advanced student feedback system';
        else if (id.includes('simple')) description = 'Simple and concise feedback';
        else if (id.includes('detailed')) description = 'Detailed analysis and guidance';
        else description = 'Custom feedback template';
      }
      
    } catch (error) {
      console.warn(`Could not read template ${file}:`, error);
      description = 'Template description unavailable';
    }
    
    templates.push({ id, filename: file, description });
  }
  
  const priorityOrder = ['leveled_feedback', 'four_level'];
  templates.sort((a, b) => {
    const aIndex = priorityOrder.indexOf(a.id);
    const bIndex = priorityOrder.indexOf(b.id);
    
    if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
    if (aIndex !== -1) return -1;
    if (bIndex !== -1) return 1;
    return a.id.localeCompare(b.id);
  });
  
  return templates;
}

function extractFeedbackLevel(feedback: string): string | null {
  const levelPatterns = [
    { pattern: /✅.*?EXCELLENT/i, level: 'EXCELLENT' },
    { pattern: /🚨.*?TARGETED/i, level: 'TARGETED' },
    { pattern: /🤔.*?TACTICAL/i, level: 'TACTICAL' },
    { pattern: /🏗️.*?STRATEGIC/i, level: 'STRATEGIC' },
    { pattern: /💡.*?CONCEPTUAL/i, level: 'CONCEPTUAL' }
  ];
  
  for (const { pattern, level } of levelPatterns) {
    if (pattern.test(feedback)) {
      return level;
    }
  }
  return null;
}

// ========== ENHANCED: Parameter Mismatch Detection ==========
function hasParameterMismatch(problemDescription: string, code: string, output: string): boolean {
  if (!problemDescription || !code || !output) return false;
  
  try {
    // Look for "smaller than X" patterns
    const smallerThanMatch = problemDescription.match(/smaller than (\d+)/i);
    if (smallerThanMatch) {
      const limit = parseInt(smallerThanMatch[1]);
      
      // Extract all numbers from output
      const outputNumbers = output.match(/\b\d+\b/g);
      if (outputNumbers) {
        const nums = outputNumbers.map(n => parseInt(n));
        const exceedsLimit = nums.some(num => num >= limit); // >= because "smaller than" means strictly less
        
        if (exceedsLimit) {
          console.log(`🔍 Parameter mismatch detected: "smaller than ${limit}" but output contains ${nums.filter(n => n >= limit)}`);
          return true;
        }
      }
    }
    
    // Look for "less than X" patterns  
    const lessThanMatch = problemDescription.match(/less than (\d+)/i);
    if (lessThanMatch) {
      const limit = parseInt(lessThanMatch[1]);
      const outputNumbers = output.match(/\b\d+\b/g);
      if (outputNumbers) {
        const nums = outputNumbers.map(n => parseInt(n));
        const exceedsLimit = nums.some(num => num >= limit);
        
        if (exceedsLimit) {
          console.log(`🔍 Parameter mismatch detected: "less than ${limit}" but output contains ${nums.filter(n => n >= limit)}`);
          return true;
        }
      }
    }
    
    // Check function call parameters vs problem requirements
    const functionCallMatch = code.match(/(\w+)\s*\(\s*(\d+)\s*\)/);
    if (functionCallMatch && smallerThanMatch) {
      const callLimit = parseInt(functionCallMatch[2]);
      const problemLimit = parseInt(smallerThanMatch[1]);
      
      if (callLimit > problemLimit) {
        console.log(`🔍 Function call mismatch: problem asks for < ${problemLimit}, but code calls with ${callLimit}`);
        return true;
      }
    }
    
    return false;
  } catch (error) {
    console.warn('Error in parameter mismatch detection:', error);
    return false;
  }
}

// ========== Context Extraction Functions ==========
function getProblemDescription(editor: vscode.NotebookEditor, currentCell: vscode.NotebookCell): string {
  const currentIndex = currentCell.index;
  let problemDescription = '';
  
  for (let i = currentIndex - 1; i >= 0; i--) {
    const cell = editor.notebook.cellAt(i);
    
    if (cell.kind === vscode.NotebookCellKind.Markup) {
      const content = cell.document.getText().trim();
      
      if (!content) continue;
      
      problemDescription = content + '\n\n' + problemDescription;
      
      if (content.length > 100 || problemDescription.length > 1000) {
        break;
      }
    }
    else if (cell.kind === vscode.NotebookCellKind.Code) {
      break;
    }
  }
  
  return problemDescription.trim();
}

// ========== Status Bar Management ==========
let statusBarItem: vscode.StatusBarItem;

function updateStatusBar(): void {
  if (!statusBarItem) {
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'jupyterAiFeedback.selectTemplate';
  }
  
  const currentTemplate = getCurrentTemplateId();
  statusBarItem.text = `$(file-text) ${currentTemplate}`;
  statusBarItem.tooltip = `Current AI Feedback Template: ${currentTemplate}\n\nClick to select from available templates\nTemplates are loaded from GitHub repository`;
  statusBarItem.show();
}

// ========== Template Selection Functions ==========
async function showTemplateSelector(): Promise<void> {
  try {
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Loading available templates...',
      cancellable: false
    }, async (progress) => {
      progress.report({ increment: 50, message: 'Syncing repository...' });
      
      const templates = await getAvailableTemplates();
      
      progress.report({ increment: 100, message: 'Templates loaded!' });
      
      if (templates.length === 0) {
        const action = await vscode.window.showWarningMessage(
          'No templates found. Please check repository connection.',
          'Refresh Templates',
          'Check Settings'
        );
        
        if (action === 'Refresh Templates') {
          await refreshTemplateCache();
          return showTemplateSelector();
        } else if (action === 'Check Settings') {
          vscode.commands.executeCommand('workbench.action.openSettings', 'jupyterAiFeedback');
        }
        return;
      }
      
      const currentTemplateId = getCurrentTemplateId();
      
      const items: vscode.QuickPickItem[] = templates.map(template => {
        const isCurrent = template.id === currentTemplateId;
        return {
          label: `${isCurrent ? '$(check) ' : '$(file-text) '}${template.id}`,
          description: template.description,
          detail: `File: ${template.filename}${isCurrent ? ' (current)' : ''}`,
          picked: isCurrent
        };
      });
      
      items.unshift({
        label: '$(refresh) Refresh Templates',
        description: 'Reload templates from GitHub repository',
        detail: 'Click to check for new or updated templates'
      });
      
      const selected = await vscode.window.showQuickPick(items, {
        title: 'Select AI Feedback Template',
        placeHolder: `Current: ${currentTemplateId} (${templates.length} templates available)`,
        matchOnDescription: true,
        matchOnDetail: true
      });
      
      if (selected) {
        if (selected.label.includes('Refresh Templates')) {
          await refreshTemplateCache();
          vscode.window.showInformationMessage(`✅ Templates refreshed! Found ${cachedTemplates.length} templates.`);
          return showTemplateSelector();
        } else {
          const templateId = selected.label.replace(/^\$\([^)]+\)\s*/, '');
          
          if (templateId !== currentTemplateId) {
            await setCurrentTemplateId(templateId);
            vscode.window.showInformationMessage(`✅ Template updated to: ${templateId}`);
          }
        }
      }
    });
    
  } catch (error) {
    console.error('Error showing template selector:', error);
    vscode.window.showErrorMessage(`Failed to load templates: ${error}`);
  }
}

function processTemplate(template: string, placeholders: { [key: string]: string }): string {
  let result = template;
  
  for (const [key, value] of Object.entries(placeholders)) {
    const placeholder = `{{${key}}}`;
    result = result.replace(new RegExp(placeholder, 'g'), value);
  }
  
  result = result.replace(/\{\{[^}]+\}\}/g, '');
  result = result.replace(/\n\s*\n\s*\n/g, '\n\n');
  
  return result.trim();
}

// ========== Text Cleaning Helper Functions ==========
function cleanOutputText(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\r/g, '')
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

function cleanErrorText(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\r/g, '')
    .trim();
}

function stripHtmlTags(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

// ========== Output Collection Functions ==========
function getCellOutput(cell: vscode.NotebookCell): { hasOutput: boolean, output: string, executionError: boolean } {
  let outputText = '';
  let hasOutput = false;
  let executionError = false;
  
  if (cell.outputs && cell.outputs.length > 0) {
    hasOutput = true;
    
    for (const output of cell.outputs) {
      for (const item of output.items) {
        try {
          if (item.mime === 'text/plain') {
            const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });
            const text = decoder.decode(item.data);
            outputText += cleanOutputText(text) + '\n';
            
          } else if (item.mime === 'application/vnd.code.notebook.error') {
            const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });
            const errorText = decoder.decode(item.data);
            outputText += '[ERROR] ' + cleanErrorText(errorText) + '\n';
            executionError = true;
            
          } else if (item.mime === 'text/html') {
            const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });
            const htmlContent = decoder.decode(item.data);
            const textOnly = stripHtmlTags(htmlContent);
            if (textOnly.trim()) {
              outputText += textOnly + '\n';
            }
            
          } else if (item.mime === 'application/vnd.code.notebook.stdout') {
            const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });
            const text = decoder.decode(item.data);
            outputText += cleanOutputText(text) + '\n';
            
          } else if (item.mime === 'application/vnd.code.notebook.stderr') {
            const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });
            const errorText = decoder.decode(item.data);
            outputText += '[STDERR] ' + cleanErrorText(errorText) + '\n';
            executionError = true;
            
          } else if (item.mime.startsWith('image/')) {
            outputText += '[IMAGE OUTPUT DETECTED]\n';
            
          } else if (item.mime === 'application/json') {
            const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });
            const jsonText = decoder.decode(item.data);
            outputText += '[JSON] ' + jsonText + '\n';
            
          } else {
            try {
              const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });
              const unknownText = decoder.decode(item.data);
              if (unknownText.trim()) {
                outputText += `[${item.mime.toUpperCase()}] ${unknownText}\n`;
              }
            } catch (decodeError) {
              outputText += `[BINARY DATA: ${item.mime}]\n`;
            }
          }
          
        } catch (error) {
          console.error(`Error processing output item (${item.mime}):`, error);
          outputText += `[DECODE ERROR: ${item.mime}]\n`;
        }
      }
    }
  }
  
  const result = { hasOutput, output: outputText.trim(), executionError };
  console.log('🔍 Output collected:', { hasOutput, outputLength: result.output.length, executionError });
  
  return result;
}

async function executeAndGetOutput(cell: vscode.NotebookCell): Promise<{ hasOutput: boolean, output: string, executionError: boolean }> {
  try {
    await vscode.commands.executeCommand('notebook.cell.execute', { 
      ranges: [{ start: cell.index, end: cell.index + 1 }] 
    });
    
    let attempts = 0;
    const maxAttempts = 10;
    
    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      attempts++;
      
      const currentOutput = getCellOutput(cell);
      
      if (currentOutput.hasOutput || attempts >= maxAttempts) {
        return currentOutput;
      }
    }
    
    return getCellOutput(cell);
    
  } catch (error) {
    console.error('Error executing cell:', error);
    return { hasOutput: false, output: '', executionError: true };
  }
}

// ========== RELAXED: Feedback Validation Functions ==========
function countSentences(text: string): number {
  let cleanText = text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]+`/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/#{1,6}\s+/g, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .trim();

  if (!cleanText) return 0;

  const sentences = cleanText
    .split(/[.!?]+/)
    .map(s => s.trim())
    .filter(s => {
      if (!s || s.length < 10) return false;
      if (/^\d+(\.\d+)?$/.test(s)) return false;
      if (/^\w+$/.test(s) && !['yes', 'no', 'true', 'false'].includes(s.toLowerCase())) return false;
      return true;
    });

  return sentences.length;
}

function hasExecutionError(output: string, executionError: boolean): boolean {
  if (executionError) return true;
  
  const errorIndicators = [
    'NameError',
    'SyntaxError', 
    'IndentationError',
    'TypeError: invalid syntax',
    'unexpected EOF',
    'invalid syntax'
  ];
  
  return errorIndicators.some(indicator => output.includes(indicator));
}

// ========== ENHANCED: Feedback Validation with Relaxed Standards ==========
function validateFeedback(
  feedback: string, 
  templateId: string,
  code?: string,
  output?: string,
  problemDescription?: string,
  executionError?: boolean
): { isValid: boolean, warnings: string[] } {
  const warnings: string[] = [];
  let isValid = true;

  // Critical Issue 1: Code blocks in feedback
  if (feedback.includes('```')) {
    warnings.push('🚫 Contains code blocks - should use guiding questions instead');
    isValid = false;
  }

  // Critical Issue 2: Complete code solutions
  const codePatterns = [
    /def\s+\w+\s*\([^)]*\)\s*:/,
    /class\s+\w+/,
    /return\s+[\w\s+\-*\/]+/,
    /if\s+[\w\s]+:/,
    /for\s+\w+\s+in\s+/,
    /while\s+[\w\s]+:/,
  ];

  for (const pattern of codePatterns) {
    if (pattern.test(feedback)) {
      warnings.push('🚫 Contains code solutions - should only provide hints');
      isValid = false;
      break;
    }
  }

  // Enhanced validation with execution error and parameter mismatch detection
  if (code && output && problemDescription) {
    const detectedLevel = extractFeedbackLevel(feedback);
    
    // Critical Issue 3: EXCELLENT rating with parameter mismatch
    if (detectedLevel === 'EXCELLENT' && hasParameterMismatch(problemDescription, code, output)) {
      warnings.push('🚫 EXCELLENT rating but code parameters don\'t match problem requirements');
      isValid = false;
    }
    
    // Critical Issue 4: Execution errors should be TARGETED
    if (hasExecutionError(output, executionError || false) && detectedLevel && detectedLevel !== 'TARGETED') {
      warnings.push(`🚫 Execution error (NameError/SyntaxError) should be TARGETED, not ${detectedLevel}`);
      isValid = false;
    }
  }

  // RELAXED: Sentence count validation - more lenient standards
  if (templateId === 'four_level' || templateId === 'fourLevel' || templateId === 'leveled_feedback') {
    const sentenceCount = countSentences(feedback);
    
    const detectedLevel = extractFeedbackLevel(feedback);
    let maxSentences = 8; // More lenient default
    let minSentences = 1; // Allow single sentence feedback
    
    switch (detectedLevel) {
      case 'EXCELLENT':
        maxSentences = 8;
        minSentences = 1;
        break;
      case 'TARGETED':
        maxSentences = 6; // Increased from 3
        minSentences = 1;
        break;
      case 'TACTICAL':
        maxSentences = 7; // Increased from 4
        minSentences = 1;
        break;
      case 'STRATEGIC':
        maxSentences = 8; // Increased from 5
        minSentences = 1;
        break;
      case 'CONCEPTUAL':
        maxSentences = 8; // Increased from 5
        minSentences = 1;
        break;
      default:
        maxSentences = 7;
        minSentences = 1;
    }
    
    // Only trigger warnings for extreme cases
    if (sentenceCount > maxSentences) {
      warnings.push(`📏 Too verbose: ${sentenceCount} sentences (${detectedLevel || 'General'} level should be ≤${maxSentences})`);
      // Don't fail validation for sentence count alone - just warn
    }
  }

  // Warning only: Check for leveled format
  if (templateId === 'four_level' || templateId === 'fourLevel' || templateId === 'leveled_feedback') {
    const hasLevelFormat = /[✅🚨🤔🏗️💡]\s*(EXCELLENT|TARGETED|TACTICAL|STRATEGIC|CONCEPTUAL)/i.test(feedback);
    if (!hasLevelFormat) {
      warnings.push('⚠️ Missing leveled format (✅ EXCELLENT, 🚨 TARGETED, 🤔 TACTICAL, 🏗️ STRATEGIC, 💡 CONCEPTUAL)');
    }
  }

  return { isValid, warnings };
}

async function insertFeedback(
  editor: vscode.NotebookEditor,
  cell: vscode.NotebookCell,
  feedback: string,
  templateId: string
): Promise<void> {

  let enhancedFeedback = feedback;
  if (templateId === 'four_level' || templateId === 'fourLevel' || templateId === 'leveled_feedback') {
    const detectedLevel = extractFeedbackLevel(feedback);
    if (detectedLevel) {
      console.log(`✅ Feedback level detected: ${detectedLevel}`);
    }
  }

  await vscode.commands.executeCommand('notebook.cell.insertMarkdownCellBelow');

  const newCell = editor.notebook.cellAt(cell.index + 1);
  const doc = newCell.document;

  const lastLine = doc.lineCount > 0 ? doc.lineCount - 1 : 0;
  const fullRange = new vscode.Range(
    0,
    0,
    lastLine,
    doc.lineAt(lastLine).text.length
  );
  
  let feedbackIcon = '🧠';
  let feedbackTitle = 'AI Feedback';
  
  if (templateId === 'four_level' || templateId === 'fourLevel' || templateId === 'leveled_feedback') {
    if (feedback.includes('✅')) {
      feedbackIcon = '✅';
      feedbackTitle = 'EXCELLENT Feedback';
    } else if (feedback.includes('🚨')) {
      feedbackIcon = '🚨';
      feedbackTitle = 'TARGETED Feedback';
    } else if (feedback.includes('🤔')) {
      feedbackIcon = '🤔';
      feedbackTitle = 'TACTICAL Feedback';
    } else if (feedback.includes('🏗️')) {
      feedbackIcon = '🏗️';
      feedbackTitle = 'STRATEGIC Feedback';
    } else if (feedback.includes('💡')) {
      feedbackIcon = '💡';
      feedbackTitle = 'CONCEPTUAL Feedback';
    }
  }
  
  const content = `## ${feedbackIcon} ${feedbackTitle}\n\n${enhancedFeedback.replace(/\n/g, '  \n')}`;
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, fullRange, content);
  await vscode.workspace.applyEdit(edit);
}

async function generateAIFeedback(cell: vscode.NotebookCell, retryCount: number = 0): Promise<void> {
  const MAX_RETRIES = 2;
  
  const config = vscode.workspace.getConfiguration('jupyterAiFeedback');
  const templateId = getCurrentTemplateId();
  const apiUrl = config.get<string>('apiUrl') || '';
  const apiKey = config.get<string>('apiKey') || '';
  const modelName = config.get<string>('modelName') || '';
  const includeProblemDescription = config.get<boolean>('includeProblemDescription', true);
  const includeCodeOutput = config.get<boolean>('includeCodeOutput', true);
  const autoExecuteCode = config.get<boolean>('autoExecuteCode', true);
  const useHiddenTests = config.get<boolean>('useHiddenTests', false);
  const apiFormat = config.get<string>('apiFormat', 'openai');
  
  const activeEditor = vscode.window.activeNotebookEditor;
  if (!activeEditor) {
    vscode.window.showErrorMessage('No active notebook editor found');
    return;
  }

  const code = cell.document.getText();
  if (!code.trim()) {
    vscode.window.showWarningMessage('Cell is empty. Please add some Python code first.');
    return;
  }

  if (!apiUrl || !apiKey || !modelName) {
    const action = await vscode.window.showErrorMessage(
      'AI Feedback requires API configuration. Please set your API URL, API Key, and model in settings.',
      'Open Settings'
    );
    
    if (action === 'Open Settings') {
      vscode.commands.executeCommand('workbench.action.openSettings', 'jupyterAiFeedback');
    }
    return;
  }

  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `Generating AI Feedback...`,
    cancellable: false
  }, async (progress) => {
    try {
      progress.report({ increment: 10, message: 'Loading template...' });
      
      await syncGitRepo();
      
      let userPrompt: string;
      try {
        userPrompt = await getPromptContent(templateId);
      } catch (error: any) {
        vscode.window.showErrorMessage(`Template '${templateId}' not found: ${error.message}`);
        return;
      }
      
      progress.report({ increment: 30, message: 'Extracting context...' });
      
      const problemDescription = includeProblemDescription ? getProblemDescription(activeEditor, cell) : '';
      
      let cellOutputResult = { hasOutput: false, output: '', executionError: false };
      
      if (includeCodeOutput) {
        if (autoExecuteCode) {
          progress.report({ increment: 40, message: 'Executing code...' });
          try {
            cellOutputResult = await executeAndGetOutput(cell);
          } catch (error) {
            console.warn('Failed to auto-execute cell:', error);
            cellOutputResult = getCellOutput(cell);
          }
        } else {
          cellOutputResult = getCellOutput(cell);
        }
      }
      
      // Hidden tests integration
      let hiddenTestAnalysis = '';
      if (useHiddenTests) {
        progress.report({ increment: 50, message: 'Running hidden tests...' });
        
        const exId = extractExerciseId(code);
        if (exId) {
          try {
            const { test, metadata } = await getTestFiles(exId);
            const testResult = await runLocalTest(code, test);
            
            if (testResult.report && testResult.report.tests) {
              const total = testResult.report.tests.length;
              const passed = testResult.report.tests.filter((t: any) => t.outcome === 'passed').length;
              const failed = total - passed;
              
              hiddenTestAnalysis += `## Hidden Test Results\n`;
              hiddenTestAnalysis += `- **Total Tests:** ${total}\n`;
              hiddenTestAnalysis += `- **Passed:** ${passed} ✅\n`;
              hiddenTestAnalysis += `- **Failed:** ${failed} ❌\n`;
              hiddenTestAnalysis += `- **Success Rate:** ${Math.round((passed / total) * 100)}%\n\n`;
              
              if (failed > 0) {
                hiddenTestAnalysis += `## Failed Test Details\n\n`;
                const failedTests = testResult.report.tests.filter((t: any) => t.outcome === 'failed');
                
                failedTests.forEach((test: any, index: number) => {
                  const testName = test.nodeid.split('::').pop() || 'Unknown Test';
                  const errorMessage = extractErrorMessage(test);
                  const expectedValue = extractExpectedValue(errorMessage);
                  const actualValue = extractActualValue(errorMessage);
                  
                  hiddenTestAnalysis += `### ${index + 1}. ${testName}\n`;
                  hiddenTestAnalysis += `**Error Message:** ${errorMessage}\n`;
                  if (expectedValue) hiddenTestAnalysis += `**Expected:** ${expectedValue}\n`;
                  if (actualValue) hiddenTestAnalysis += `**Actual:** ${actualValue}\n`;
                  hiddenTestAnalysis += `\n`;
                });
                
                const suggestions = generateSuggestions(failedTests, metadata);
                if (suggestions.length > 0) {
                  hiddenTestAnalysis += `## Improvement Suggestions\n`;
                  suggestions.forEach(suggestion => {
                    hiddenTestAnalysis += `- ${suggestion}\n`;
                  });
                  hiddenTestAnalysis += `\n`;
                }
              }
            }
          } catch (error) {
            console.warn('Hidden tests failed:', error);
            hiddenTestAnalysis = `## Hidden Test Status\nTests could not be executed: ${error}\n`;
          }
        } else {
          hiddenTestAnalysis = `## Hidden Test Status\nNo EXERCISE_ID found in code. Add # EXERCISE_ID: your_exercise_id to enable hidden tests.\n`;
        }
      }
      
      // Build context for template placeholders
      let problemContext = '';
      if (problemDescription) {
        problemContext = `## Problem Description\n${problemDescription}\n`;
      }
      
      let outputContext = '';
      if (includeCodeOutput) {
        if (cellOutputResult.executionError) {
          outputContext = `## Code Execution\n**Status**: Error occurred during execution\n**Output**:\n\`\`\`\n${cellOutputResult.output}\n\`\`\`\n`;
        } else if (cellOutputResult.hasOutput) {
          if (cellOutputResult.output) {
            const executionNote = autoExecuteCode ? ' (auto-executed)' : ' (from previous execution)';
            outputContext = `## Code Output${executionNote}\n\`\`\`\n${cellOutputResult.output}\n\`\`\`\n`;
          } else {
            outputContext = `## Code Output\n(Code executed but produced no visible output)\n`;
          }
        } else {
          if (autoExecuteCode) {
            outputContext = `## Code Execution Status\n(Code was executed but produced no output)\n`;
          } else {
            outputContext = `## Code Execution Status\n(Code has not been executed yet - no output available for analysis)\n`;
          }
        }
      }
      
      const placeholders = {
        'code': code,
        'problem_description': problemContext,
        'code_output': outputContext,
        'hidden_test_results': hiddenTestAnalysis
      };
      
      const contextualPrompt = processTemplate(userPrompt, placeholders);
      
      progress.report({ increment: 70, message: 'Calling AI API...' });
      
      // ENHANCED: More precise system prompts for first-try success
      const system_role = retryCount > 0 
        ? "You are a Python teaching assistant. CRITICAL RULES:\n" +
          "1. NEVER provide code solutions or code blocks\n" +
          "2. NameError/SyntaxError/IndentationError = 🚨 TARGETED (never TACTICAL)\n" +
          "3. Algorithm correct but wrong parameters = 🤔 TACTICAL\n" +
          "4. Only use ✅ EXCELLENT when output matches ALL requirements\n" +
          "5. Keep under 80 words\n" +
          "6. Follow exact format: [EMOJI] [LEVEL] - [sentence]\n\n"
        : "You are a precise Python teaching assistant. CRITICAL CLASSIFICATION RULES:\n" +
          "1. Check execution status FIRST: NameError, SyntaxError, IndentationError → 🚨 TARGETED\n" +
          "2. If code runs but output doesn't match problem requirements → 🤔 TACTICAL\n" +
          "3. Only use ✅ EXCELLENT when code works AND fully meets ALL problem requirements\n" +
          "4. Never provide code solutions - only hints and guiding questions\n" +
          "5. Follow the exact format and keep response focused\n" +
          "6. Check if output numbers match problem constraints (e.g., 'smaller than 50')\n\n";
      
      let feedback: string;
      try {
        if (apiFormat === 'ollama') {
          const body = {
            model: modelName,
            prompt: system_role + contextualPrompt
          };
          
          const resp = await axios.post(
            apiUrl,
            body,
            {
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
              },
              responseType: 'text',
              timeout: 60000
            }
          );
          
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
          
          feedback = fullResponse;
          
        } else {
          const body = {
            model: modelName,
            messages: [
              { role: 'system', content: system_role },
              { role: 'user', content: contextualPrompt }
            ]
          };
          
          const resp = await axios.post(
            apiUrl,
            body,
            {
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
              },
              timeout: 60000
            }
          );
          
          if (resp.data && resp.data.choices && resp.data.choices.length > 0) {
            feedback = resp.data.choices[0].message.content;
          } else {
            throw new Error('Invalid response format from API');
          }
        }
        
        // ENHANCED: Validation with relaxed sentence count standards
        const validation = validateFeedback(
          feedback, 
          templateId,
          code,
          cellOutputResult.output,
          problemDescription,
          cellOutputResult.executionError
        );
        
        if (!validation.isValid) {
          console.warn('Feedback validation failed:', validation.warnings);
          
          const hasCriticalViolations = validation.warnings.some(warning => 
            warning.includes('Contains code solutions') || 
            warning.includes('Contains code blocks') ||
            warning.includes('EXCELLENT rating but') ||
            warning.includes('should be TARGETED')
          );
          
          if (hasCriticalViolations && retryCount < MAX_RETRIES) {
            console.log(`🔄 Auto-regenerating feedback (attempt ${retryCount + 1}/${MAX_RETRIES + 1})`);
            vscode.window.showInformationMessage(
              `🔄 Improving feedback accuracy... (${retryCount + 1}/${MAX_RETRIES + 1})`
            );
            
            return await generateAIFeedback(cell, retryCount + 1);
            
          } else if (hasCriticalViolations && retryCount >= MAX_RETRIES) {
            vscode.window.showErrorMessage(
              '❌ Unable to generate accurate feedback after multiple attempts. Please try again later.'
            );
            return;
            
          } else {
            // Only show dialog for critical issues, not for sentence count warnings
            const criticalIssues = validation.warnings.filter(w => 
              !w.includes('Too verbose') && !w.includes('Missing leveled format')
            );
            
            if (criticalIssues.length > 0) {
              const action = await vscode.window.showWarningMessage(
                `AI Feedback issues:\n${criticalIssues.join('\n')}\n\nProceed anyway?`,
                'Insert Anyway',
                'Cancel'
              );
              
              if (action === 'Cancel') {
                return;
              }
            }
            // If only minor warnings (sentence count, format), proceed without asking
          }
        }
        
        if (retryCount > 0 && validation.isValid) {
          vscode.window.showInformationMessage(`✅ Generated accurate feedback on attempt ${retryCount + 1}`);
        }

      } catch (e: any) {
        console.error('API call failed:', e);
        
        let errorMessage = 'AI API call failed: ' + e.message;
        if (e.response?.data) {
          errorMessage += '\nResponse: ' + JSON.stringify(e.response.data, null, 2);
        }
        
        if (e.response?.status === 405) {
          errorMessage += '\n\n🔧 Method Not Allowed (405) - Check your API URL and format setting';
        } else if (e.response?.status === 401) {
          errorMessage += '\n\n🔑 Authentication failed - Check your API key';
        } else if (e.response?.status === 404) {
          errorMessage += '\n\n🔍 Endpoint not found - Verify your API URL';
        }
        
        return vscode.window.showErrorMessage(errorMessage);
      }
      
      progress.report({ increment: 90, message: 'Inserting feedback...' });
      
      await insertFeedback(activeEditor, cell, feedback, templateId);
      
      progress.report({ increment: 100, message: 'Complete!' });
      
    } catch (error: any) {
      console.error('AI Feedback Error:', error);
      vscode.window.showErrorMessage(`Failed to generate feedback: ${error.message}`);
    }
  });
}

export function activate(ctx: vscode.ExtensionContext) {
  console.log('🚀 Jupyter AI Feedback extension is now active!');
  
  extensionContext = ctx;
  
  refreshTemplateCache().then(() => {
    updateStatusBar();
  }).catch(error => {
    console.warn('Failed to initialize template cache:', error);
    updateStatusBar();
  });

  updateStatusBar();
  
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

  ctx.subscriptions.push(
    vscode.commands.registerCommand(
      'jupyterAiFeedback.sendNotebookCell',
      async (cell: vscode.NotebookCell) => {
        await generateAIFeedback(cell);
      }
    )
  );

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
          output.appendLine(`ID: ${t.id}`);
          output.appendLine(`File: ${t.filename}`);
          output.appendLine(`Description: ${t.description || 'No description'}\n`);
        });
      }
    )
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand(
      'jupyterAiFeedback.selectTemplate',
      async () => {
        await showTemplateSelector();
      }
    )
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand(
      'jupyterAiFeedback.refreshTemplates',
      async () => {
        await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          title: 'Refreshing templates from repository...',
          cancellable: false
        }, async (progress) => {
          progress.report({ increment: 50, message: 'Syncing repository...' });
          await refreshTemplateCache();
          
          progress.report({ increment: 100, message: 'Complete!' });
          updateStatusBar();
        });
        
        vscode.window.showInformationMessage(`✅ Templates refreshed! Found ${cachedTemplates.length} templates.`);
      }
    )
  );

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

  if (statusBarItem) {
    ctx.subscriptions.push(statusBarItem);
  }
}

export function deactivate() {
  console.log('👋 Jupyter AI Feedback extension deactivated');
  
  if (statusBarItem) {
    statusBarItem.dispose();
  }
}