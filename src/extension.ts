import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import axios from 'axios';
import simpleGit, { SimpleGit } from 'simple-git';

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

async function listLocalTemplates(): Promise<{ id: string, filename: string, description?: string }[]> {
  const promptsDir = path.join(LOCAL_REPO_PATH, 'prompts');
  if (!fs.existsSync(promptsDir)) return [];
  
  const templates = [];
  const files = fs.readdirSync(promptsDir).filter(f => f.endsWith('.txt'));
  
  for (const file of files) {
    const id = path.basename(file, '.txt');
    let description = '';
    
    try {
      // Try to extract description from the template file
      const content = fs.readFileSync(path.join(promptsDir, file), 'utf8');
      const lines = content.split('\n').slice(0, 10); // Check first 10 lines
      
      // Look for description patterns
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
      
      // Fallback: use template name-based description
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
  
  // Sort templates: put common ones first
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
  
  // Look backwards for markdown cells that might contain problem description
  for (let i = currentIndex - 1; i >= 0; i--) {
    const cell = editor.notebook.cellAt(i);
    
    // If find a markdown cell, extract its content
    if (cell.kind === vscode.NotebookCellKind.Markup) {
      const content = cell.document.getText().trim();
      
      // Skip empty markdown cells
      if (!content) continue;
      
      // Add this markdown content to problem description
      problemDescription = content + '\n\n' + problemDescription;
      
      // Stop after finding substantial content or reaching reasonable limit
      if (content.length > 100 || problemDescription.length > 1000) {
        break;
      }
    }
    
    // Stop looking if encounter another code cell (end of current problem scope)
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

// ========== Quick Template Switching ==========
async function quickTemplateSwitch(): Promise<void> {
  const templates = await getAvailableTemplates();
  const currentTemplateId = getCurrentTemplateId();
  
  if (templates.length <= 1) {
    vscode.window.showInformationMessage('Only one template available. Use "Refresh Templates" to check for more.');
    return;
  }
  
  // Create a simple quick pick for fast switching between common templates
  const quickItems = templates.slice(0, 5).map(template => ({
    label: template.id === currentTemplateId ? `$(check) ${template.id}` : `$(file-text) ${template.id}`,
    description: template.description,
    templateId: template.id
  }));
  
  // Add "More templates..." option if there are many templates
  if (templates.length > 5) {
    quickItems.push({
      label: '$(ellipsis) More templates...',
      description: `Show all ${templates.length} available templates`,
      templateId: '__more__'
    });
  }
  
  const selected = await vscode.window.showQuickPick(quickItems, {
    title: 'Quick Template Switch',
    placeHolder: `Current: ${currentTemplateId}`
  });
  
  if (selected) {
    if (selected.templateId === '__more__') {
      return showTemplateSelector();
    } else if (selected.templateId !== currentTemplateId) {
      await setCurrentTemplateId(selected.templateId);
      vscode.window.showInformationMessage(`✅ Template switched to: ${selected.templateId}`);
    }
  }
}

// ========== Template Selection Function ==========
async function showTemplateSelector(): Promise<void> {
  try {
    // Show loading with progress
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Loading available templates...',
      cancellable: false
    }, async (progress) => {
      progress.report({ increment: 50, message: 'Syncing repository...' });
      
      // Get available templates
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
          return showTemplateSelector(); // Retry
        } else if (action === 'Check Settings') {
          vscode.commands.executeCommand('workbench.action.openSettings', 'jupyterAiFeedback');
        }
        return;
      }
      
      // Get current template
      const currentTemplateId = getCurrentTemplateId();
      
      // Create QuickPick items with enhanced information
      const items: vscode.QuickPickItem[] = templates.map(template => {
        const isCurrent = template.id === currentTemplateId;
        return {
          label: `${isCurrent ? '$(check) ' : '$(file-text) '}${template.id}`,
          description: template.description,
          detail: `File: ${template.filename}${isCurrent ? ' (current)' : ''}`,
          picked: isCurrent
        };
      });
      
      // Add refresh option at the top
      items.unshift({
        label: '$(refresh) Refresh Templates',
        description: 'Reload templates from GitHub repository',
        detail: 'Click to check for new or updated templates'
      });
      
      // Show QuickPick
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
          return showTemplateSelector(); // Show selector again with refreshed list
        } else {
          // Extract template ID from label
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
  
  // Replace all placeholders with their values
  for (const [key, value] of Object.entries(placeholders)) {
    const placeholder = `{{${key}}}`;
    result = result.replace(new RegExp(placeholder, 'g'), value);
  }
  
  // Clean up any remaining empty placeholders (in case template has placeholders we don't provide)
  result = result.replace(/\{\{[^}]+\}\}/g, '');
  
  // Clean up extra whitespace that might result from empty placeholders
  result = result.replace(/\n\s*\n\s*\n/g, '\n\n');
  
  return result.trim();
}

async function executeAndGetOutput(cell: vscode.NotebookCell): Promise<{ hasOutput: boolean, output: string, executionError: boolean }> {
  try {
    // Execute the cell
    await vscode.commands.executeCommand('notebook.cell.execute', { ranges: [{ start: cell.index, end: cell.index + 1 }] });
    
    // Wait a bit for execution to complete and outputs to be available
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Now get the output
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
  
  // Check if cell has any outputs
  if (cell.outputs && cell.outputs.length > 0) {
    hasOutput = true;
    for (const output of cell.outputs) {
      // Handle different types of outputs
      for (const item of output.items) {
        // Text output (print statements, errors, etc.)
        if (item.mime === 'text/plain') {
          const decoder = new TextDecoder();
          outputText += decoder.decode(item.data) + '\n';
        }
        // Error output
        else if (item.mime === 'application/vnd.code.notebook.error') {
          const decoder = new TextDecoder();
          outputText += '[ERROR] ' + decoder.decode(item.data) + '\n';
          executionError = true;
        }
        // HTML output (for rich displays)
        else if (item.mime === 'text/html') {
          const decoder = new TextDecoder();
          const htmlContent = decoder.decode(item.data);
          // Strip HTML tags for cleaner text
          const textOnly = htmlContent.replace(/<[^>]*>/g, '');
          outputText += textOnly + '\n';
        }
      }
    }
  }
  
  return { hasOutput, output: outputText.trim(), executionError };
}

// ========== Enhanced Sentence Counting Function ==========
function countSentences(text: string): number {
  // Clean the text first - remove markdown formatting, code blocks, etc.
  let cleanText = text
    .replace(/```[\s\S]*?```/g, '') // Remove code blocks
    .replace(/`[^`]+`/g, '')        // Remove inline code
    .replace(/\*\*([^*]+)\*\*/g, '$1') // Remove bold formatting
    .replace(/\*([^*]+)\*/g, '$1')     // Remove italic formatting
    .replace(/#{1,6}\s+/g, '')         // Remove markdown headers
    .replace(/^\s*[-*+]\s+/gm, '')     // Remove list items
    .replace(/^\s*\d+\.\s+/gm, '')     // Remove numbered lists
    .trim();

  if (!cleanText) return 0;

  // Split by sentence endings: . ! ? 
  // But be careful with abbreviations and decimals
  const sentences = cleanText
    .split(/[.!?]+/)
    .map(s => s.trim())
    .filter(s => {
      // Filter out empty strings and very short fragments
      if (!s || s.length < 10) return false;
      
      // Filter out fragments that are just numbers or single words
      if (/^\d+(\.\d+)?$/.test(s)) return false;
      if (/^\w+$/.test(s) && !['yes', 'no', 'true', 'false'].includes(s.toLowerCase())) return false;
      
      return true;
    });

  return sentences.length;
}

// ========== Updated Feedback Validation Function (Sentence-based) ==========
function validateFeedback(feedback: string, templateId: string): { isValid: boolean, warnings: string[] } {
  const warnings: string[] = [];
  let isValid = true;

  // Check for code blocks
  if (feedback.includes('```')) {
    warnings.push('🚫 Contains code blocks - should use guiding questions instead');
    isValid = false;
  }

  // Check for complete code solutions
  const codePatterns = [
    /def\s+\w+\s*\([^)]*\)\s*:/,     // function definitions
    /class\s+\w+/,                  // class definitions
    /return\s+[\w\s+\-*\/]+/,       // return statements
    /if\s+[\w\s]+:/,                // if statements
    /for\s+\w+\s+in\s+/,            // for loops
    /while\s+[\w\s]+:/,             // while loops
  ];

  for (const pattern of codePatterns) {
    if (pattern.test(feedback)) {
      warnings.push('🚫 Contains code solutions - should only provide hints');
      isValid = false;
      break;
    }
  }

  // Sentence count limit for leveled feedback templates
  if (templateId === 'four_level' || templateId === 'fourLevel' || templateId === 'leveled_feedback') {
    const sentenceCount = countSentences(feedback);
    
    // Different limits based on feedback level
    const detectedLevel = extractFeedbackLevel(feedback);
    let maxSentences = 5; // default
    let minSentences = 2; // minimum for complete feedback
    
    switch (detectedLevel) {
      case 'EXCELLENT':
        maxSentences = 4; // Celebrate + suggest extensions
        minSentences = 2;
        break;
      case 'TARGETED':
        maxSentences = 3; // Simple syntax issues
        minSentences = 2;
        break;
      case 'TACTICAL':
        maxSentences = 4; // Style explanations
        minSentences = 2;
        break;
      case 'STRATEGIC':
        maxSentences = 5; // Complex restructuring
        minSentences = 3;
        break;
      case 'CONCEPTUAL':
        maxSentences = 5; // Concept guidance
        minSentences = 3;
        break;
      default:
        maxSentences = 4; // General fallback
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

  // Check for leveled format (warning only, not invalid)
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

  // Add Leveled detection if it's a leveled feedback template
  let enhancedFeedback = feedback;
  if (templateId === 'four_level' || templateId === 'fourLevel' || templateId === 'leveled_feedback') {
    const detectedLevel = extractFeedbackLevel(feedback);
    if (detectedLevel) {
      console.log(`Leveled feedback classification detected: ${detectedLevel}`);
    }
  }

  // Insert an empty Markdown cell
  await vscode.commands.executeCommand('notebook.cell.insertMarkdownCellBelow');

  // Find the newly inserted cell
  const newCell = editor.notebook.cellAt(cell.index + 1);
  const doc = newCell.document;

  // Replace the cell content with WorkspaceEdit
  const lastLine = doc.lineCount > 0 ? doc.lineCount - 1 : 0;
  const fullRange = new vscode.Range(
    0,
    0,
    lastLine,
    doc.lineAt(lastLine).text.length
  );
  
  // Enhanced feedback formatting
  let feedbackIcon = '🧠';
  let feedbackTitle = 'AI Feedback';
  
  if (templateId === 'four_level' || templateId === 'fourLevel' || templateId === 'leveled_feedback') {
    // Try to extract emoji from feedback for Leveled system
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
  const MAX_RETRIES = 2; // Maximum number of auto-retries
  
  const config = vscode.workspace.getConfiguration('jupyterAiFeedback');
  const templateId = getCurrentTemplateId();
  const apiUrl = config.get<string>('apiUrl') || '';
  const apiKey = config.get<string>('apiKey') || '';
  const modelName = config.get<string>('modelName') || '';
  const includeProblemDescription = config.get<boolean>('includeProblemDescription', true);
  const includeCodeOutput = config.get<boolean>('includeCodeOutput', true);
  const autoExecuteCode = config.get<boolean>('autoExecuteCode', true);
  
  console.log('=== AI Feedback Configuration ===');
  console.log('templateId:', templateId);
  console.log('modelName:', modelName);
  console.log('apiUrl:', apiUrl);
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

  // ========== Extract Additional Context ==========
  // Get problem description from previous markdown cells (if enabled)
  const problemDescription = includeProblemDescription ? getProblemDescription(activeEditor, cell) : '';
  
  // Auto-execute code and get output (if enabled)
  let cellOutputResult = { hasOutput: false, output: '', executionError: false };
  
  if (includeCodeOutput) {
    if (autoExecuteCode) {
      // First, execute the cell to get fresh output
      console.log('🔄 Auto-executing code cell...');
      try {
        cellOutputResult = await executeAndGetOutput(cell);
      } catch (error) {
        console.warn('⚠️ Failed to auto-execute cell:', error);
        cellOutputResult = getCellOutput(cell); // Fallback to existing output
      }
    } else {
      // Just get existing output without executing
      cellOutputResult = getCellOutput(cell);
    }
  }
  
  console.log('=== Context Extraction ===');
  console.log('Include Problem Description:', includeProblemDescription);
  console.log('Include Code Output:', includeCodeOutput);
  console.log('Auto Execute Code:', autoExecuteCode);
  console.log('Problem Description Length:', problemDescription.length);
  console.log('Has Output:', cellOutputResult.hasOutput);
  console.log('Output Length:', cellOutputResult.output.length);
  console.log('Execution Error:', cellOutputResult.executionError);
  console.log('=== End Context ===');

  // Check API configuration
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
      
      // Git repository sync
      await syncGitRepo();
      
      progress.report({ increment: 20, message: 'Loading template...' });
      
      // Get prompt content from Git repository
      let userPrompt: string;
      try {
        userPrompt = await getPromptContent(templateId);
      } catch (error: any) {
        vscode.window.showErrorMessage(`Template '${templateId}' not found: ${error.message}`);
        return;
      }
      
      progress.report({ increment: 30, message: 'Extracting context...' });
      
      // ========== Extract Additional Context ==========
      // Get problem description from previous markdown cells (if enabled)
      const problemDescription = includeProblemDescription ? getProblemDescription(activeEditor, cell) : '';
      
      // Auto-execute code and get output (if enabled)
      let cellOutputResult = { hasOutput: false, output: '', executionError: false };
      
      if (includeCodeOutput) {
        if (autoExecuteCode) {
          // First, execute the cell to get fresh output
          progress.report({ increment: 40, message: 'Auto-executing code...' });
          console.log('🔄 Auto-executing code cell...');
          try {
            cellOutputResult = await executeAndGetOutput(cell);
          } catch (error) {
            console.warn('⚠️ Failed to auto-execute cell:', error);
            cellOutputResult = getCellOutput(cell); // Fallback to existing output
          }
        } else {
          // Just get existing output without executing
          cellOutputResult = getCellOutput(cell);
        }
      }
      
      console.log('=== Context Extraction ===');
      console.log('Include Problem Description:', includeProblemDescription);
      console.log('Include Code Output:', includeCodeOutput);
      console.log('Auto Execute Code:', autoExecuteCode);
      console.log('Problem Description Length:', problemDescription.length);
      console.log('Has Output:', cellOutputResult.hasOutput);
      console.log('Output Length:', cellOutputResult.output.length);
      console.log('Execution Error:', cellOutputResult.executionError);
      console.log('=== End Context ===');
      
      // ========== Build Context for Template Placeholders ==========
      
      // Prepare problem description context
      let problemContext = '';
      if (problemDescription) {
        problemContext = `## Problem Description\n${problemDescription}\n`;
      }
      
      // Prepare code output context
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
        'code_output': outputContext
      };
      
      const contextualPrompt = processTemplate(userPrompt, placeholders);
      
      console.log('=== Final Prompt Preview ===');
      console.log('Total Length:', contextualPrompt.length);
      console.log('Has Problem Description:', !!problemDescription);
      console.log('Has Output:', cellOutputResult.hasOutput);
      console.log('Output Content:', !!cellOutputResult.output);
      console.log('Auto Executed:', autoExecuteCode);
      console.log('Template Placeholders:', Object.keys(placeholders));
      console.log('=== End Prompt Preview ===');
      
      progress.report({ increment: 60, message: 'Calling AI API...' });
      
      // Enhanced system prompt to prevent code solutions
      const system_role = retryCount > 0 
        ? "You are a Python teaching assistant. CRITICAL: You must NEVER provide any code solutions or code blocks. " +
          "ONLY ask guiding questions and provide conceptual hints. " +
          "Students must discover solutions themselves through your questions. " +
          "Keep responses under 100 words. Use the four-level format if specified in template. " +
          "You may receive problem descriptions and code outputs - use them for better guidance. " +
          "If code hasn't been executed, suggest testing it first to see what happens."
        : "You are a patient and detail-oriented Python teaching assistant. " +
          "Based on the analysis below, provide step-by-step, targeted feedback:\n" +
          "- Ask leading questions that guide the student toward discovering the solution, rather than giving full code.\n" +
          "- If helpful, recommend relevant learning resources or key concepts.\n" +
          "- Be encouraging and constructive in your feedback.\n" +
          "- You may receive problem descriptions from markdown cells and code outputs.\n" +
          "- If code hasn't been executed yet, consider suggesting the student run it first to see what happens.\n" +
          "- Use all available context (problem description, code, and output status) to provide better guidance.\n\n";
      
      // OpenAI API body structure
      const body = {
        model: modelName,
        messages: [
          { role: 'system', content: system_role },
          { role: 'user', content: contextualPrompt }
        ]
      };
      
      // API call logic
      let feedback: string;
      try {
        console.log('=== API Request Debug ===');
        console.log('API URL:', apiUrl);
        console.log('Model Name:', modelName);
        console.log('Request Body:', JSON.stringify(body, null, 2));
        console.log('=== End API Request Debug ===');
        
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
        
        console.log('=== API Response Debug ===');
        console.log('Response Status:', resp.status);
        console.log('Response Data:', JSON.stringify(resp.data, null, 2));
        console.log('Response Headers:', resp.headers);
        console.log('=== End API Response Debug ===');
        
        // Check if response is in OpenAI format
        if (resp.data && resp.data.choices && resp.data.choices.length > 0) {
          feedback = resp.data.choices[0].message.content;
          console.log('✅ OpenAI format response parsed successfully');
          
          // ========== Feedback Validation ==========
          const validation = validateFeedback(feedback, templateId);
          
          if (!validation.isValid) {
            console.warn('⚠️ Feedback validation failed:', validation.warnings);
            
            // Check for critical violations (code solutions)
            const hasCriticalViolations = validation.warnings.some(warning => 
              warning.includes('Contains code solutions') || warning.includes('Contains code blocks')
            );
            
            if (hasCriticalViolations && retryCount < MAX_RETRIES) {
              // Auto-regenerate for critical educational violations
              console.log(`🔄 Auto-regenerating feedback (attempt ${retryCount + 1}/${MAX_RETRIES + 1})`);
              vscode.window.showInformationMessage(
                `🚫 AI provided code instead of guidance. Auto-regenerating... (${retryCount + 1}/${MAX_RETRIES + 1})`
              );
              
              // Recursive call with incremented retry count
              return await generateAIFeedback(cell, retryCount + 1);
              
            } else if (hasCriticalViolations && retryCount >= MAX_RETRIES) {
              // Max retries reached, give up
              vscode.window.showErrorMessage(
                '❌ Unable to generate proper educational feedback after multiple attempts. Please try again later or check template settings.'
              );
              return;
              
            } else {
              // For non-critical issues (word count, format), give user choice
              const action = await vscode.window.showWarningMessage(
                `AI Feedback format issues:\n${validation.warnings.join('\n')}\n\nProceed anyway?`,
                'Insert Anyway',
                'Cancel'
              );
              
              if (action === 'Cancel') {
                return;
              }
              // If 'Insert Anyway', continue execution
            }
          } else if (validation.warnings.length > 0) {
            console.info('ℹ️ Feedback warnings:', validation.warnings);
            // Log warnings but don't block insertion
          }
          
          // If this is a retry and got valid feedback, show success message
          if (retryCount > 0 && validation.isValid) {
            vscode.window.showInformationMessage(`✅ Generated proper educational feedback on attempt ${retryCount + 1}`);
          }
          
        } else {
          console.error('❌ Invalid response format from Open WebUI');
          console.error('Expected: {choices: [{message: {content: "..."}}]}');
          console.error('Received:', resp.data);
          return vscode.window.showErrorMessage('Invalid response format from Open WebUI API.');
        }

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
        
        // Error handling for common HTTP status codes
        if (e.response?.status === 405) {
          errorMessage += '\n\n🔧 Method Not Allowed (405) - Check your API URL:';
          errorMessage += '\n✅ Should be: http://your-server:8080/api/chat/completions';
          errorMessage += '\n❌ NOT: http://your-server:8080/api/generate';
        } else if (e.response?.status === 401) {
          errorMessage += '\n\n🔑 Authentication failed - Check your API key';
        } else if (e.response?.status === 404) {
          errorMessage += '\n\n🔍 Endpoint not found - Verify your API URL';
        }
        
        return vscode.window.showErrorMessage(errorMessage);
      }
      
      progress.report({ increment: 90, message: 'Inserting feedback...' });
      
      // Insert feedback with optional Four Level detection
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
  
  // Store extension context for global state access
  extensionContext = ctx;
  
  // Initialize template cache on activation
  refreshTemplateCache().then(() => {
    updateStatusBar();
    console.log(`📋 Template cache initialized with ${cachedTemplates.length} templates`);
  }).catch(error => {
    console.warn('⚠️ Failed to initialize template cache:', error);
    updateStatusBar(); // Still show status bar with default
  });

  // Initialize status bar
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

  // Command executed when button is clicked
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

  // ========== Template Selection Commands ==========
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
      'jupyterAiFeedback.quickSwitch', 
      async () => {
        await quickTemplateSwitch();
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

  // Register status bar item for cleanup
  if (statusBarItem) {
    ctx.subscriptions.push(statusBarItem);
  }
}

export function deactivate() {
  console.log('👋 Jupyter AI Feedback extension deactivated');
  
  // Clean up status bar item
  if (statusBarItem) {
    statusBarItem.dispose();
  }
}