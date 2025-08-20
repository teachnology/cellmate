import * as vscode from 'vscode';
import axios from 'axios';
import * as path from 'path';
import { toggleRecording } from './speech';
import { killLocal } from './localServer';
import { setExtensionContext } from './localServer';
import { 
  syncGitRepo, 
  getPromptContent, 
  getTestFiles, 
  listLocalExercises, 
  listLocalTemplates,
  LOCAL_REPO_PATH,
} from './gitUtils';
import {
  getNotebookPythonPath,
  checkPytestInstalled,
  ensurePythonDeps,
  runLocalTest,
  generateSuggestions,
  generateConciseTestSummary
} from './testUtils';
import {
  extractPromptId,
  extractExerciseId,
  getTemplatePlaceholderKeys,
  extractPromptPlaceholders,
  fillPromptTemplate
} from './promptUtils';

const chan = vscode.window.createOutputChannel("Jupyter AI Feedback");
function toStr(x:any){ try{ return typeof x==='string'?x:JSON.stringify(x,(_k,v)=>v,2);}catch{ return String(x);} }
export function log(...args:any[]){ chan.appendLine(`[${new Date().toISOString()}] ` + args.map(toStr).join(" ")); console.log(...args); }
export function showLog(preserveFocus=true){ chan.show(preserveFocus); }

let recording = false;

// LLM API configuration interface
interface LLMConfig {
  apiUrl: string;
  apiKey: string;
  modelName: string;
}

// Chat message interface
interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

// Error Helper Panel for chat functionality
class ErrorHelperPanel {
  public static currentPanel: ErrorHelperPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private cell: vscode.NotebookCell;
  private messages: ChatMessage[] = [];
  private config: LLMConfig;
  private errorHelperFeedback: string;
  private problemDescription: string;

