import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as cp from 'child_process';
import axios from 'axios';
import simpleGit, { SimpleGit } from 'simple-git';
import * as tmp from 'tmp';

const GIT_REPO_URL = 'https://github.com/teachnology/promptfolio.git';
const LOCAL_REPO_PATH = path.join(os.tmpdir(), 'promptfolio_repo');
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
    console.log('📝 Template cache refreshed:', cachedTemplates.length, 'templates found');
  } catch (error) {
    console.error('❌ Failed to refresh template cache:', error);
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

// ========== Hidden Tests Functions (from v0.1.0) ==========
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

// Helper function: Extract error message
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

// Helper function: Extract expected/actual values
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

// ========== Functions for Context Extraction ==========
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

// ========== Enhanced Status Bar with Template Switching ==========
let statusBarItem: vscode.StatusBarItem;

function updateStatusBar(): void {
  if (!statusBarItem) {
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'jupyterAiFeedback.selectTemplate';
  }
  
  const currentTemplate = getCurrentTemplateId();
  statusBarItem.text = `$(file-text) ${currentTemplate}`;
  statusBarItem.tooltip = `Current AI Feedback Template: ${currentTemplate}\n\nClick to select from available templates\nAvailable templates are loaded from GitHub repository`;
  statusBarItem.show();
}

// ========== Template Selection Function ==========
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

async function executeAndGetOutput(cell: vscode.NotebookCell): Promise<{ hasOutput: boolean, output: string, executionError: boolean }> {
  try {
    await vscode.commands.executeCommand('notebook.cell.execute', { ranges: [{ start: cell.index, end: cell.index + 1 }] });
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    return getCellOutput(cell);
  } catch (error) {
    console.error('Error executing cell:', error);
    return { hasOutput: false, output: '', executionError: true };
  }
}

function getCellOutput(cell: vscode.NotebookCell): { hasOutput: boolean, output: string, executionError: boolean } {
  let outputText = '';
  let hasOutput = false;
  let executionError = false;
  
  if (cell.outputs && cell.outputs.length > 0) {
    hasOutput = true;
    for (const output of cell.outputs) {
      for (const item of output.items) {
        if (item.mime === 'text/plain') {
          const decoder = new TextDecoder();
          outputText += decoder.decode(item.data) + '\n';
        }
        else if (item.mime === 'application/vnd.code.notebook.error') {
          const decoder = new TextDecoder();
          outputText += '[ERROR] ' + decoder.decode(item.data) + '\n';
          executionError = true;
        }
        else if (item.mime === 'text/html') {
          const decoder = new TextDecoder();
          const htmlContent = decoder.decode(item.data);
          const textOnly = htmlContent.replace(/<[^>]*>/g, '');
          outputText += textOnly + '\n';
        }
      }
    }
  }
  
  return { hasOutput, output: outputText.trim(), executionError };
}

// ========== Enhanced Feedback Validation ==========
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

function validateFeedback(feedback: string, templateId: string): { isValid: boolean, warnings: string[] } {
  const warnings: string[] = [];
  let isValid = true;

  if (feedback.includes('```')) {
    warnings.push('🚫 Contains code blocks - should use guiding questions instead');
    isValid = false;
  }

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

  if (templateId === 'four_level' || templateId === 'fourLevel' || templateId === 'leveled_feedback') {
    const sentenceCount = countSentences(feedback);
    
    const detectedLevel = extractFeedbackLevel(feedback);
    let maxSentences = 5;
    let minSentences = 2;
    
    switch (detectedLevel) {
      case 'EXCELLENT':
        maxSentences = 4;
        minSentences = 2;
        break;
      case 'TARGETED':
        maxSentences = 3;
        minSentences = 2;
        break;
      case 'TACTICAL':
        maxSentences = 4;
        minSentences = 2;
        break;
      case 'STRATEGIC':
        maxSentences = 5;
        minSentences = 3;
        break;
      case 'CONCEPTUAL':
        maxSentences = 5;
        minSentences = 3;
        break;
      default:
        maxSentences = 4;
        minSentences = 2;
    }
    
    if (sentenceCount > maxSentences) {
      warnings.push(`📏 Too verbose: ${sentenceCount} sentences (${detectedLevel || 'General'} level should be ≤${maxSentences})`);
      isValid = false;
    }
    
    if (sentenceCount < minSentences) {
      warnings.push(`📏 Too brief: ${sentenceCount} sentences (should be ≥${minSentences} for complete guidance)`);
      isValid = false;
    }
  }

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
      console.log(`Leveled feedback classification detected: ${detectedLevel}`);
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
  
  console.log('=== AI Feedback Configuration ===');
  console.log('templateId:', templateId);
  console.log('modelName:', modelName);
  console.log('apiUrl:', apiUrl);
  console.log('useHiddenTests:', useHiddenTests);
  console.log('apiFormat:', apiFormat);
  console.log('retryCount:', retryCount);
  console.log('=== End Configuration ===');
  
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
      progress.report({ increment: 10, message: 'Syncing repository...' });
      
      await syncGitRepo();
      
      progress.report({ increment: 20, message: 'Loading template...' });
      
      let userPrompt: string;
      try {
        userPrompt = await getPromptContent(templateId);
      } catch (error: any) {
        vscode.window.showErrorMessage(`Template '${templateId}' not found: ${error.message}`);
        return;
      }
      
      progress.report({ increment: 30, message: 'Extracting context...' });
      
      // ========== Extract Context ==========
      const problemDescription = includeProblemDescription ? getProblemDescription(activeEditor, cell) : '';
      
      let cellOutputResult = { hasOutput: false, output: '', executionError: false };
      
      if (includeCodeOutput) {
        if (autoExecuteCode) {
          progress.report({ increment: 40, message: 'Auto-executing code...' });
          try {
            cellOutputResult = await executeAndGetOutput(cell);
          } catch (error) {
            console.warn('⚠️ Failed to auto-execute cell:', error);
            cellOutputResult = getCellOutput(cell);
          }
        } else {
          cellOutputResult = getCellOutput(cell);
        }
      }
      
      // ========== 🔥 Hidden Tests Integration ==========
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
            console.warn('⚠️ Hidden tests failed:', error);
            hiddenTestAnalysis = `## Hidden Test Status\nTests could not be executed: ${error}\n`;
          }
        } else {
          console.warn('⚠️ No EXERCISE_ID found for hidden tests');
          hiddenTestAnalysis = `## Hidden Test Status\nNo EXERCISE_ID found in code. Add # EXERCISE_ID: your_exercise_id to enable hidden tests.\n`;
        }
      }
      
      // ========== Build Context for Template Placeholders ==========
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
      
      // Process template with all placeholders
      const placeholders = {
        'code': code,
        'problem_description': problemContext,
        'code_output': outputContext,
        'hidden_test_results': hiddenTestAnalysis
      };
      
      const contextualPrompt = processTemplate(userPrompt, placeholders);
      
      progress.report({ increment: 70, message: 'Calling AI API...' });
      
      const system_role = retryCount > 0 
        ? "You are a Python teaching assistant. CRITICAL: You must NEVER provide any code solutions or code blocks. " +
          "ONLY ask guiding questions and provide conceptual hints. " +
          "Students must discover solutions themselves through your questions. " +
          "Keep responses under 100 words. Use the four-level format if specified in template. " +
          "You may receive problem descriptions, code outputs, and hidden test results - use them for better guidance."
        : "You are a patient and detail-oriented Python teaching assistant. " +
          "Based on the analysis below, provide step-by-step, targeted feedback:\n" +
          "- Ask leading questions that guide the student toward discovering the solution, rather than giving full code.\n" +
          "- If helpful, recommend relevant learning resources or key concepts.\n" +
          "- Be encouraging and constructive in your feedback.\n" +
          "- You may receive problem descriptions, code outputs, and hidden test results.\n" +
          "- Use all available context to provide better guidance.\n\n";
      
      // ========== 🔥 API Format Support ==========
      let feedback: string;
      try {
        if (apiFormat === 'ollama') {
          // Ollama API format
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
          
          feedback = fullResponse;
          
        } else {
          // OpenAI API format (default)
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
        
        // ========== Feedback Validation ==========
        const validation = validateFeedback(feedback, templateId);
        
        if (!validation.isValid) {
          console.warn('⚠️ Feedback validation failed:', validation.warnings);
          
          const hasCriticalViolations = validation.warnings.some(warning => 
            warning.includes('Contains code solutions') || warning.includes('Contains code blocks')
          );
          
          if (hasCriticalViolations && retryCount < MAX_RETRIES) {
            console.log(`🔄 Auto-regenerating feedback (attempt ${retryCount + 1}/${MAX_RETRIES + 1})`);
            vscode.window.showInformationMessage(
              `🚫 AI provided code instead of guidance. Auto-regenerating... (${retryCount + 1}/${MAX_RETRIES + 1})`
            );
            
            return await generateAIFeedback(cell, retryCount + 1);
            
          } else if (hasCriticalViolations && retryCount >= MAX_RETRIES) {
            vscode.window.showErrorMessage(
              '❌ Unable to generate proper educational feedback after multiple attempts. Please try again later or check template settings.'
            );
            return;
            
          } else {
            const action = await vscode.window.showWarningMessage(
              `AI Feedback format issues:\n${validation.warnings.join('\n')}\n\nProceed anyway?`,
              'Insert Anyway',
              'Cancel'
            );
            
            if (action === 'Cancel') {
              return;
            }
          }
        } else if (validation.warnings.length > 0) {
          console.info('ℹ️ Feedback warnings:', validation.warnings);
        }
        
        if (retryCount > 0 && validation.isValid) {
          vscode.window.showInformationMessage(`✅ Generated proper educational feedback on attempt ${retryCount + 1}`);
        }

      } catch (e: any) {
        console.error('=== API Error Debug ===');
        console.error('Error:', e);
        console.error('Error Response:', e.response?.data);
        console.error('Error Status:', e.response?.status);
        console.error('=== End API Error Debug ===');
        
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
    console.log(`📋 Template cache initialized with ${cachedTemplates.length} templates`);
  }).catch(error => {
    console.warn('⚠️ Failed to initialize template cache:', error);
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

  // 🔥 Exercise management command (from v0.1.0)
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