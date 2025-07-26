"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __asyncValues = (this && this.__asyncValues) || function (o) {
    if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
    var m = o[Symbol.asyncIterator], i;
    return m ? m.call(o) : (o = typeof __values === "function" ? __values(o) : o[Symbol.iterator](), i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function () { return this; }, i);
    function verb(n) { i[n] = o[n] && function (v) { return new Promise(function (resolve, reject) { v = o[n](v), settle(resolve, reject, v.done, v.value); }); }; }
    function settle(resolve, reject, d, v) { Promise.resolve(v).then(function(v) { resolve({ value: v, done: d }); }, reject); }
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deactivate = exports.activate = void 0;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const fs_1 = require("fs");
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const cp = __importStar(require("child_process"));
const axios_1 = __importDefault(require("axios"));
const simple_git_1 = __importDefault(require("simple-git"));
const tmp = __importStar(require("tmp"));
const speech_1 = require("./speech");
const localServer_1 = require("./localServer");
const localServer_2 = require("./localServer");
let recording = false;
const GIT_REPO_URL = 'https://github.com/teachnology/promptfolio.git';
// const GIT_REPO_URL = 'https://github.com/esemsc-hz2024/promptfolio.git';
// const GIT_REPO_URL = 'https://github.com/esemsc-sg524/leveled_prompt.git';
const LOCAL_REPO_PATH = path.join(os.tmpdir(), 'promptfolio_repo');
// Error Helper Panel for chat functionality
class ErrorHelperPanel {
    static createOrShow(extensionUri, cell, config, errorHelperFeedback) {
        const column = vscode.ViewColumn.Two;
        // If we already have a panel, show it
        if (ErrorHelperPanel.currentPanel) {
            ErrorHelperPanel.currentPanel.panel.reveal(column);
            ErrorHelperPanel.currentPanel.updateCell(cell, errorHelperFeedback);
            return;
        }
        // Otherwise, create a new panel
        const panel = vscode.window.createWebviewPanel('errorHelperChat', 'Error Helper Chat', column, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [extensionUri]
        });
        ErrorHelperPanel.currentPanel = new ErrorHelperPanel(panel, extensionUri, cell, config, errorHelperFeedback || '');
    }
    constructor(panel, extensionUri, cell, config, errorHelperFeedback) {
        this.messages = [];
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.cell = cell;
        this.config = config;
        this.errorHelperFeedback = errorHelperFeedback;
        // Set the webview's initial html content
        this.update();
        // Listen for when the panel is disposed
        this.panel.onDidDispose(() => this.dispose(), null);
        // Handle messages from the webview
        this.panel.webview.onDidReceiveMessage((message) => __awaiter(this, void 0, void 0, function* () {
            try {
                switch (message.command) {
                    case 'sendMessage':
                        if (message.text) {
                            yield this.handleUserMessage(message.text);
                        }
                        break;
                    default:
                        console.warn('Unknown message command:', message.command);
                }
            }
            catch (error) {
                console.error('Error handling webview message:', error);
            }
        }));
    }
    handleUserMessage(userMessage) {
        return __awaiter(this, void 0, void 0, function* () {
            // Add user message
            this.messages.push({
                role: 'user',
                content: userMessage,
                timestamp: Date.now()
            });
            // Update UI to show user message and typing indicator
            yield this.updateMessages();
            try {
                // Generate AI response
                const aiResponse = yield this.generateAIResponse(userMessage);
                // Add AI message
                this.messages.push({
                    role: 'assistant',
                    content: aiResponse,
                    timestamp: Date.now()
                });
                // Update UI with AI response
                yield this.updateMessages();
            }
            catch (error) {
                console.error('Error generating AI response:', error);
                this.messages.push({
                    role: 'assistant',
                    content: 'Sorry, I encountered an error while generating a response. Please try again.',
                    timestamp: Date.now()
                });
                yield this.updateMessages();
            }
        });
    }
    generateAIResponse(userMessage) {
        return __awaiter(this, void 0, void 0, function* () {
            const code = this.cell.document.getText();
            const cellOutput = getCellOutput(this.cell);
            // Build conversation context
            const conversationHistory = this.messages.slice(-6).map(msg => `${msg.role === 'user' ? 'Student' : 'AI Helper'}: ${msg.content}`).join('\n\n');
            try {
                // Use GitHub template system for chat prompts
                yield syncGitRepo();
                const chatTemplateId = 'error_chat';
                const promptTemplate = yield getPromptContent(chatTemplateId);
                let prompt = promptTemplate.replace('{{code}}', code);
                prompt = prompt.replace('{{error_output}}', cellOutput.output);
                prompt = prompt.replace('{{conversation_history}}', conversationHistory);
                prompt = prompt.replace('{{user_message}}', userMessage);
                // Handle error_helper_feedback - if empty, remove the section
                if (this.errorHelperFeedback && this.errorHelperFeedback.trim()) {
                    prompt = prompt.replace('{{error_helper_feedback}}', this.errorHelperFeedback);
                }
                else {
                    // Remove the entire Previous Error Helper Analysis section if no feedback
                    prompt = prompt.replace(/\*\*Previous Error Helper Analysis:\*\*\s*\{\{error_helper_feedback\}\}\s*\n\n?/g, '');
                    // Fallback: just replace the placeholder with empty string
                    prompt = prompt.replace('{{error_helper_feedback}}', '');
                }
                return yield callLLMAPI(prompt, this.config);
            }
            catch (error) {
                console.error('Failed to load chat template, using fallback:', error);
                // Fallback prompt if template loading fails
                const fallbackPrompt = `You are a helpful Python programming tutor. 

**Code:** ${code}
**Error:** ${cellOutput.output}
${this.errorHelperFeedback ? `**Previous Analysis:** ${this.errorHelperFeedback}` : ''}
**Question:** ${userMessage}

Please provide a helpful response based on the code, error${this.errorHelperFeedback ? ', and previous analysis' : ''}.`;
                return yield callLLMAPI(fallbackPrompt, this.config);
            }
        });
    }
    updateCell(cell, errorHelperFeedback) {
        this.cell = cell;
        if (errorHelperFeedback) {
            this.errorHelperFeedback = errorHelperFeedback;
        }
        this.messages = []; // Reset conversation for new cell
        this.update();
    }
    updateMessages() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.panel.webview.postMessage({
                command: 'updateMessages',
                messages: this.messages
            });
        });
    }
    update() {
        const code = this.cell.document.getText();
        const cellOutput = getCellOutput(this.cell);
        this.panel.webview.html = this.getHtmlForWebview(code, cellOutput.output, this.errorHelperFeedback);
    }
    getHtmlForWebview(code, errorOutput, errorHelperFeedback) {
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
                I have your code, error details${errorHelperFeedback ? ', and previous analysis' : ''}. What specific questions do you have about this error?
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
    dispose() {
        ErrorHelperPanel.currentPanel = undefined;
        this.panel.dispose();
    }
}
// Add analysis to cell output as HTML
function addAnalysisToCellOutput(cell, analysis) {
    return __awaiter(this, void 0, void 0, function* () {
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
            const newCellData = new vscode.NotebookCellData(cell.kind, cell.document.getText(), cell.document.languageId);
            newCellData.outputs = updatedOutputs;
            if (cell.metadata) {
                newCellData.metadata = cell.metadata;
            }
            // Replace the cell
            const edit = new vscode.WorkspaceEdit();
            const range = new vscode.NotebookRange(cell.index, cell.index + 1);
            const notebookEdit = vscode.NotebookEdit.replaceCells(range, [newCellData]);
            edit.set(cell.notebook.uri, [notebookEdit]);
            const success = yield vscode.workspace.applyEdit(edit);
            if (success) {
                console.log('Successfully added Error Helper analysis to cell output');
                console.log('Preserved', existingOutputs.length, 'existing outputs');
            }
            else {
                throw new Error('Failed to apply edit to notebook');
            }
        }
        catch (error) {
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
                yield insertMarkdownCellBelow(editor.notebook, cell.index, content);
            }
            else {
                vscode.window.showInformationMessage(`Error Helper Analysis: ${analysis.substring(0, 200)}...`);
            }
        }
    });
}
// LLM Call API, for AI Feedback and Error Helper - Modified for OpenAI format
function callLLMAPI(prompt, config) {
    return __awaiter(this, void 0, void 0, function* () {
        // Check if using OpenAI-compatible endpoint
        const isOpenAIEndpoint = config.apiUrl.includes('/chat/completions');
        let body;
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
        }
        else {
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
        const resp = yield axios_1.default.post(config.apiUrl, body, {
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${config.apiKey}`
            },
            responseType: isOpenAIEndpoint ? 'json' : 'text'
        });
        console.log('=== API Response Debug ===');
        console.log('Response Status:', resp.status);
        console.log('Response Data:', resp.data);
        console.log('Response Headers:', resp.headers);
        console.log('=== End API Response Debug ===');
        if (isOpenAIEndpoint) {
            // Handle OpenAI format response
            if (resp.data.choices && resp.data.choices[0] && resp.data.choices[0].message) {
                return resp.data.choices[0].message.content;
            }
            else {
                throw new Error('Invalid OpenAI response format');
            }
        }
        else {
            // Handle Ollama streaming response
            const lines = resp.data.split('\n').filter((line) => line.trim());
            let fullResponse = '';
            for (const line of lines) {
                try {
                    const jsonResponse = JSON.parse(line);
                    if (jsonResponse.response) {
                        fullResponse += jsonResponse.response;
                    }
                }
                catch (e) {
                    console.warn('Failed to parse JSON line:', line);
                }
            }
            if (!fullResponse) {
                console.error('No valid response content found');
                throw new Error('No valid response content received from API.');
            }
            return fullResponse;
        }
    });
}
// Read LLM configuration from settings
function readLLMConfig() {
    const cfg = vscode.workspace.getConfiguration('jupyterAiFeedback');
    const apiUrl = cfg.get('apiUrl') || '';
    const apiKey = cfg.get('apiKey') || '';
    const modelName = cfg.get('modelName') || '';
    if (!apiUrl || !apiKey || !modelName) {
        vscode.window.showErrorMessage('Please configure jupyterAiFeedback.apiUrl, apiKey, and modelName in settings');
        return null;
    }
    return { apiUrl, apiKey, modelName };
}
function isValidRepo(dir) {
    return __awaiter(this, void 0, void 0, function* () {
        const git = (0, simple_git_1.default)(dir);
        try {
            yield git.revparse(['--is-inside-work-tree']);
            return true; // normal git package
        }
        catch (_a) {
            return false; // rev-parse fail => not valid
        }
    });
}
function syncGitRepo() {
    return __awaiter(this, void 0, void 0, function* () {
        const repoOk = (0, fs_1.existsSync)(LOCAL_REPO_PATH) && (yield isValidRepo(LOCAL_REPO_PATH));
        if (!repoOk) {
            yield fs.promises.rm(LOCAL_REPO_PATH, { recursive: true, force: true }).catch(() => { });
            yield (0, simple_git_1.default)().clone(GIT_REPO_URL, LOCAL_REPO_PATH, ['--depth', '1']);
            return;
        }
        try {
            yield (0, simple_git_1.default)(LOCAL_REPO_PATH).pull();
        }
        catch (err) {
            console.warn('pull failed, re-clone:', err);
            yield fs.promises.rm(LOCAL_REPO_PATH, { recursive: true, force: true });
            yield (0, simple_git_1.default)().clone(GIT_REPO_URL, LOCAL_REPO_PATH, ['--depth', '1']);
        }
    });
}
function getPromptContent(promptId) {
    return __awaiter(this, void 0, void 0, function* () {
        const promptPath = path.join(LOCAL_REPO_PATH, 'prompts', `${promptId}.txt`);
        if (!fs.existsSync(promptPath))
            throw new Error(`Prompt file ${promptId}.txt not found`);
        return fs.readFileSync(promptPath, 'utf8');
    });
}
function getTestFiles(exerciseId) {
    return __awaiter(this, void 0, void 0, function* () {
        const testDir = path.join(LOCAL_REPO_PATH, 'tests', exerciseId);
        const testFile = fs.readdirSync(testDir).find(f => f.startsWith('test_') && f.endsWith('.py'));
        const metadataFile = path.join(testDir, 'metadata.json');
        if (!testFile || !fs.existsSync(metadataFile))
            throw new Error('Test or metadata not found');
        return {
            test: fs.readFileSync(path.join(testDir, testFile), 'utf8'),
            metadata: JSON.parse(fs.readFileSync(metadataFile, 'utf8'))
        };
    });
}
// get notebook python path
function getNotebookPythonPath() {
    return __awaiter(this, void 0, void 0, function* () {
        const editor = vscode.window.activeNotebookEditor;
        if (!editor) {
            return;
        }
        // activate Python extension API
        const pyExt = vscode.extensions.getExtension('ms-python.python');
        if (!pyExt) {
            return;
        }
        yield pyExt.activate();
        const pyApi = pyExt.exports;
        // API file: https://github.com/microsoft/vscode-python/blob/main/src/api.ts
        const execCmd = pyApi.settings.getExecutionDetails(editor.notebook.uri).execCommand;
        return execCmd === null || execCmd === void 0 ? void 0 : execCmd[0]; // execCmd [ '/Users/xxx/miniconda3/envs/py39/bin/python', ... ]
    });
}
// check if python package is installed
function checkPytestInstalled(pythonPath, pkg) {
    return new Promise((resolve) => {
        cp.execFile(pythonPath, ['-m', 'pip', 'show', pkg], (err, stdout) => {
            resolve(!!stdout && !err && stdout.includes(`Name: ${pkg}`));
        });
    });
}
// auto install python dependencies
function ensurePythonDeps(pythonPath, pkgs) {
    return new Promise((resolve) => {
        cp.execFile(pythonPath, ['-m', 'pip', 'install', ...pkgs], (err, stdout, stderr) => {
            if (err) {
                vscode.window.showErrorMessage(`install dependencies failed: ${stderr || err.message}`);
                resolve(false);
            }
            else {
                vscode.window.showInformationMessage(`installed: ${pkgs.join(', ')}`);
                resolve(true);
            }
        });
    });
}
function runLocalTest(code, test, pythonPath) {
    return __awaiter(this, void 0, void 0, function* () {
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
    });
}
function listLocalExercises() {
    return __awaiter(this, void 0, void 0, function* () {
        const exercisesDir = path.join(LOCAL_REPO_PATH, 'tests');
        if (!fs.existsSync(exercisesDir))
            return [];
        const exerciseIds = fs.readdirSync(exercisesDir).filter(f => fs.statSync(path.join(exercisesDir, f)).isDirectory());
        return exerciseIds.map(id => {
            const metaPath = path.join(exercisesDir, id, 'metadata.json');
            let meta = {};
            if (fs.existsSync(metaPath)) {
                meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            }
            return Object.assign({ id }, meta);
        });
    });
}
function listLocalTemplates() {
    return __awaiter(this, void 0, void 0, function* () {
        const promptsDir = path.join(LOCAL_REPO_PATH, 'prompts');
        if (!fs.existsSync(promptsDir))
            return [];
        return fs.readdirSync(promptsDir)
            .filter(f => f.endsWith('.txt'))
            .map(f => ({
            id: path.basename(f, '.txt'),
            filename: f
        }));
    });
}
// Helper function: Extract error message
function extractErrorMessage(test) {
    var _a, _b;
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
    }
    else if (longrepr && typeof longrepr === 'object') {
        const msg = longrepr.longrepr || ((_a = longrepr.reprcrash) === null || _a === void 0 ? void 0 : _a.message) || '';
        if (msg)
            return msg.trim();
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
    const testName = ((_b = test.nodeid) === null || _b === void 0 ? void 0 : _b.split('::').pop()) || 'Unknown Test';
    const outcome = test.outcome || 'failed';
    return `${testName} ${outcome}`;
}
// Helper function: Extract test input from assertion message
function extractTestInput(assertionMsg) {
    // 匹配 func(args) 形式，支持多参数、负数、小数、字符串、列表等
    const m = assertionMsg.match(/([a-zA-Z_][a-zA-Z0-9_]*)\(([^\)]*)\)/);
    if (m)
        return `${m[1]}(${m[2]})`;
    return '';
}
// Helper function: Generate improvement suggestions
function generateSuggestions(failedTests, metadata) {
    const suggestions = new Set();
    // Add hints from metadata
    const hints = (metadata === null || metadata === void 0 ? void 0 : metadata.hints) || [];
    hints.slice(0, 3).forEach((hint) => suggestions.add(hint));
    return Array.from(suggestions);
}
/**
 * Extract the most readable assertion line from pytest-json-report's longrepr/message
 *   - If reprcrash.message exists ⇒ use it (pytest's concise line)
 *   - Otherwise, scan all lines in longrepr:
 *        Prefer the line containing 'AssertionError' or 'assert'
 *   - If not found, fallback to the first line
 */
function extractAssertionLine(test) {
    var _a, _b, _c, _d, _e, _f, _g;
    const longreprObj = (_c = (_b = (_a = test.call) === null || _a === void 0 ? void 0 : _a.longrepr) !== null && _b !== void 0 ? _b : test.longrepr) !== null && _c !== void 0 ? _c : '';
    // ---- case ① longrepr 是对象（pytest-json-report ≥ 3） ----
    if (typeof longreprObj === 'object' && longreprObj) {
        const msg = (_d = longreprObj.reprcrash) === null || _d === void 0 ? void 0 : _d.message;
        if (msg)
            return msg.trim();
        const lrText = (_e = longreprObj.longrepr) !== null && _e !== void 0 ? _e : '';
        const runtime = lrText.split('\n').find(l => /AssertionError:/i.test(l));
        if (runtime)
            return runtime.trim();
        const src = lrText.split('\n').find(l => /\bassert\b/.test(l));
        return ((_f = src !== null && src !== void 0 ? src : lrText.split('\n')[0]) !== null && _f !== void 0 ? _f : '').trim();
    }
    // ---- case ② longrepr 是字符串 ----
    const lines = longreprObj.split('\n');
    const runtime = lines.find(l => /AssertionError:/i.test(l));
    if (runtime)
        return runtime.trim();
    const src = lines.find(l => /\bassert\b/.test(l));
    return ((_g = src !== null && src !== void 0 ? src : lines[0]) !== null && _g !== void 0 ? _g : '').trim();
}
// Helper function: Generate concise test summary
function generateConciseTestSummary(failedTests, totalTests) {
    if (failedTests.length === 0) {
        return '';
    }
    const passed = totalTests - failedTests.length;
    const successRate = Math.round((passed / totalTests) * 100);
    // Extract test cases with expected vs actual values and assertion message
    const testCases = [];
    for (const test of failedTests) {
        const testName = test.nodeid.split('::').pop() || 'Unknown Test';
        const errorMessage = extractErrorMessage(test);
        console.log('errorMessage', errorMessage);
        // Use the new assertion line extractor
        const assertionLine = extractAssertionLine(test);
        const inputParam = extractTestInput(assertionLine);
        testCases.push({
            test: testName,
            input: inputParam,
            assertion: assertionLine
        });
        if (testCases.length === 3)
            break;
    }
    // Generate summary
    let summary = `## Test Summary\n`;
    summary += `- ${totalTests} tests, ${passed} passed, ${failedTests.length} failed (${successRate}%)\n\n`;
    if (testCases.length > 0) {
        summary += `### Failure Examples\n`;
        summary += `| Test | Input | Assertion Message |\n`;
        summary += `|------|-------|-------------------|\n`;
        for (const t of testCases) {
            summary += `| ${t.test} | ${t.input} | ${t.assertion} |\n`;
        }
        summary += `\n`;
    }
    return summary;
}
function extractPromptId(code) {
    const m = code.match(/^[ \t]*#\s*PROMPT_ID\s*:\s*(.+)$/m);
    return m ? m[1].trim() : null;
}
function extractExerciseId(code) {
    const m = code.match(/^\s*#\s*EXERCISE_ID\s*:\s*([A-Za-z0-9_\-]+)/m);
    return m ? m[1] : null;
}
// ───────────────────────────────────────────────────────────
// delete ANSI code
function stripAnsi(str) {
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
function getCellOutput(cell) {
    var _a;
    let outputText = '';
    let hasOutput = false;
    let executionError = false;
    const decoder = new TextDecoder();
    for (const output of (_a = cell.outputs) !== null && _a !== void 0 ? _a : []) {
        hasOutput = true;
        for (const item of output.items) {
            const mime = item.mime;
            const raw = decoder.decode(item.data);
            // ── 1. normal text / stdout / stderr ──────────────────────
            if (mime === 'text/plain' ||
                mime === 'application/vnd.code.notebook.stdout' ||
                mime === 'application/vnd.code.notebook.stderr') {
                outputText += stripAnsi(raw) + '\n';
                continue;
            }
            // ── 2. execution error object ─────────────────────────────────
            if (mime === 'application/vnd.code.notebook.error') {
                try {
                    const errObj = JSON.parse(raw);
                    const pretty = `${errObj.name}: ${errObj.message}\n` +
                        stripAnsi(errObj.stack || '');
                    outputText += '[ERROR] ' + pretty + '\n';
                }
                catch (_b) {
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
function findExistingErrorHelperFeedback(cell) {
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
function insertMarkdownCellBelow(notebook, cellIndex, content) {
    return __awaiter(this, void 0, void 0, function* () {
        const edit = new vscode.WorkspaceEdit();
        const newCell = new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, content, 'markdown');
        // insert at cellIndex+1
        const notebookEdit = vscode.NotebookEdit.insertCells(cellIndex + 1, [newCell]);
        edit.set(notebook.uri, [notebookEdit]);
        yield vscode.workspace.applyEdit(edit);
    });
}
// Extract all cell prompt placeholder content, supporting <!-- prompt:key -->, # prompt:key, and multi-block sections
function extractPromptPlaceholders(notebook, currentCellIdx, placeholderKeys) {
    console.log('=== extractPromptPlaceholders START ===');
    console.log('Current cell index:', currentCellIdx);
    console.log('Total cells:', notebook.cellCount);
    const placeholderMap = new Map();
    const htmlCommentRe = /<!--\s*prompt:\s*([\w\-]+)\s*-->/g;
    const hashCommentRe = /^\s*#\s*prompt:\s*([\w\-]+)\s*$/gm;
    const blockStartRe = /<!--\s*prompt:\s*([\w\-]+):start\s*-->/g;
    const blockEndRe = /<!--\s*prompt:\s*([\w\-]+):end\s*-->/g;
    // 1. Single cell comments
    console.log('\n--- 1. Scan single cell comments ---');
    for (let i = 0; i < notebook.cellCount; ++i) {
        const cell = notebook.cellAt(i);
        const text = cell.document.getText();
        console.log(`Cell ${i} (${cell.kind === vscode.NotebookCellKind.Markup ? 'Markdown' : 'Code'}):`, text.substring(0, 100) + (text.length > 100 ? '...' : ''));
        let match;
        // HTML comments
        while ((match = htmlCommentRe.exec(text)) !== null) {
            const key = match[1];
            console.log(`  Found HTML comment: prompt:${key}`);
            // Extract the content after the comment, not the whole cell
            const afterComment = text.substring(match.index + match[0].length).trim();
            placeholderMap.set(key, afterComment);
        }
        // Hash (#) comments
        while ((match = hashCommentRe.exec(text)) !== null) {
            const key = match[1];
            console.log(`  Found hash comment: prompt:${key}`);
            // Extract the content after the comment, not the whole cell
            const afterComment = text.substring(match.index + match[0].length).trim();
            placeholderMap.set(key, afterComment);
        }
    }
    // 2. Multi-block sections (allow auto-concatenation of multiple blocks for the same key)
    console.log('\n--- 2. Scan multi-block sections ---');
    for (let i = 0; i < notebook.cellCount; ++i) {
        const cell = notebook.cellAt(i);
        const text = cell.document.getText();
        let startMatch;
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
                }
                else {
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
                    }
                    else {
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
            }
            else {
                console.log(`    Warning: No matching end for block ${key}`);
            }
        }
    }
    // 3. Scan special cell reference placeholders (cell:1, cell:2, ..., cell:N, cell:this, cell:-1, cell:+1)
    console.log('\n--- 3. Scan special cell reference placeholders ---');
    const cellRefPatterns = [
        /prompt:\s*(cell:this)/,
        // With type filter, must appear after prompt marker
        /prompt:\s*(cell:-?\d+:(md|cd))/,
        /prompt:\s*(cell:\+\d+:(md|cd))/,
        /prompt:\s*(cell:[1-9]\d*:(md|cd))/,
        // Without type, no colon allowed after, must appear after prompt marker
        /prompt:\s*(cell:-?\d+(?!:))/,
        /prompt:\s*(cell:\+\d+(?!:))/,
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
// 1. Extract all placeholder keys from the template
function getTemplatePlaceholderKeys(template) {
    const keys = new Set();
    const regex = /\{\{([\w\-:+=]+)\}\}/g;
    let match;
    while ((match = regex.exec(template)) !== null) {
        keys.add(match[1]);
    }
    return keys;
}
// fill the template, only replace the placeholders that are declared in the notebook
function fillPromptTemplate(template, placeholderMap, notebook) {
    let result = template.replace(/\{\{([\w\-:+=]+)\}\}/g, (m, key) => {
        var _a;
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
                    }
                    else {
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
                    }
                    else {
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
                    }
                    else {
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
                    }
                    else {
                        console.log(`    No matching cell found for ${key}`);
                        return '';
                    }
                }
            }
            // for normal placeholders, just return the value
            const value = (_a = placeholderMap.get(key)) !== null && _a !== void 0 ? _a : '';
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
function activate(ctx) {
    (0, localServer_2.setExtensionContext)(ctx);
    const provider = {
        provideCellStatusBarItems(cell) {
            const items = [];
            if (cell.document.languageId === 'python') {
                const cfg = vscode.workspace.getConfiguration('jupyterAiFeedback');
                const alwaysShowErrorHelper = cfg.get('errorHelper.alwaysShow', false);
                const cellOutput = getCellOutput(cell);
                const hasError = cellOutput.executionError ||
                    (cellOutput.hasOutput && cellOutput.output.toLowerCase().includes('error'));
                const shouldShowErrorHelper = alwaysShowErrorHelper || hasError;
                if (shouldShowErrorHelper) {
                    const errorHelperItem = new vscode.NotebookCellStatusBarItem('🆘 Error Helper', vscode.NotebookCellStatusBarAlignment.Right);
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
                const item = new vscode.NotebookCellStatusBarItem('$(zap) 🧠 AI Feedback', vscode.NotebookCellStatusBarAlignment.Right);
                item.priority = 100;
                item.command = {
                    command: 'jupyterAiFeedback.sendNotebookCell',
                    title: 'Send to AI',
                    arguments: [cell]
                };
                items.push(item);
            }
            if (cell.document.languageId === 'markdown') {
                const speechItem = new vscode.NotebookCellStatusBarItem('$(mic)', vscode.NotebookCellStatusBarAlignment.Right);
                speechItem.priority = 100;
                speechItem.command = {
                    command: 'jupyterAiFeedback.toggleRecording',
                    title: 'Speech to Text',
                    arguments: [cell]
                };
                items.push(speechItem);
            }
            const text = cell.document.getText().toLowerCase();
            if (cell.kind === vscode.NotebookCellKind.Markup &&
                (text.includes('**feedback**') || text.includes('**🤖feedback expansion**'))) {
                const cfg = vscode.workspace.getConfiguration('jupyterAiFeedback');
                const mode = cfg.get('feedbackMode');
                const label = mode === 'Expand'
                    ? '📖 ➤ Expand | Explain'
                    : '📖 Expand | ➤ Explain';
                const markdownItem = new vscode.NotebookCellStatusBarItem(label, vscode.NotebookCellStatusBarAlignment.Right);
                markdownItem.command = {
                    command: 'jupyterAiFeedback.explainMarkdownCell',
                    title: 'Expand or Explain Feedback Markdown',
                    arguments: [cell]
                };
                markdownItem.priority = 100;
                markdownItem.tooltip = `Use AI to ${mode} the feedback`;
                items.push(markdownItem);
            }
            return items;
        }
    };
    ctx.subscriptions.push(vscode.notebooks.registerNotebookCellStatusBarItemProvider('*', provider));
    // Error Helper command - with intelligent state handling
    ctx.subscriptions.push(vscode.commands.registerCommand('jupyterAiFeedback.errorHelper', (cell) => __awaiter(this, void 0, void 0, function* () {
        var _a, _b;
        const editor = vscode.window.activeNotebookEditor;
        if (!editor) {
            return vscode.window.showErrorMessage('No active Notebook editor');
        }
        const config = readLLMConfig();
        if (!config)
            return;
        const code = cell.document.getText();
        let cellOutput = getCellOutput(cell);
        // Case 1: Cell hasn't been run yet
        if (!cellOutput.hasOutput) {
            const action = yield vscode.window.showInformationMessage('This cell hasn\'t been run yet. Would you like to run it first to check for errors?', 'Run and Check', 'Cancel');
            if (action !== 'Run and Check') {
                return;
            }
            // Execute the cell
            try {
                yield vscode.commands.executeCommand('notebook.cell.execute', cell);
                // Wait for execution to complete (simple approach)
                yield new Promise(resolve => setTimeout(resolve, 2000));
                // Re-check output after execution
                cellOutput = getCellOutput(cell);
                if (!cellOutput.hasOutput) {
                    vscode.window.showWarningMessage('Cell execution may still be running. Please try again in a moment.');
                    return;
                }
            }
            catch (error) {
                vscode.window.showErrorMessage('Failed to execute cell. Please run it manually and try again.');
                return;
            }
        }
        // Case 2: Cell ran but no errors detected
        if (!cellOutput.executionError && !cellOutput.output.toLowerCase().includes('error')) {
            const action = yield vscode.window.showInformationMessage('No errors found! 🎉 Consider using AI Feedback for code quality suggestions.', 'Open AI Feedback', 'OK');
            if (action === 'Open AI Feedback') {
                yield vscode.commands.executeCommand('jupyterAiFeedback.sendNotebookCell', cell);
            }
            return;
        }
        // Case 3: Cell has errors - proceed with normal analysis
        try {
            console.log('=== Error Helper Debug ===');
            console.log('Cell has', cellOutput.hasOutput ? 'output' : 'no output');
            console.log('Execution error:', cellOutput.executionError);
            console.log('Output content:', cellOutput.output.substring(0, 200));
            console.log('Current cell outputs count:', ((_a = cell.outputs) === null || _a === void 0 ? void 0 : _a.length) || 0);
            console.log('=== End Debug ===');
            yield syncGitRepo();
            const promptContent = yield getPromptContent('error_helper');
            let prompt = promptContent.replace('{{code}}', code);
            prompt = prompt.replace('{{code_output}}', cellOutput.output);
            const feedback = yield callLLMAPI(prompt, config);
            // Check output mode setting
            const cfg = vscode.workspace.getConfiguration('jupyterAiFeedback');
            const outputMode = cfg.get('errorHelperOutput', 'markdown');
            console.log('Using output mode:', outputMode);
            if (outputMode === 'cellOutput') {
                yield addAnalysisToCellOutput(cell, feedback);
                const action = yield vscode.window.showInformationMessage('Error analysis complete. Want to ask follow-up questions?', 'Start Chat');
                if (action === 'Start Chat') {
                    ErrorHelperPanel.createOrShow(ctx.extensionUri, cell, config, feedback);
                }
            }
            else {
                // markdown mode
                const isMac = process.platform === 'darwin';
                const shortcut = isMac ? 'Cmd+Shift+P' : 'Ctrl+Shift+P';
                const content = `# **🆘 Error Helper**

${feedback}

---
*💬 Want to ask follow-up questions? Use Command Palette (${shortcut}) to run "Start Error Helper Chat".*`;
                yield insertMarkdownCellBelow(editor.notebook, cell.index, content);
                const action = yield vscode.window.showInformationMessage('Error analysis complete. Want to ask follow-up questions?', 'Start Chat');
                if (action === 'Start Chat') {
                    ErrorHelperPanel.createOrShow(ctx.extensionUri, cell, config, feedback);
                }
            }
        }
        catch (e) {
            console.error('Error Helper failed:', e);
            let errorMessage = 'Error Helper failed: ' + e.message;
            if ((_b = e.response) === null || _b === void 0 ? void 0 : _b.data) {
                errorMessage += '\nResponse: ' + JSON.stringify(e.response.data, null, 2);
            }
            return vscode.window.showErrorMessage(errorMessage);
        }
    })));
    // Start Error Chat command
    ctx.subscriptions.push(vscode.commands.registerCommand('jupyterAiFeedback.startErrorChat', (cell, errorHelperFeedback) => __awaiter(this, void 0, void 0, function* () {
        const config = readLLMConfig();
        if (!config)
            return;
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
        ErrorHelperPanel.createOrShow(ctx.extensionUri, cell, config, errorHelperFeedback);
    })));
    // Command executed when button is clicked
    ctx.subscriptions.push(vscode.commands.registerCommand('jupyterAiFeedback.sendNotebookCell', (cell) => __awaiter(this, void 0, void 0, function* () {
        var _c;
        const editor = vscode.window.activeNotebookEditor;
        if (!editor) {
            return vscode.window.showErrorMessage('No active Notebook editor');
        }
        // Read user configuration
        const cfg = vscode.workspace.getConfiguration('jupyterAiFeedback');
        const apiUrl = cfg.get('apiUrl') || '';
        const apiKey = cfg.get('apiKey') || '';
        const modelName = cfg.get('modelName') || '';
        const templateId = cfg.get('templateId', '1');
        const useHiddenTests = cfg.get('useHiddenTests', true);
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
            return vscode.window.showErrorMessage('Please configure jupyterAiFeedback.apiUrl, apiKey, and modelName in settings');
        }
        // Get code from cell
        const code = cell.document.getText();
        // 1. Sync GitHub repository
        yield syncGitRepo();
        // 2. Get prompt content
        const promptIdFromCell = extractPromptId(code);
        const promptId = promptIdFromCell || cfg.get('templateId', '');
        // check if prompt id exists in local prompt list
        const templates = yield listLocalTemplates();
        const promptExists = templates.some(t => t.id === promptId);
        if (!promptExists) {
            vscode.window.showErrorMessage(`Prompt ID "${promptId}" not found in the prompt repository`);
            return;
        }
        const promptContent = yield getPromptContent(promptId);
        // 3. Initialize analysis variable
        let analysis = '';
        // 4. If useHiddenTests is enabled, get test content and run tests
        if (useHiddenTests) {
            const exId = extractExerciseId(code);
            if (!exId) {
                vscode.window.showWarningMessage('No # EXERCISE_ID found in code');
                return;
            }
            const { test, metadata } = yield getTestFiles(exId);
            // Get notebook Python path
            const pythonPath = yield getNotebookPythonPath();
            console.log("pythonPath:", pythonPath);
            if (!pythonPath) {
                vscode.window.showErrorMessage('cannot detect the Python environment of the current Notebook, please select the kernel first');
                return;
            }
            const requiredPkgs = ['pytest', 'pytest-json-report'];
            for (const pkg of requiredPkgs) {
                const hasPkg = yield checkPytestInstalled(pythonPath, pkg);
                if (!hasPkg) {
                    const ok = yield ensurePythonDeps(pythonPath, [pkg]);
                    if (!ok)
                        return;
                }
            }
            // Run tests locally
            const testResult = yield runLocalTest(code, test, pythonPath);
            // Parse test results and generate analysis
            if (testResult.report && testResult.report.tests) {
                const total = testResult.report.tests.length;
                const passed = testResult.report.tests.filter((t) => t.outcome === 'passed').length;
                const failed = total - passed;
                if (failed > 0) {
                    analysis += `## Failed Test Details\n\n`;
                    const failedTests = testResult.report.tests.filter((t) => t.outcome === 'failed');
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
                }
                else if (total === 0) {
                    // if no tests are run, it means there is a code execution or syntax error
                    analysis += `Hidden tests could not be run due to a code execution or syntax error.\n`;
                }
                else {
                    analysis += `## Test Results\n`;
                    analysis += `- All ${total} tests passed!\n\n`;
                }
            }
            else {
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
        console.log("promptContent:", promptContent);
        console.log("analysis:", analysis);
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
                console.log("cellOutput:", cellOutput.output);
            }
            else {
                placeholderMap.set('code_output', '');
            }
        }
        // Add analysis to prompt only if useHiddenTests is enabled and analysis exists
        if (useHiddenTests && analysis) {
            placeholderMap.set('hidden_tests', analysis);
        }
        else {
            placeholderMap.set('hidden_tests', '');
        }
        // Fill only declared placeholders, keep others unchanged
        prompt = fillPromptTemplate(prompt, placeholderMap, editor.notebook);
        // console.log("Final prompt after filling placeholders:", prompt);
        // Add system role to the beginning of the prompt
        const system_role = "You are a Python teaching assistant for programming beginners. Given the uploaded code and optional hidden test results, offer concise code suggestions on improvement and fixing output errors without directly giving solutions. Be encouraging and constructive in your feedback. ";
        const fullPrompt = system_role + prompt;
        console.log("fullPrompt:", fullPrompt);
        // Call the LLM interface
        let feedback;
        try {
            // Check if using OpenAI-compatible endpoint
            const isOpenAIEndpoint = apiUrl.includes('/chat/completions');
            let body;
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
            }
            else {
                // Ollama format for /ollama/api/generate
                body = {
                    model: modelName,
                    prompt: fullPrompt
                };
            }
            console.log('=== API Request Debug ===');
            console.log('API URL:', apiUrl);
            console.log('Model Name:', modelName);
            console.log('Is OpenAI Endpoint:', isOpenAIEndpoint);
            console.log('Request Body:', JSON.stringify(body, null, 2));
            console.log('=== End API Request Debug ===');
            const resp = yield axios_1.default.post(apiUrl, body, {
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`
                },
                responseType: isOpenAIEndpoint ? 'json' : 'text'
            });
            console.log('=== API Response Debug ===');
            console.log('Response Status:', resp.status);
            // console.log('Response Data:', resp.data);
            console.log('Response Headers:', resp.headers);
            console.log('=== End API Response Debug ===');
            if (isOpenAIEndpoint) {
                // Handle OpenAI format response
                if (resp.data.choices && resp.data.choices[0] && resp.data.choices[0].message) {
                    feedback = resp.data.choices[0].message.content;
                }
                else {
                    throw new Error('Invalid OpenAI response format');
                }
            }
            else {
                // Handle Ollama streaming response
                const lines = resp.data.split('\n').filter((line) => line.trim());
                let fullResponse = '';
                for (const line of lines) {
                    try {
                        const jsonResponse = JSON.parse(line);
                        if (jsonResponse.response) {
                            fullResponse += jsonResponse.response;
                        }
                    }
                    catch (e) {
                        console.warn('Failed to parse JSON line:', line);
                    }
                }
                if (!fullResponse) {
                    console.error('No valid response content found');
                    throw new Error('No valid response content received from API.');
                }
                feedback = fullResponse;
            }
            console.log('feedback:', feedback);
        }
        catch (e) {
            let errorMessage = 'AI API call failed: ' + e.message;
            if ((_c = e.response) === null || _c === void 0 ? void 0 : _c.data) {
                errorMessage += '\nResponse: ' + JSON.stringify(e.response.data, null, 2);
            }
            return vscode.window.showErrorMessage(errorMessage);
        }
        const notebook = editor.notebook;
        const cellIndex = cell.index;
        const content = `# **AI Feedback**\n\n${feedback.replace(/\n/g, '  \n')}`;
        yield insertMarkdownCellBelow(notebook, cellIndex, content);
    })));
    // Template management commands
    ctx.subscriptions.push(vscode.commands.registerCommand('jupyterAiFeedback.listTemplates', () => __awaiter(this, void 0, void 0, function* () {
        yield syncGitRepo();
        const templates = yield listLocalTemplates();
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
    })));
    // Exercise management command
    ctx.subscriptions.push(vscode.commands.registerCommand('jupyterAiFeedback.listExercises', () => __awaiter(this, void 0, void 0, function* () {
        yield syncGitRepo();
        const exercises = yield listLocalExercises();
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
    })));
    ctx.subscriptions.push(vscode.commands.registerCommand('jupyterAiFeedback.selectTemplate', () => __awaiter(this, void 0, void 0, function* () {
        yield syncGitRepo();
        const templates = yield listLocalTemplates();
        if (templates.length === 0) {
            vscode.window.showInformationMessage('No available templates');
            return;
        }
        // 生成下拉选项
        const items = templates.map(t => ({
            label: t.id,
            description: t.filename
        }));
        const pick = yield vscode.window.showQuickPick(items, {
            placeHolder: 'Please select a template'
        });
        if (pick) {
            // 写入配置
            yield vscode.workspace.getConfiguration('jupyterAiFeedback')
                .update('templateId', pick.label, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(`Selected template: ${pick.label}`);
        }
    })));
    // Sync GitHub repository command
    ctx.subscriptions.push(vscode.commands.registerCommand('jupyterAiFeedback.syncGitRepo', () => __awaiter(this, void 0, void 0, function* () {
        try {
            vscode.window.showInformationMessage('Syncing GitHub repository...');
            yield syncGitRepo();
            vscode.window.showInformationMessage('GitHub repository synced successfully!');
        }
        catch (error) {
            console.error('Sync failed:', error);
            vscode.window.showErrorMessage(`Failed to sync repository: ${error}`);
        }
    })));
    // Show prompt content command
    ctx.subscriptions.push(vscode.commands.registerCommand('jupyterAiFeedback.showPromptContent', () => __awaiter(this, void 0, void 0, function* () {
        try {
            yield syncGitRepo();
            const templates = yield listLocalTemplates();
            if (templates.length === 0) {
                vscode.window.showInformationMessage('No available templates');
                return;
            }
            // 生成下拉选项
            const items = templates.map(t => ({
                label: t.id,
                description: t.filename
            }));
            const pick = yield vscode.window.showQuickPick(items, {
                placeHolder: 'Please select a prompt to view'
            });
            if (pick) {
                const promptContent = yield getPromptContent(pick.label);
                const output = vscode.window.createOutputChannel(`Prompt: ${pick.label}`);
                output.show();
                output.appendLine(`Prompt ID: ${pick.label}`);
                output.appendLine('='.repeat(50));
                output.appendLine(promptContent);
            }
        }
        catch (error) {
            console.error('Show prompt content failed:', error);
            vscode.window.showErrorMessage(`Failed to show prompt content: ${error}`);
        }
    })));
    // Speech-to-Text logic
    ctx.subscriptions.push(vscode.commands.registerCommand('jupyterAiFeedback.toggleRecording', (cell) => __awaiter(this, void 0, void 0, function* () {
        yield (0, speech_1.toggleRecording)(cell);
    })));
    function replaceCellContent(doc, content) {
        return __awaiter(this, void 0, void 0, function* () {
            const edit = new vscode.WorkspaceEdit();
            const start = new vscode.Position(0, 0);
            const end = doc.lineAt(doc.lineCount - 1).range.end;
            const fullRange = new vscode.Range(start, end);
            edit.replace(doc.uri, fullRange, content);
            yield vscode.workspace.applyEdit(edit);
        });
    }
    function cleanMarkdown(text) {
        let cleaned = text;
        // Complete unmatched markdown symbols
        const count = (str) => (cleaned.match(new RegExp(str, 'g')) || []).length;
        if (count('\\*\\*') % 2 !== 0)
            cleaned += '**';
        if ((count('\\*') - 2 * count('\\*\\*')) % 2 !== 0)
            cleaned += '*';
        if (count('`') % 2 !== 0)
            cleaned += '`';
        // Ensure headings start on a new line
        cleaned = cleaned.replace(/(##\\s.*?)(?=\\S)/g, '\n$1');
        // Remove unnecessary backslashes
        cleaned = cleaned.replace(/\\([a-zA-Z])/g, '$1');
        cleaned = cleaned.replace(/\\\\n/g, '\n');
        return cleaned.trim();
    }
    // Markdown cell
    ctx.subscriptions.push(vscode.commands.registerCommand('jupyterAiFeedback.explainMarkdownCell', (cell) => __awaiter(this, void 0, void 0, function* () {
        var _d, e_1, _e, _f;
        var _g;
        const editor = vscode.window.activeNotebookEditor;
        if (!editor) {
            return vscode.window.showErrorMessage('No activity');
        }
        const content = (_g = cell.document.getText()) === null || _g === void 0 ? void 0 : _g.toLowerCase();
        if (!content.includes('feedback')) {
            vscode.window.showWarningMessage('This markdown cell does not appear to contain feedback.');
            return;
        }
        const cfg = vscode.workspace.getConfiguration('jupyterAiFeedback');
        const mode = cfg.get('feedbackMode');
        const apiUrl = cfg.get('apiUrl') || '';
        const apiKey = cfg.get('apiKey') || '';
        const modelName = cfg.get('modelName') || '';
        if (!apiUrl || !apiKey || !mode) {
            return vscode.window.showErrorMessage('Please set apiUrl, apiKey and feedbackMode in your settings');
        }
        const fullText = cell.document.getText();
        // full text or select sentences
        let inputText = '';
        let header = '';
        if (mode === 'Expand') {
            inputText = fullText;
            header = `**🤖 Feedback Expansion**`;
        }
        else if (mode === 'Explain') {
            // select sentences
            const activeEditor = vscode.window.activeTextEditor;
            const selection = activeEditor === null || activeEditor === void 0 ? void 0 : activeEditor.selection;
            const selectedText = selection && !selection.isEmpty
                ? activeEditor.document.getText(selection)
                : null;
            if (!selectedText || selectedText.trim().length === 0) {
                return vscode.window.showErrorMessage('Please select the sentence you want explained.');
            }
            inputText = selectedText;
            header = `**🤖 Explanation for:** _"${selectedText}"_`;
        }
        else {
            return vscode.window.showErrorMessage(`Unsupported mode: ${mode}`);
        }
        yield syncGitRepo();
        const promptTpl = yield getPromptContent(mode);
        const prompt = promptTpl.replace('{{content}}', inputText);
        const generatingNote = `*(Generating...)*`;
        const finishedNote = `**✅ AI Generation Completed**`;
        // add or renew markdown cell
        let newCell;
        const nextIndex = cell.index + 1;
        if (nextIndex < editor.notebook.cellCount &&
            editor.notebook.cellAt(nextIndex).kind === vscode.NotebookCellKind.Markup &&
            editor.notebook.cellAt(nextIndex).document.getText().startsWith(header)) {
            newCell = editor.notebook.cellAt(nextIndex);
        }
        else {
            yield vscode.commands.executeCommand('notebook.cell.insertMarkdownCellBelow');
            newCell = editor.notebook.cellAt(cell.index + 1);
        }
        const doc = newCell.document;
        yield replaceCellContent(doc, `${header}\n\n${generatingNote}\n`);
        try {
            const body = {
                model: modelName,
                prompt: prompt,
                stream: true
            };
            const resp = yield axios_1.default.post(apiUrl, body, {
                headers: {
                    'content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`
                },
                responseType: 'stream'
            });
            let accumulated = '';
            try {
                for (var _h = true, _j = __asyncValues(resp.data), _k; _k = yield _j.next(), _d = _k.done, !_d;) {
                    _f = _k.value;
                    _h = false;
                    try {
                        const chunk = _f;
                        const line = chunk.toString().trim();
                        const match = line.match(/"response":"(.*?)"/);
                        if (match) {
                            const delta = match[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
                            accumulated += delta;
                            const safeText = cleanMarkdown(accumulated);
                            const updatedContent = `${header}\n\n${safeText.replace(/\n/g, '  \n')}\n\n${generatingNote}`;
                            yield replaceCellContent(doc, updatedContent);
                        }
                    }
                    finally {
                        _h = true;
                    }
                }
            }
            catch (e_1_1) { e_1 = { error: e_1_1 }; }
            finally {
                try {
                    if (!_h && !_d && (_e = _j.return)) yield _e.call(_j);
                }
                finally { if (e_1) throw e_1.error; }
            }
            // give a sign that it is finished generating
            const finalText = cleanMarkdown(accumulated);
            const finalContent = `${header}\n\n${finalText.replace(/\n/g, '  \n')}\n\n${finishedNote}`;
            yield replaceCellContent(doc, finalContent);
        }
        catch (e) {
            console.error("AI Extension fail:", e);
            const errorMsg = `${header}\n\n❌ AI generation failed:\n\n\`${e.message}\``;
            yield replaceCellContent(doc, errorMsg);
            return vscode.window.showErrorMessage('Ai Extension fail:' + e.message);
        }
    })));
    // follow up question button
    ctx.subscriptions.push(vscode.commands.registerCommand('jupyterAiFeedback.askFollowUpFromButton', (cell) => __awaiter(this, void 0, void 0, function* () {
        const editor = vscode.window.activeNotebookEditor;
        if (!editor) {
            return vscode.window.showErrorMessage('No active notebook editor');
        }
        const explanation = cell.document.getText();
        const conversation = [
            { role: 'assistant', content: explanation }
        ];
        let followupPrompt = '';
        try {
            followupPrompt = yield getPromptContent('Followup');
            conversation.push({ role: 'followup', content: followupPrompt });
        }
        catch (e) {
            vscode.window.showErrorMessage('⚠️ Failed to load Followup prompt: ' + e.message);
        }
        conversation.push({ role: 'assistant', content: explanation });
        const panel = vscode.window.createWebviewPanel('followUpChat', 'Follow-up Chat', vscode.ViewColumn.Beside, { enableScripts: true });
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
            resize:none;
            min-height:2.4em;
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

          ul {
            margin-top: 0.3em;
            margin-bottom: 0.3em;
            padding-left: 1.2em;
          }

          li {
            margin: 0.2em 0;
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
          <input id="input" placeholder="Type your follow-up question..." />
          <button id="sendBtn">Send</button>
        </div>

        <div id="loadingStatus" style="margin-top: 0.5em; font-size: 0.9em; color: #555;"></div>


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
                const loading = document.getElementById('loadingStatus');
                button.disabled = true;
                button.textContent = 'Sending...';
                loading.textContent = '🤖 Generating response...';

                vscode.postMessage({ type: 'ask', question: text });
              });
              container.appendChild(btn);
            });
          }

          function sendMessage() {
            const input = document.getElementById('input');
            const question = input.value.trim();
            const button = document.getElementById('sendBtn');
            const loading = document.getElementById('loadingStatus');
            if (question) {
              appendMessage('user', question);

              // show loading status
              button.disabled = true;
              button.textContent = 'Sending...';
              loading.textContent = '🤖 Generating response...';

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

              const loading = document.getElementById('loadingStatus');
              loading.textContent = '';
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
        panel.webview.onDidReceiveMessage((msg) => __awaiter(this, void 0, void 0, function* () {
            var _l;
            if (msg.type === 'ask') {
                const question = msg.question;
                conversation.push({ role: 'user', content: question });
                const cfg = vscode.workspace.getConfiguration('jupyterAiFeedback');
                const apiUrl = cfg.get('apiUrl') || '';
                const apiKey = cfg.get('apiKey') || '';
                const modelName = cfg.get('modelName') || '';
                //const fullPrompt = conversation.map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`).join('\n') + '\nAssistant:';
                const fullPrompt = conversation
                    .filter(msg => msg.role !== 'followup')
                    .map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
                    .join('\n') + '\nAssistant:';
                const body = {
                    model: modelName,
                    prompt: fullPrompt,
                    stream: false
                };
                try {
                    const resp = yield axios_1.default.post(apiUrl, body, {
                        headers: {
                            'Content-Type': 'application/json',
                            Authorization: `Bearer ${apiKey}`
                        }
                    });
                    const answer = ((_l = resp.data.message) === null || _l === void 0 ? void 0 : _l.content) || resp.data.response || 'No response received';
                    conversation.push({ role: 'assistant', content: answer });
                    // const chatHtml = buildChatHtml(conversation);
                    panel.webview.postMessage({ type: 'answer', content: answer });
                }
                catch (e) {
                    vscode.window.showErrorMessage('Failed to fetch follow-up response: ' + e.message);
                }
            }
        }));
    })));
    ctx.subscriptions.push(vscode.notebooks.registerNotebookCellStatusBarItemProvider('jupyter-notebook', {
        provideCellStatusBarItems(cell, _token) {
            const items = [];
            if (cell.kind === vscode.NotebookCellKind.Markup) {
                const text = cell.document.getText();
                // Explanation cell
                if (text.includes('**🤖Explanation** for:')) {
                    const item = new vscode.NotebookCellStatusBarItem('💬 Ask follow-up', vscode.NotebookCellStatusBarAlignment.Right);
                    item.command = 'jupyterAiFeedback.askFollowUpFromButton';
                    item.tooltip = 'Ask a follow-up question about this explanation';
                    items.push(item);
                }
                ;
                // Feeback Expansion cell
                if (text.includes('**🤖Feedback Expansion**')) {
                    const item = new vscode.NotebookCellStatusBarItem('💬 Ask follow-up', vscode.NotebookCellStatusBarAlignment.Right);
                    item.command = 'jupyterAiFeedback.askFollowUpFromButton';
                    item.tooltip = 'Ask a follow-up question about this explanation';
                    items.push(item);
                }
            }
            return items;
        }
    }));
}
exports.activate = activate;
function deactivate() {
    // Clean up any resources if needed
    if (ErrorHelperPanel.currentPanel) {
        ErrorHelperPanel.currentPanel.dispose();
    }
    (0, localServer_1.killLocal)();
}
exports.deactivate = deactivate;
//# sourceMappingURL=extension.js.map