  public static createOrShow(extensionUri: vscode.Uri, cell: vscode.NotebookCell, config: LLMConfig, errorHelperFeedback?: string, problemDescription?: string): void {
    const column = vscode.ViewColumn.Two;

    // If we already have a panel, show it
    if (ErrorHelperPanel.currentPanel) {
      ErrorHelperPanel.currentPanel.panel.reveal(column);
      ErrorHelperPanel.currentPanel.updateCell(cell, errorHelperFeedback, problemDescription);
      return;
    }

    // Otherwise, create a new panel
    const panel = vscode.window.createWebviewPanel(
      'errorHelperChat',
      'Error Helper Chat',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri]
      }
    );

    ErrorHelperPanel.currentPanel = new ErrorHelperPanel(panel, extensionUri, cell, config, errorHelperFeedback || '', problemDescription || '');
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, cell: vscode.NotebookCell, config: LLMConfig, errorHelperFeedback: string, problemDescription: string) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.cell = cell;
    this.config = config;
    this.errorHelperFeedback = errorHelperFeedback;
    this.problemDescription = problemDescription;

    // Set the webview's initial html content
    this.update();

    // Listen for when the panel is disposed
    this.panel.onDidDispose(() => this.dispose(), null);

    // Handle messages from the webview
    this.panel.webview.onDidReceiveMessage(
      async (message: { command: string; text?: string }) => {
        try {
          switch (message.command) {
            case 'sendMessage':
              if (message.text) {
                await this.handleUserMessage(message.text);
              }
              break;
            default:
              console.warn('Unknown message command:', message.command);
          }
        } catch (error) {
          console.error('Error handling webview message:', error);
        }
      }
    );
  }

  private async handleUserMessage(userMessage: string) {
    // Add user message
    this.messages.push({
      role: 'user',
      content: userMessage,
      timestamp: Date.now()
    });

    // Update UI to show user message and typing indicator
    await this.updateMessages();

    try {
      // Generate AI response
      const aiResponse = await this.generateAIResponse(userMessage);

      // Add AI message
      this.messages.push({
        role: 'assistant',
        content: aiResponse,
        timestamp: Date.now()
      });

      // Update UI with AI response
      await this.updateMessages();

    } catch (error) {
      console.error('Error generating AI response:', error);
      this.messages.push({
        role: 'assistant',
        content: 'Sorry, I encountered an error while generating a response. Please try again.',
        timestamp: Date.now()
      });
      await this.updateMessages();
    }
  }

  private async generateAIResponse(userMessage: string): Promise<string> {
    const code = this.cell.document.getText();
    const cellOutput = getCellOutput(this.cell);

    // Build conversation context
    const conversationHistory = this.messages.slice(-6).map(msg =>
      `${msg.role === 'user' ? 'Student' : 'AI Helper'}: ${msg.content}`
    ).join('\n\n');

    try {
      // Use GitHub template system for chat prompts
      await syncGitRepo();

      const chatTemplateId = 'error_chat';
      const promptTemplate = await getPromptContent(chatTemplateId);

      let prompt = promptTemplate.replace('{{code}}', code);
      prompt = prompt.replace('{{error_output}}', cellOutput.output);
      prompt = prompt.replace('{{conversation_history}}', conversationHistory);
      prompt = prompt.replace('{{user_message}}', userMessage);

      // Handle error_helper_feedback - if empty, remove the section
      if (this.errorHelperFeedback && this.errorHelperFeedback.trim()) {
        prompt = prompt.replace('{{error_helper_feedback}}', this.errorHelperFeedback);
      } else {
        // Remove the entire Previous Error Helper Analysis section if no feedback
        prompt = prompt.replace(/\*\*Previous Error Helper Analysis:\*\*\s*\{\{error_helper_feedback\}\}\s*\n\n?/g, '');
        // Fallback: just replace the placeholder with empty string
        prompt = prompt.replace('{{error_helper_feedback}}', '');
      }

      // Handle problem_description
      if (this.problemDescription && this.problemDescription.trim()) {
        prompt = prompt.replace('{{problem_description}}', this.problemDescription);
      } else {
        prompt = prompt.replace(/\*\*Problem Description:\*\*\s*\{\{problem_description\}\}\s*\n\n?/g, '');
        prompt = prompt.replace('{{problem_description}}', '');
      }

      return await callLLMAPI(prompt, this.config);
    } catch (error) {
      console.error('Failed to load chat template, using fallback:', error);

      // Fallback prompt if template loading fails
      const fallbackPrompt = `You are a helpful Python programming tutor. 

**Code:** ${code}
**Error:** ${cellOutput.output}
${this.problemDescription ? `**Problem Context:** ${this.problemDescription}` : ''}
${this.errorHelperFeedback ? `**Previous Analysis:** ${this.errorHelperFeedback}` : ''}
**Question:** ${userMessage}

Please provide a helpful response based on the code, error${this.problemDescription ? ', problem context' : ''}${this.errorHelperFeedback ? ', and previous analysis' : ''}.`;

      return await callLLMAPI(fallbackPrompt, this.config);
    }
  }

  public updateCell(cell: vscode.NotebookCell, errorHelperFeedback?: string, problemDescription?: string): void {
    this.cell = cell;
    if (errorHelperFeedback) {
      this.errorHelperFeedback = errorHelperFeedback;
    }
    if (problemDescription !== undefined) {
      this.problemDescription = problemDescription;
    }
    this.messages = []; // Reset conversation for new cell
    this.update();
  }

  private async updateMessages() {
    await this.panel.webview.postMessage({
      command: 'updateMessages',
      messages: this.messages
    });
  }

  private update() {
    const code = this.cell.document.getText();
    const cellOutput = getCellOutput(this.cell);

    this.panel.webview.html = this.getHtmlForWebview(code, cellOutput.output, this.errorHelperFeedback, this.problemDescription);
  }

  private getHtmlForWebview(code: string, errorOutput: string, errorHelperFeedback: string, problemDescription: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Error Helper Chat</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            height: 100vh;
            display: flex;
            flex-direction: column;
        }

        .chat-header {
            background: var(--vscode-tab-activeBackground);
            padding: 15px;
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            align-items: center;
            justify-content: space-between;
        }

        .chat-title {
            display: flex;
            align-items: center;
            font-size: 14px;
            font-weight: 500;
        }

        .chat-title span {
            font-size: 18px;
            margin-right: 8px;
        }

        .context-section {
            background: var(--vscode-input-background);
            border-bottom: 1px solid var(--vscode-panel-border);
            max-height: 300px;
            overflow-y: auto;
        }

        .context-header {
            padding: 12px 15px 8px;
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            font-weight: 500;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        .context-content {
            padding: 0 15px 12px;
            font-family: 'Consolas', monospace;
            font-size: 12px;
            background: var(--vscode-textCodeBlock-background);
            margin: 0 15px 12px;
            border-radius: 4px;
            padding: 10px;
            border-left: 3px solid var(--vscode-inputValidation-errorBorder);
            white-space: pre-wrap;
            word-wrap: break-word;
        }

        .feedback-content {
            padding: 0 15px 12px;
            font-size: 12px;
            background: var(--vscode-editor-hoverHighlightBackground);
            margin: 0 15px 12px;
            border-radius: 4px;
            padding: 10px;
            border-left: 3px solid var(--vscode-textLink-foreground);
            white-space: pre-wrap;
            word-wrap: break-word;
        }

        .problem-content {
            padding: 0 15px 12px;
            font-size: 12px;
            background: var(--vscode-editor-inactiveSelectionBackground);
            margin: 0 15px 12px;
            border-radius: 4px;
            padding: 10px;
            border-left: 3px solid var(--vscode-textLink-activeForeground);
            white-space: pre-wrap;
            word-wrap: break-word;
        }

        .chat-messages {
            flex: 1;
            overflow-y: auto;
            padding: 15px;
            display: flex;
            flex-direction: column;
            gap: 12px;
        }

        .message {
            max-width: 85%;
            word-wrap: break-word;
        }

        .user-message {
            align-self: flex-end;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            padding: 10px 12px;
            border-radius: 12px 12px 4px 12px;
            font-size: 13px;
            line-height: 1.4;
        }

        .ai-message {
            align-self: flex-start;
            background: var(--vscode-editor-hoverHighlightBackground);
            color: var(--vscode-editor-foreground);
            padding: 12px;
            border-radius: 12px 12px 12px 4px;
            border-left: 3px solid var(--vscode-textLink-foreground);
            font-size: 13px;
            line-height: 1.5;
        }

        .ai-message .message-header {
            display: flex;
            align-items: center;
            margin-bottom: 8px;
            font-size: 12px;
            color: var(--vscode-textLink-foreground);
            font-weight: 500;
        }

        .ai-message .message-header span {
            margin-right: 6px;
        }

        .code-block {
            background: var(--vscode-textCodeBlock-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            padding: 10px;
            margin: 8px 0;
            font-family: 'Consolas', monospace;
            font-size: 12px;
            overflow-x: auto;
        }

        .typing-indicator {
            align-self: flex-start;
            background: var(--vscode-editor-hoverHighlightBackground);
            padding: 12px;
            border-radius: 12px 12px 12px 4px;
            border-left: 3px solid var(--vscode-textLink-foreground);
            opacity: 0.7;
        }

        .typing-dots {
            display: flex;
            gap: 4px;
        }

        .typing-dots span {
            width: 6px;
            height: 6px;
            background: var(--vscode-textLink-foreground);
            border-radius: 50%;
            animation: typing 1.4s infinite;
        }

        .typing-dots span:nth-child(2) {
            animation-delay: 0.2s;
        }

        .typing-dots span:nth-child(3) {
            animation-delay: 0.4s;
        }

        @keyframes typing {
            0%, 60%, 100% { opacity: 0.3; }
            30% { opacity: 1; }
        }

        .chat-input {
            background: var(--vscode-tab-activeBackground);
            padding: 15px;
            border-top: 1px solid var(--vscode-panel-border);
        }

        .input-container {
            display: flex;
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 6px;
            overflow: hidden;
        }

        .message-input {
            flex: 1;
            background: none;
            border: none;
            padding: 12px;
            color: var(--vscode-input-foreground);
            font-size: 13px;
            outline: none;
            resize: none;
            min-height: 40px;
            max-height: 120px;
        }

        .message-input::placeholder {
            color: var(--vscode-input-placeholderForeground);
        }

        .send-button {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 0 15px;
            cursor: pointer;
            font-size: 14px;
            transition: background 0.2s;
        }

        .send-button:hover {
            background: var(--vscode-button-hoverBackground);
        }

        .send-button:disabled {
            background: var(--vscode-button-secondaryBackground);
            cursor: not-allowed;
        }

        ::-webkit-scrollbar {
            width: 8px;
        }

        ::-webkit-scrollbar-track {
            background: var(--vscode-scrollbarSlider-background);
        }

        ::-webkit-scrollbar-thumb {
            background: var(--vscode-scrollbarSlider-background);
            border-radius: 4px;
        }

        ::-webkit-scrollbar-thumb:hover {
            background: var(--vscode-scrollbarSlider-hoverBackground);
        }
    </style>
</head>
<body>
    <div class="chat-header">
        <div class="chat-title">
            <span>💬</span>
            Error Helper Chat
        </div>
    </div>

    <div class="context-section">
        ${problemDescription ? `
        <div class="context-header">Problem Description</div>
        <div class="problem-content">${problemDescription}</div>
        ` : ''}
        <div class="context-header">Code & Error Context</div>
        <div class="context-content">${code}

❌ Error Output:
${errorOutput}</div>
        ${errorHelperFeedback ? `
        <div class="context-header">Previous Analysis</div>
        <div class="feedback-content">${errorHelperFeedback}</div>
        ` : ''}
    </div>

    <div class="chat-messages" id="chatMessages">
        <div class="message ai-message">
            <div class="message-header">
                <span>🤖</span>
                AI Helper
            </div>
            <div>
                I have your code, error details${problemDescription ? ', problem description' : ''}${errorHelperFeedback ? ', and previous analysis' : ''}. What specific questions do you have about this error?
            </div>
        </div>
    </div>

    <div class="chat-input">
        <div class="input-container">
            <textarea 
                class="message-input" 
                id="messageInput"
                placeholder="Ask your follow-up questions here..."
                rows="1"
                onkeydown="handleKeyDown(event)"
            ></textarea>
            <button class="send-button" id="sendButton" onclick="sendMessage()">
                📤
            </button>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        
        function sendMessage() {
            const input = document.getElementById('messageInput');
            const message = input.value.trim();
            if (!message) return;

            addUserMessage(message);
            input.value = '';
            showTypingIndicator();
            
            vscode.postMessage({
                command: 'sendMessage',
                text: message
            });
        }

        function addUserMessage(message) {
            const chatMessages = document.getElementById('chatMessages');
            const messageDiv = document.createElement('div');
            messageDiv.className = 'message user-message';
            messageDiv.textContent = message;
            chatMessages.appendChild(messageDiv);
            chatMessages.scrollTop = chatMessages.scrollHeight;
        }

        function addAIMessage(message) {
            hideTypingIndicator();
            const chatMessages = document.getElementById('chatMessages');
            const messageDiv = document.createElement('div');
            messageDiv.className = 'message ai-message';
            messageDiv.innerHTML = \`
                <div class="message-header">
                    <span>🤖</span>
                    AI Helper
                </div>
                <div>\${formatMessage(message)}</div>
            \`;
            chatMessages.appendChild(messageDiv);
            chatMessages.scrollTop = chatMessages.scrollHeight;
        }

        function formatMessage(message) {
            // Simple formatting for code blocks
            return message.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, '<div class="code-block">$1</div>')
                         .replace(/\`([^\\n\`]+)\`/g, '<code>$1</code>')
                         .replace(/\\n/g, '<br>');
        }

        function showTypingIndicator() {
            const chatMessages = document.getElementById('chatMessages');
            const typingDiv = document.createElement('div');
            typingDiv.className = 'typing-indicator';
            typingDiv.id = 'typingIndicator';
            typingDiv.innerHTML = \`
                <div class="typing-dots">
                    <span></span>
                    <span></span>
                    <span></span>
                </div>
            \`;
            chatMessages.appendChild(typingDiv);
            chatMessages.scrollTop = chatMessages.scrollHeight;
        }

        function hideTypingIndicator() {
            const indicator = document.getElementById('typingIndicator');
            if (indicator) {
                indicator.remove();
            }
        }

        function handleKeyDown(event) {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                sendMessage();
            }
        }

        // Auto-resize textarea
        document.getElementById('messageInput').addEventListener('input', function() {
            this.style.height = 'auto';
            this.style.height = Math.min(this.scrollHeight, 120) + 'px';
        });

        // Listen for messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.command) {
                case 'updateMessages':
                    const lastMessage = message.messages[message.messages.length - 1];
                    if (lastMessage && lastMessage.role === 'assistant') {
                        addAIMessage(lastMessage.content);
                    }
                    break;
            }
        });
    </script>
</body>
</html>`;
  }

  public dispose(): void {
    ErrorHelperPanel.currentPanel = undefined;
    this.panel.dispose();
  }
}

// Add analysis to cell output as HTML
async function addAnalysisToCellOutput(cell: vscode.NotebookCell, analysis: string) {
  try {
    // Detect platform for correct keyboard shortcut
    const isMac = process.platform === 'darwin';
    const shortcut = isMac ? 'Cmd+Shift+P' : 'Ctrl+Shift+P';

    // Create markdown-formatted analysis
    const formattedAnalysis = `
## 🆘 Error Helper Analysis

${analysis}

---
💬 **Need more help?** Use Command Palette (${shortcut}) → "Start Error Helper Chat"
`;

    // Use markdown format for better rendering
    const outputItem = vscode.NotebookCellOutputItem.text(formattedAnalysis.trim(), 'text/markdown');

    // Create new output
    const newOutput = new vscode.NotebookCellOutput([outputItem]);

    // CRITICAL: Preserve ALL existing outputs and add the new one
    const existingOutputs = [...(cell.outputs || [])];
    const updatedOutputs = [...existingOutputs, newOutput];

    // Create a new cell with the same content but updated outputs
    const newCellData = new vscode.NotebookCellData(
      cell.kind,
      cell.document.getText(),
      cell.document.languageId
    );
    newCellData.outputs = updatedOutputs;
    if (cell.metadata) {
      newCellData.metadata = cell.metadata;
    }

    // Replace the cell
    const edit = new vscode.WorkspaceEdit();
    const range = new vscode.NotebookRange(cell.index, cell.index + 1);
    const notebookEdit = vscode.NotebookEdit.replaceCells(range, [newCellData]);
    edit.set(cell.notebook.uri, [notebookEdit]);

    const success = await vscode.workspace.applyEdit(edit);

    if (success) {
      console.log('Successfully added Error Helper analysis to cell output');
      console.log('Preserved', existingOutputs.length, 'existing outputs');
    } else {
      throw new Error('Failed to apply edit to notebook');
    }

  } catch (error) {
    console.error('Failed to add analysis to cell output:', error);

    // Fallback: create markdown cell instead
    console.log('Falling back to markdown cell...');
    const isMac = process.platform === 'darwin';
    const shortcut = isMac ? 'Cmd+Shift+P' : 'Ctrl+Shift+P';

    const content = `# **🆘 Error Helper**

${analysis}

---
*💬 Want to ask follow-up questions? Use Command Palette (${shortcut}) to run "Start Error Helper Chat".*`;

    const editor = vscode.window.activeNotebookEditor;
    if (editor) {
      await insertMarkdownCellBelow(editor.notebook, cell.index, content);
    } else {
      vscode.window.showInformationMessage(`Error Helper Analysis: ${analysis.substring(0, 200)}...`);
    }
  }
}

// LLM Call API, for AI Feedback and Error Helper - Modified for OpenAI format
async function callLLMAPI(prompt: string, config: LLMConfig): Promise<string> {
  // Check if using OpenAI-compatible endpoint
  const isOpenAIEndpoint = config.apiUrl.includes('/chat/completions');

  let body: any;
  if (isOpenAIEndpoint) {
    // OpenAI format for /api/chat/completions
    body = {
      model: config.modelName,
      messages: [
        {
          role: "user",
          content: prompt
        }
      ]
    };
  } else {
    // Ollama format for /ollama/api/generate
    body = {
      model: config.modelName,
      prompt: prompt
    };
  }

  console.log('=== API Request Debug ===');
  console.log('API URL:', config.apiUrl);
  console.log('Model Name:', config.modelName);
  console.log('Is OpenAI Endpoint:', isOpenAIEndpoint);
  console.log('Request Body:', JSON.stringify(body, null, 2));
  console.log('=== End API Request Debug ===');

  const resp = await axios.post(
    config.apiUrl,
    body,
    {
        headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`
        },
        responseType: isOpenAIEndpoint ? 'json' : 'text'
    }
  );

  console.log('=== API Response Debug ===');
  console.log('Response Status:', resp.status);
  console.log('Response Data:', resp.data);
  console.log('Response Headers:', resp.headers);
  console.log('=== End API Response Debug ===');

  if (isOpenAIEndpoint) {
    // Handle OpenAI format response
    if (resp.data.choices && resp.data.choices[0] && resp.data.choices[0].message) {
      return resp.data.choices[0].message.content;
    } else {
      throw new Error('Invalid OpenAI response format');
    }
  } else {
    // Handle Ollama streaming response
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
      throw new Error('No valid response content received from API.');
    }

    return fullResponse;
  }
}

// Read LLM configuration from settings
function readLLMConfig(): LLMConfig | null {
  const cfg = vscode.workspace.getConfiguration('jupyterAiFeedback');
  const apiUrl = cfg.get<string>('apiUrl') || '';
  const apiKey = cfg.get<string>('apiKey') || '';
  const modelName = cfg.get<string>('modelName') || '';

  if (!apiUrl || !apiKey || !modelName) {
    vscode.window.showErrorMessage(
      'Please configure jupyterAiFeedback.apiUrl, apiKey, and modelName in settings'
    );
    return null;
  }

  return { apiUrl, apiKey, modelName };
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
          // Fallback to raw string if JSON parsing fails
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

// Helper function: Find existing Error Helper feedback from nearby cells
function findExistingErrorHelperFeedback(cell: vscode.NotebookCell): string | undefined {
  const notebook = cell.notebook;
  const startIndex = cell.index;

  // Look in the next few cells for Error Helper feedback
  for (let i = startIndex + 1; i < Math.min(startIndex + 5, notebook.cellCount); i++) {
    const nextCell = notebook.cellAt(i);

    if (nextCell.kind === vscode.NotebookCellKind.Markup) {
      const content = nextCell.document.getText();

      // Check if this is an Error Helper markdown cell
      if (content.includes('🆘 Error Helper') || content.includes('**🆘 Error Helper**')) {
        // Extract the feedback content (skip the header)
        const lines = content.split('\n');
        const feedbackLines = [];
        let foundContent = false;

        for (const line of lines) {
          if (line.includes('🆘 Error Helper')) {
            foundContent = true;
            continue;
          }
          if (foundContent && line.trim() !== '' && !line.includes('---') && !line.includes('💬')) {
            feedbackLines.push(line);
          }
          if (line.includes('---')) {
            break; // Stop at the separator
          }
        }

        if (feedbackLines.length > 0) {
          return feedbackLines.join('\n').trim();
        }
      }
    }
  }

  // Also check if the current cell has Error Helper output
  if (cell.outputs) {
    for (const output of cell.outputs) {
      for (const item of output.items) {
        if (item.mime === 'text/markdown') {
          const decoder = new TextDecoder();
          const content = decoder.decode(item.data);

          if (content.includes('🆘 Error Helper Analysis')) {
            // Extract the analysis content
            const lines = content.split('\n');
            const analysisLines = [];
            let foundContent = false;

            for (const line of lines) {
              if (line.includes('🆘 Error Helper Analysis')) {
                foundContent = true;
                continue;
              }
              if (foundContent && line.trim() !== '' && !line.includes('---') && !line.includes('💬')) {
                analysisLines.push(line);
              }
              if (line.includes('---')) {
                break;
              }
            }

            if (analysisLines.length > 0) {
              return analysisLines.join('\n').trim();
            }
          }
        }
      }
    }
  }

  return undefined;
}

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

export function activate(ctx: vscode.ExtensionContext) {
  setExtensionContext(ctx);
  const provider: vscode.NotebookCellStatusBarItemProvider = {
    provideCellStatusBarItems(cell) {
      const items = [];
      if (cell.document.languageId === 'python') {
          const cfg = vscode.workspace.getConfiguration('jupyterAiFeedback');
          const alwaysShowErrorHelper = cfg.get<boolean>('errorHelper.alwaysShow', false);

          const cellOutput = getCellOutput(cell);
          const hasError = cellOutput.executionError ||
                          (cellOutput.hasOutput && cellOutput.output.toLowerCase().includes('error'));

          const shouldShowErrorHelper = alwaysShowErrorHelper || hasError;

          if (shouldShowErrorHelper) {
            const errorHelperItem = new vscode.NotebookCellStatusBarItem(
              '🆘 Error Helper',
              vscode.NotebookCellStatusBarAlignment.Right
            );
            errorHelperItem.priority = 200;
            errorHelperItem.command = {
              command: 'jupyterAiFeedback.errorHelper',
              title: 'Error Helper',
              arguments: [cell]
            };
            errorHelperItem.tooltip = hasError ?
              'Get AI help with this error' :
              'Get AI help with your code (no errors detected)';
            items.push(errorHelperItem);
          }

          // Original AI Feedback button
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
          items.push(item);
      }
      if (cell.document.languageId === 'markdown') {
        const speechItem = new vscode.NotebookCellStatusBarItem(
          '$(mic)',
          vscode.NotebookCellStatusBarAlignment.Right
        );
        speechItem.priority = 100;
        speechItem.command = {
          command: 'jupyterAiFeedback.toggleRecording',
          title: 'Speech to Text',
          arguments: [cell]
        };
        items.push(speechItem);
      }

      const cfg = vscode.workspace.getConfiguration('jupyterAiFeedback')
      const showAll = cfg.get<boolean>('showButtonInAllMarkdown')
      const text = cell.document.getText().toLowerCase()
      const containsFeedback = text.includes('**feedback**') || text.includes('**🤖feedback expansion**')
      if(cell.kind === vscode.NotebookCellKind.Markup && (showAll || containsFeedback)){
        const cfg = vscode.workspace.getConfiguration('jupyterAiFeedback');
        const mode = cfg.get<string>('feedbackMode');

        const label =
          mode === 'Expand'
            ? '📖 ➤ Expand | Explain'
            : '📖 Expand | ➤ Explain';

        const markdownItem = new vscode.NotebookCellStatusBarItem(
        label,
        vscode.NotebookCellStatusBarAlignment.Right
        );
        markdownItem.command = {
          command : 'jupyterAiFeedback.explainMarkdownCell',
          title: 'Expand or Explain Feedback Markdown',
          arguments:[cell]
        }
        markdownItem.priority = 100;
        markdownItem.tooltip = `Use AI to ${mode} the feedback`
        items.push(markdownItem)
      }
      return items;
    }
  };

  ctx.subscriptions.push(
    vscode.notebooks.registerNotebookCellStatusBarItemProvider('*', provider)
  );

  // Error Helper command - with intelligent state handling
  ctx.subscriptions.push(
    vscode.commands.registerCommand(
      'jupyterAiFeedback.errorHelper',
      async (cell: vscode.NotebookCell) => {
        const editor = vscode.window.activeNotebookEditor;
        if (!editor) {
          return vscode.window.showErrorMessage('No active Notebook editor');
        }

        const config = readLLMConfig();
        if (!config) return;

        const code = cell.document.getText();
        let cellOutput = getCellOutput(cell);

        // Case 1: Cell hasn't been run yet
        if (!cellOutput.hasOutput) {
          const action = await vscode.window.showInformationMessage(
            'This cell hasn\'t been run yet. Would you like to run it first to check for errors?',
            'Run and Check',
            'Cancel'
          );

          if (action !== 'Run and Check') {
            return;
          }

          // Execute the cell
          try {
            await vscode.commands.executeCommand('notebook.cell.execute', cell);

            // Wait for execution to complete (simple approach)
            await new Promise(resolve => setTimeout(resolve, 2000));

            // Re-check output after execution
            cellOutput = getCellOutput(cell);
            if (!cellOutput.hasOutput) {
              vscode.window.showWarningMessage('Cell execution may still be running. Please try again in a moment.');
              return;
            }
          } catch (error) {
            vscode.window.showErrorMessage('Failed to execute cell. Please run it manually and try again.');
            return;
          }
        }

        // Case 2: Cell ran but no errors detected
        if (!cellOutput.executionError && !cellOutput.output.toLowerCase().includes('error')) {
          const action = await vscode.window.showInformationMessage(
            'No errors found! 🎉 Consider using AI Feedback for code quality suggestions.',
            'Open AI Feedback',
            'OK'
          );

          if (action === 'Open AI Feedback') {
            await vscode.commands.executeCommand('jupyterAiFeedback.sendNotebookCell', cell);
          }
          return;
        }

        // Case 3: Cell has errors - proceed with normal analysis
        try {
          console.log('=== Error Helper Debug ===');
          console.log('Cell has', cellOutput.hasOutput ? 'output' : 'no output');
          console.log('Execution error:', cellOutput.executionError);
          console.log('Output content:', cellOutput.output.substring(0, 200));
          console.log('Current cell outputs count:', cell.outputs?.length || 0);
          console.log('=== End Debug ===');

          await syncGitRepo();
          const promptContent = await getPromptContent('error_helper');
          const placeholderKeys = getTemplatePlaceholderKeys(promptContent);
          const placeholderMap = extractPromptPlaceholders(editor.notebook, cell.index, placeholderKeys);

          placeholderMap.set('code', code);
          placeholderMap.set('code_output', cellOutput.output);

          const possibleKeys = ['problem_description', 'problem', 'exercise_description', 'task'];
          let problemDescription = '';
          
          for (const key of possibleKeys) {
            if (placeholderMap.has(key)) {
              problemDescription = placeholderMap.get(key) || '';
              if (problemDescription) {
                console.log(`Found explicitly marked problem description with key: ${key}`);
                break;
              }
            }
          }

          placeholderMap.set('problem_description', problemDescription);

          let prompt = '';
          if (problemDescription) {
            let enhancedPrompt = promptContent.replace(
              '{{problem_description}}',
              `**Problem Description:**\n${problemDescription}\n\n` +
              `**IMPORTANT:** Consider both the error AND the problem requirements when providing guidance. ` +
              `Ensure your suggestions align with the expected solution approach.`
            );
            prompt = fillPromptTemplate(enhancedPrompt, placeholderMap, editor.notebook);
            console.log('Using enhanced prompt with problem description');
          } else {
            let standardPrompt = promptContent.replace('{{problem_description}}', '');
            prompt = fillPromptTemplate(standardPrompt, placeholderMap, editor.notebook);
            console.log('Using standard prompt without problem description');
          }
          
          console.log('Problem description found:', problemDescription ? 'Yes' : 'No');
          console.log('Problem description length:', problemDescription.length);

          const feedback = await callLLMAPI(prompt, config);

          // Check output mode setting
          const cfg = vscode.workspace.getConfiguration('jupyterAiFeedback');
          const outputMode = cfg.get<string>('errorHelperOutput', 'markdown');

          console.log('Using output mode:', outputMode);

          if (outputMode === 'cellOutput') {
            await addAnalysisToCellOutput(cell, feedback);

            const action = await vscode.window.showInformationMessage(
              'Error analysis complete. Want to ask follow-up questions?',
              'Start Chat'
            );

            if (action === 'Start Chat') {
              ErrorHelperPanel.createOrShow(ctx.extensionUri, cell, config, feedback, problemDescription);
            }
          } else {
            // markdown mode
            const isMac = process.platform === 'darwin';
            const shortcut = isMac ? 'Cmd+Shift+P' : 'Ctrl+Shift+P';

            const content = `# **🆘 Error Helper**

${feedback}

---
*💬 Want to ask follow-up questions? Use Command Palette (${shortcut}) to run "Start Error Helper Chat".*`;
            await insertMarkdownCellBelow(editor.notebook, cell.index, content);

            const action = await vscode.window.showInformationMessage(
              'Error analysis complete. Want to ask follow-up questions?',
              'Start Chat'
            );

            if (action === 'Start Chat') {
              ErrorHelperPanel.createOrShow(ctx.extensionUri, cell, config, feedback, problemDescription);
            }
          }

        } catch (e: any) {
          console.error('Error Helper failed:', e);
          let errorMessage = 'Error Helper failed: ' + e.message;
          if (e.response?.data) {
            errorMessage += '\nResponse: ' + JSON.stringify(e.response.data, null, 2);
          }
          return vscode.window.showErrorMessage(errorMessage);
        }
      }
    )
  );

  // Start Error Chat command
  ctx.subscriptions.push(
    vscode.commands.registerCommand(
      'jupyterAiFeedback.startErrorChat',
      async (cell?: vscode.NotebookCell, errorHelperFeedback?: string) => {
        const config = readLLMConfig();
        if (!config) return;

        // If no cell provided, use the current active cell
        if (!cell) {
          const editor = vscode.window.activeNotebookEditor;
          if (!editor) {
            vscode.window.showErrorMessage('No active Notebook editor');
            return;
          }

          // Get currently selected cell
          const selection = editor.selections[0];
          if (!selection) {
            vscode.window.showErrorMessage('No cell selected');
            return;
          }

          cell = editor.notebook.cellAt(selection.start);
        }

        const cellOutput = getCellOutput(cell);
        if (!cellOutput.hasOutput || (!cellOutput.executionError && !cellOutput.output.toLowerCase().includes('error'))) {
          vscode.window.showInformationMessage('No errors detected in this cell. Error chat is only available for cells with errors.');
          return;
        }

        if (!errorHelperFeedback) {
          errorHelperFeedback = findExistingErrorHelperFeedback(cell);
        }

        const editor = vscode.window.activeNotebookEditor;
        let problemDescription = '';
        
        if (editor) {
          // Extract placeholders
          const placeholderKeys = new Set(['problem_description', 'problem', 'exercise_description', 'task']);
          const placeholderMap = extractPromptPlaceholders(editor.notebook, cell.index, placeholderKeys);

          // Find problem description
          const possibleKeys = ['problem_description', 'problem', 'exercise_description', 'task'];
          for (const key of possibleKeys) {
            if (placeholderMap.has(key)) {
              problemDescription = placeholderMap.get(key) || '';
              if (problemDescription) {
                console.log(`Found problem description with key: ${key} in Start Error Chat`);
                break;
              }
            }
          }
        }

        ErrorHelperPanel.createOrShow(ctx.extensionUri, cell, config, errorHelperFeedback, problemDescription);
      }
    )
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
        // log('=== Configuration Debug ===');
        // log('All jupyterAiFeedback config:', cfg);
        // log('useHiddenTests raw value:', cfg.get('useHiddenTests'));
        // log('useHiddenTests with default:', useHiddenTests);
        // log('Configuration source:', cfg.inspect('useHiddenTests'));
        // log('=== End Debug ===');
        // log('templateId:', templateId);
        // log('useHiddenTests:', useHiddenTests);
        // log('modelName:', modelName);

        if (!apiUrl || !apiKey || !modelName) {
          return vscode.window.showErrorMessage(
            'Please configure jupyterAiFeedback.apiUrl, apiKey, and modelName in settings'
          );
        }
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
          // log("pythonPath:", pythonPath)
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

          // Prepare resource directories (e.g., data/) so user code can read files
          const resourceDirs: string[] = [];
          try {
            // 1) From synced repo tests folder
            const repoDataDir = path.join(LOCAL_REPO_PATH, 'tests', exId, 'data');
            resourceDirs.push(repoDataDir);
          } catch {}

          // Run tests locally (with internal timeout guard and resource copy)
          const testResult = await runLocalTest(code, test, pythonPath, 15000, resourceDirs);

          // If timed out, annotate analysis to indicate potential infinite loop
          if (testResult?.timeout) {
            analysis += `## Test Execution Timeout\n`;
            analysis += `- Hidden tests timed out. Your code may contain an infinite loop or long-running operation.\n\n`;
          }

          // Parse test results and generate analysis
          if (testResult.report && testResult.report.tests) {
            const total = testResult.report.tests.length;
            const passed = testResult.report.tests.filter((t: any) => t.outcome === 'passed').length;
            const failed = total - passed;

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
            } else if (total === 0) {
              // if no tests are run, it means there is a code execution or syntax error
              analysis += `Hidden tests could not be run due to a code execution or syntax error.\n`;
            } else {
              analysis += `## Test Results\n`;
              analysis += `- All ${total} tests passed!\n\n`;
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
        // log("promptContent:", promptContent)
        // log("analysis:", analysis)
        let prompt = promptContent;

        // 6. Extract and fill placeholders
        const placeholderKeys = getTemplatePlaceholderKeys(promptContent);
        const placeholderMap = extractPromptPlaceholders(editor.notebook, cell.index, placeholderKeys);

        // Add special placeholders for backward compatibility
        placeholderMap.set('cell', code);

        // Check if prompt contains placeholders before getting content
        const hasCodeOutput = prompt.includes('{{code_output}}');

        // Only get cell output if placeholder exists
        if (hasCodeOutput) {
          const cellOutput = getCellOutput(cell);
          if (cellOutput.hasOutput) {
            placeholderMap.set('code_output', cellOutput.output);
            // log("cellOutput:", cellOutput.output)
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
        // log("Final prompt after filling placeholders:", prompt);

        // Add system role to the beginning of the prompt
        const system_role = "You are a Python teaching assistant for programming beginners. Given the uploaded code and optional hidden test results, offer concise code suggestions on improvement and fixing output errors without directly giving solutions. Be encouraging and constructive in your feedback. ";

        const fullPrompt = system_role + prompt;
        // log("fullPrompt:", fullPrompt)

        // Call the LLM interface
        let feedback: string;
        try {
          // Check if using OpenAI-compatible endpoint
          const isOpenAIEndpoint = apiUrl.includes('/chat/completions');

          let body: any;
          if (isOpenAIEndpoint) {
            // OpenAI format for /api/chat/completions
            body = {
              model: modelName,
              messages: [
                {
                  role: "user",
                  content: fullPrompt
                }
              ]
            };
          } else {
            // Ollama format for /ollama/api/generate
            body = {
              model: modelName,
              prompt: fullPrompt
            };
          }

          // log('=== API Request Debug ===');
          // log('API URL:', apiUrl);
          // log('Model Name:', modelName);
          // log('Is OpenAI Endpoint:', isOpenAIEndpoint);
          // log('Request Body:', JSON.stringify(body, null, 2));
          // log('=== End API Request Debug ===');

          const resp = await axios.post(
            apiUrl,
            body,
            {
                headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`
                },
                responseType: isOpenAIEndpoint ? 'json' : 'text'
            }
          );

          // log('=== API Response Debug ===');
          // log('Response Status:', resp.status);
          // log('Response Headers:', resp.headers);
          // log('=== End API Response Debug ===');

          if (isOpenAIEndpoint) {
            // Handle OpenAI format response
            if (resp.data.choices && resp.data.choices[0] && resp.data.choices[0].message) {
              feedback = resp.data.choices[0].message.content;
            } else {
              throw new Error('Invalid OpenAI response format');
            }
          } else {
            // Handle Ollama streaming response
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
              throw new Error('No valid response content received from API.');
            }
            feedback = fullResponse;
          }
          // log('feedback:', feedback)

        } catch (e: any) {
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

  // Speech-to-Text logic
  ctx.subscriptions.push(
    vscode.commands.registerCommand('jupyterAiFeedback.toggleRecording', async (cell: vscode.NotebookCell) => {
      await toggleRecording(cell);
    })
  );

  async function replaceCellContent(doc:vscode.TextDocument, content:string){
    const edit = new vscode.WorkspaceEdit();
    const start = new vscode.Position(0,0);
    const end = doc.lineAt(doc.lineCount - 1).range.end;
    const fullRange = new vscode.Range(start, end);
    edit.replace(doc.uri, fullRange, content);
    await vscode.workspace.applyEdit(edit);
  }

  function cleanMarkdown(text: string): string {
    let cleaned = text;

    // 删除大模型常见的多余短语（即使已提示也会生成）
    cleaned = cleaned.replace(/^.*?(Expanded Feedback|Feedback Expansion|Here.*feedback|Based on.*feedback).*$/gmi, '');

    // 删除多余的空行
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

    // 补全未配对的 markdown 符号
    const count = (str: string) => (cleaned.match(new RegExp(str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    
    // 优先修复未配对的 **（对你的用例最重要）
    if (count('\\*\\*') % 2 !== 0) cleaned += '**';
    
    // 然后修复单个 *（排除属于 ** 的部分）
    const singleStarCount = count('\\*') - 2 * count('\\*\\*');
    if (singleStarCount % 2 !== 0) cleaned += '*';
    
   // 修复未配对的反引号 `
    if (count('`') % 2 !== 0) cleaned += '`';

    // 更谨慎地去除反斜杠，只去除明显的转义
    // 不处理 ** 相关的模式
    cleaned = cleaned.replace(/\\([_`#])/g, '$1');  // 只去除 _ ` # 前的反斜杠，不处理 *
    cleaned = cleaned.replace(/\\n/g, '\n');

    return cleaned.trim();
}

  // Markdown cell
  ctx.subscriptions.push(
    vscode.commands.registerCommand(
      'jupyterAiFeedback.explainMarkdownCell',
      async(cell: vscode.NotebookCell) => {
        const editor = vscode.window.activeNotebookEditor;
        if (!editor) {
          return vscode.window.showErrorMessage('No activity')
        }

        const content = cell.document.getText()?.toLowerCase();
        if (!content.includes('feedback')) {
          vscode.window.showWarningMessage('This markdown cell does not appear to contain feedback.');
          return;
        }



        const cfg = vscode.workspace.getConfiguration('jupyterAiFeedback');
        const mode = cfg.get<string>('feedbackMode');
        const apiUrl = cfg.get<string>('apiUrl') || '';
        const apiKey = cfg.get<string>('apiKey') || '';
        const modelName = cfg.get<string>('modelName') || '';
        if (!apiUrl || !apiKey || !mode) {
          return vscode.window.showErrorMessage(
            'Please set apiUrl, apiKey and feedbackMode in your settings'
          );
        }

        const fullText = cell.document.getText();

        // full text or select sentences
        let inputText = '';
        let header = '';
        if (mode === 'Expand') {
          inputText = fullText;
          header = `**🤖 Feedback Expansion**`;
        } else if (mode === 'Explain') {
          // select sentences
          const activeEditor = vscode.window.activeTextEditor;
          const selection = activeEditor?.selection;
          const selectedText = selection && !selection.isEmpty
            ? activeEditor.document.getText(selection)
            : null;

          if (!selectedText || selectedText.trim().length === 0) {
            return vscode.window.showErrorMessage('Please select the sentence you want explained.')
          }
          inputText = selectedText;
          header =  `**🤖Explanation** for:**_"${selectedText}"_**`
        } else {
          return vscode.window.showErrorMessage(`Unsupported mode: ${mode}`);
        }

        await syncGitRepo()
        const promptTpl = await getPromptContent(mode);

        const prompt = promptTpl.replace('{{content}}', inputText);
        const generatingNote = `*(Generating...)*`;
        const finishedNote = `**✅ AI Generation Completed**`;

        // add or renew markdown cell
        let newCell: vscode.NotebookCell;
        const nextIndex = cell.index + 1;

        if (
          nextIndex < editor.notebook.cellCount &&
          editor.notebook.cellAt(nextIndex).kind === vscode.NotebookCellKind.Markup &&
          editor.notebook.cellAt(nextIndex).document.getText().startsWith(header)
        ) {
          newCell = editor.notebook.cellAt(nextIndex);
        } else {
          await vscode.commands.executeCommand('notebook.cell.insertMarkdownCellBelow');
          newCell = editor.notebook.cellAt(cell.index + 1);
        }

        const doc = newCell.document;
        await replaceCellContent(doc, `${header}\n\n${generatingNote}\n`);

        try {
          const body = {
            model : modelName,
            prompt: prompt,
            stream : true
          };

          const resp = await axios.post(apiUrl, body, {
            headers: {
              'content-Type' : 'application/json',
              Authorization: `Bearer ${apiKey}`
            },
            responseType: 'stream'
          });

          let accumulated = '';
          let chunkCount = 0;
          for await (const chunk of resp.data) {
            chunkCount++;
            const lines = chunk.toString().split('\n');
            
            for (const line of lines) {
              const trimmedLine = line.trim();
              if (!trimmedLine) continue;
              
              try {
                const jsonResponse = JSON.parse(trimmedLine);
                if (jsonResponse.response) {
                  accumulated += jsonResponse.response;
                  
                  const safeText = cleanMarkdown(accumulated);
                  const updatedContent = `${header}\n\n${safeText.replace(/\n/g, '  \n')}\n\n${generatingNote}`;
                  await replaceCellContent(doc, updatedContent);
                }
              } catch (parseError) {
                // Skip invalid JSON lines, which is normal in streaming responses
                console.warn('Skipping invalid JSON line:', trimmedLine);
              }
            }
          }

          // give a sign that it is finished generating
          const finalText = cleanMarkdown(accumulated);

          // Add colored border based on mode, wrapping both header and content
          const borderColor = mode === 'Expand' ? '#6ec5d2ff' : '#4CAF50';
          const wrappedContent = `<div style="border: 3px solid ${borderColor}; padding: 10px">\n\n${header}\n\n${finalText.replace(/\n/g, '  \n')}\n\n</div>`;

          const finalContent = `${wrappedContent}\n`;
          await replaceCellContent(doc,finalContent);

        } catch (e:any) {
          console.error("AI Extension fail:", e);
          const errorMsg = `${header}\n\n❌ AI generation failed:\n\n\`${e.message}\``;
          await replaceCellContent(doc, errorMsg);
          return vscode.window.showErrorMessage('Ai Extension fail:' + e.message);
        }
      }
    )
  );

  // follow up question button
  ctx.subscriptions.push(
    vscode.commands.registerCommand('jupyterAiFeedback.askFollowUpFromButton', async (cell: vscode.NotebookCell) => {
      const editor = vscode.window.activeNotebookEditor;
      if (!editor) {
        return vscode.window.showErrorMessage('No active notebook editor');
      }

      const explanation = cell.document.getText()
      const conversation: { role: 'user' | 'assistant' | 'followup'; content: string }[] = [
        {role:'assistant', content:explanation}
      ];

      let followupPrompt = '';
      try{
        followupPrompt = await getPromptContent('Followup');
        conversation.push({role:'followup', content:followupPrompt});
      } catch(e:any){
        vscode.window.showErrorMessage('⚠️ Failed to load Followup prompt: ' + e.message);
      }

      const panel = vscode.window.createWebviewPanel(
        'followUpChat',
        'Follow-up Chat',
        vscode.ViewColumn.Beside,
        { enableScripts: true }
      );


      function getHTML() {
      return `<!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <style>
          *{
            box-sizing: border-box;
          }

          body {
            margin: 0;
            padding: 0;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            height: 100vh;
            display: flex;
            flex-direction: column;
            background: #f9fafb;
            color: #1f2937;
          }

          #chat {
            flex: 1;
            overflow-y: auto;
            padding: 1.2em;
            display:flex;
            flex-direction: column;
            background: #f4f4f4;
            max-width: 900px;
          }

          .message {
            max-width: 80%;
            padding: 0.75em 1em;
            border-radius: 12px;
            line-height: 1.6;
            white-space:pre-wrap;
            word-wrap:break-word;
            font-size:0.95em;
          }

          .user {
            background-color: #d1e7ff;
            align-self: flex-end;
            text-align: right;
          }

          .assistant {
            background-color: #ffffff;
            align-self: flex-start;
            border: 1px solid #e5e7eb;
          }

          /* 防溢出优化 */
          .message code {
            white-space: pre-wrap;
            word-break: break-word;
          }
          .message pre {
            white-space: pre;
            overflow-x: auto;
            max-width: 100%;
          }
          .message img {
            max-width: 100%;
            height: auto;
          }
          .message table {
            display: block;
            width: 100%;
            overflow-x: auto;
          }
          .message th, .message td {
            word-break: break-word;
          }
          /* 紧凑 Markdown 样式 */
          .message.assistant p {
            margin: 0.2em 0;
            line-height: 1.4;
          }
          .message.assistant ul,
          .message.assistant ol {
            margin: 0.2em 0;
            padding-left: 1.2em;
          }
          .message.assistant li {
            margin: 0.15em 0;
          }
          .message.assistant h1,
          .message.assistant h2,
          .message.assistant h3 {
            margin: 0.4em 0 0.2em;
            line-height: 1.3;
          }
          .message.assistant table {
            border-collapse: collapse;
            margin: 0.3em 0;
          }
          .message.assistant th,
          .message.assistant td {
            padding: 4px 8px;
          }

          #inputArea {
            display: flex;
            padding: 0.75em;
            border-top: 1px solid #e5e7eb;
            background: #ffffff;
          }

          #input {
            flex: 1;
            padding: 0.6em 0.75em;
            font-size: 1em;
            border: 1px solid #d1d5db;
            border-radius: 8px;
            outline:none;
            resize: vertical;
            min-height: 2.8em;
            max-height: 40vh;
          }

          #sendBtn {
            margin-left: 0.5em;
            padding: 0.6em 1.2em;
            font-size: 1em;
            border: none;
            border-radius: 8px;
            background-color: #2563eb;
            color: white;
            cursor: pointer;
            transition: background-color 0.2s;
          }

          #sendBtn:hover {
            background-color: #1d4ed8;
          }

          p {
            margin: 0.05em 0;
            line-height: 1.5;
          }

          #suggestedArea {
            padding: 0.5em 1em;
            background: #f9f9f9;
            border-top: 1px solid #ddd;
            border-bottom: 1px solid #ddd;
          }

          #suggestedButtons {
            margin-top: 0.4em;
          }

          .suggestion-btn {
            margin: 0.2em 0.4em 0 0;
            padding: 0.3em 0.8em;
            border: 1px solid #bbb;
            border-radius: 6px;
            background-color: #f0f0f0;
            font-size: 0.9em;
            cursor: pointer;
            transition: background-color 0.2s ease;
          }

          .suggestion-btn:hover {
            background-color: #e0e0e0;
          }


        </style>
        <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
      </head>
      <body>
        <div id="chat"></div>

        <div id='suggestedArea'>
          <strong>💡 Suggested follow-up:</strong><br>
          <div id="suggestedButtons"></div>
        </div>

        <div id="inputArea">
          <textarea id="input" placeholder="Type your follow-up question..." /></textarea>
          <button id="sendBtn">Send</button>
        </div>



        <script>
          const vscode = acquireVsCodeApi();

          function appendMessage(role, content) {
            const chat = document.getElementById('chat');
            const div = document.createElement('div');
            div.className = 'message ' + role;
            const label = role === 'user' ? '👤 You' : '🤖 AI';

            const rendered = role === 'assistant' ? marked.parse(content) : content;
            div.innerHTML = '<strong>' + label + ':</strong><br>' + rendered;
            chat.appendChild(div);
            chat.scrollTop = chat.scrollHeight;
          }

          function showSuggestedQuestions(questions) {
            const container = document.getElementById('suggestedButtons');
            container.innerHTML = '';
            questions.forEach(text => {
              const btn = document.createElement('button');
              btn.textContent = text;
              btn.className = 'suggestion-btn';
              btn.addEventListener('click', () => {
                appendMessage('user', text);

                // loading status
                const button = document.getElementById('sendBtn');

                button.disabled = true;
                button.textContent = 'Thinking...';


                vscode.postMessage({ type: 'ask', question: text });
              });
              container.appendChild(btn);
            });
          }

          function sendMessage() {
            const input = document.getElementById('input');
            const question = input.value.trim();
            const button = document.getElementById('sendBtn');
            if (question) {
              appendMessage('user', question);

              // show loading status
              button.disabled = true;
              button.textContent = 'Thinking...';


              vscode.postMessage({ type: 'ask', question });
              input.value = '';
              }
          }

          document.getElementById('input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
          });

          document.getElementById('sendBtn').addEventListener('click', sendMessage);

          window.addEventListener('message', event => {
            const msg = event.data;
            if (msg.type === 'answer') {
              appendMessage('assistant', msg.content);

              const button = document.getElementById('sendBtn');
              button.disabled = false;
              button.textContent = 'Send';
            }
          });

          showSuggestedQuestions([
            'What does this mean in practice?',
            'Can you give an example?',
            'How can I apply this idea?'
          ]);         
        </script>
      </body>
      </html>`;
        }

      panel.webview.html = getHTML();

      panel.webview.onDidReceiveMessage(async (msg) => {
        if (msg.type === 'ask') {
          const question = msg.question;
          conversation.push({ role: 'user', content: question });

          const cfg = vscode.workspace.getConfiguration('jupyterAiFeedback');
          const apiUrl = cfg.get<string>('apiUrl') || '';
          const apiKey = cfg.get<string>('apiKey') || '';
          const modelName = cfg.get<string>('modelName') || '';

          // //const fullPrompt = conversation.map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`).join('\n') + '\nAssistant:';
          // const fullPrompt = conversation
          //   .filter(msg => msg.role !== 'followup')
          //   .map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
          //   .join('\n') + '\nAssistant:';

          const mapRole = (r: 'user' | 'assistant' | 'followup'): 'User' | 'Assistant' | 'System' => {
            if (r === 'user') return 'User';
            if (r === 'followup') return 'System';
            return 'Assistant';
          };

          const lines: string[] = [];
          for (const m of conversation) {
            // 不再过滤 followup，而是当作 System
            const role = mapRole(m.role as any);
            lines.push(`${role}: ${m.content}`);
          }
          const fullPrompt = lines.join('\n') + '\nAssistant:';

          const body = {
            model: modelName,
            prompt: fullPrompt,
            stream: false
          };

          try {
            const resp = await axios.post(apiUrl, body, {
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`
              }
            });

            const answer = resp.data.message?.content || resp.data.response || 'No response received';
            conversation.push({ role: 'assistant', content: answer });

            // const chatHtml = buildChatHtml(conversation);
            panel.webview.postMessage({type: 'answer', content:answer});
          } catch (e: any) {
            vscode.window.showErrorMessage('Failed to fetch follow-up response: ' + e.message);
            panel.webview.postMessage({ type: 'answer', content: `❌ Request failed: ${e.message || e}` });            
          }
        }
      });
    })
  );

  ctx.subscriptions.push(
    vscode.notebooks.registerNotebookCellStatusBarItemProvider('jupyter-notebook', {
    provideCellStatusBarItems(cell, _token) {
      const items: vscode.NotebookCellStatusBarItem[] = [];

      if (cell.kind === vscode.NotebookCellKind.Markup) {
        const text = cell.document.getText();

        // Explanation cell
        if (text.includes('**🤖Explanation** for:')) {
          const item = new vscode.NotebookCellStatusBarItem(
            '💬 Ask follow-up',
            vscode.NotebookCellStatusBarAlignment.Right
          );
          item.command = 'jupyterAiFeedback.askFollowUpFromButton';
          item.tooltip = 'Ask a follow-up question about this explanation';
          items.push(item);
        };

        // Feeback Expansion cell
        if (text.includes('**🤖Feedback Expansion**')){
          const item = new vscode.NotebookCellStatusBarItem(
            '💬 Ask follow-up',
            vscode.NotebookCellStatusBarAlignment.Right
          );
          item.command = 'jupyterAiFeedback.askFollowUpFromButton';
          item.tooltip = 'Ask a follow-up question about this explanation';
          items.push(item);
        }
      }
      return items;
    }
    })
  );
}

export function deactivate(): void {
  // Clean up any resources if needed
  if (ErrorHelperPanel.currentPanel) {
    ErrorHelperPanel.currentPanel.dispose();
  }
  killLocal();
}