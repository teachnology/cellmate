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
const axios_1 = __importDefault(require("axios"));
const simple_git_1 = __importDefault(require("simple-git"));
//const GIT_REPO_URL = 'https://github.com/teachnology/promptfolio.git';
const GIT_REPO_URL = 'https://github.com/esemsc-hl524/promptfolio.git';
const LOCAL_REPO_PATH = path.join(os.tmpdir(), 'promptfolio_repo');
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
function activate(ctx) {
    const provider = {
        provideCellStatusBarItems(cell) {
            const items = [];
            if (cell.document.languageId === 'python' && cell.kind === vscode.NotebookCellKind.Code) {
                const item = new vscode.NotebookCellStatusBarItem('$(zap) 🧠 AI Feedback', vscode.NotebookCellStatusBarAlignment.Right);
                item.priority = 100;
                item.command = {
                    command: 'jupyterAiFeedback.sendNotebookCell',
                    title: 'Send to AI',
                    arguments: [cell]
                };
                items.push(item);
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
    // 2) 点击按钮后执行的命令
    ctx.subscriptions.push(vscode.commands.registerCommand('jupyterAiFeedback.sendNotebookCell', (cell) => __awaiter(this, void 0, void 0, function* () {
        const editor = vscode.window.activeNotebookEditor;
        if (!editor) {
            return vscode.window.showErrorMessage('没有活动的 Notebook 编辑器');
        }
        // 2.1 读取用户配置
        const cfg = vscode.workspace.getConfiguration('jupyterAiFeedback');
        const apiUrl = cfg.get('apiUrl') || '';
        const apiKey = cfg.get('apiKey') || '';
        const promptTpl = cfg.get('promptTemplate') || '';
        if (!apiUrl || !apiKey || !promptTpl) {
            return vscode.window.showErrorMessage('请先在设置中配置 jupyterAiFeedback.apiUrl、apiKey 和 promptTemplate');
        }
        // 2.2 拿到 cell 里的代码并套入模板
        const code = cell.document.getText();
        const prompt = promptTpl.replace('{{code}}', code);
        const system_role = "You are a patient and detail-oriented Python teaching assistant. ";
        "Based on the analysis below, provide step-by-step, targeted feedback:\n";
        "- Ask leading questions that guide the student toward discovering the solution, rather than giving full code.\n";
        "- If helpful, recommend relevant learning resources or key concepts.\n";
        const body = {
            model: 'llama3',
            messages: [
                { role: 'system', content: system_role },
                { role: 'user', content: prompt }
            ]
        };
        // 2.3 调用你的 LLM 接口
        let feedback;
        try {
            const resp = yield axios_1.default.post(apiUrl, body, {
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`
                }
            });
            //   feedback = resp.data.feedback;
            feedback = resp.data.choices[0].message.content;
        }
        catch (e) {
            return vscode.window.showErrorMessage('AI 接口调用失败：' + e.message);
        }
        // 2.4 插入一个空的 Markdown cell（调用内置命令）
        yield vscode.commands.executeCommand('notebook.cell.insertMarkdownCellBelow');
        // 2.5 找到新插入的 cell（它在原 cell.index + 1）
        const newCell = editor.notebook.cellAt(cell.index + 1);
        const doc = newCell.document;
        // 2.6 用 WorkspaceEdit 替换这个 cell 的全部内容
        const lastLine = doc.lineCount > 0 ? doc.lineCount - 1 : 0;
        const fullRange = new vscode.Range(0, 0, lastLine, doc.lineAt(lastLine).text.length);
        const content = `**AI Feedback**\n\n${feedback.replace(/\n/g, '  \n')}`;
        const edit = new vscode.WorkspaceEdit();
        edit.replace(doc.uri, fullRange, content);
        yield vscode.workspace.applyEdit(edit);
    })));
    // Markdown cell
    ctx.subscriptions.push(vscode.commands.registerCommand('jupyterAiFeedback.explainMarkdownCell', (cell) => __awaiter(this, void 0, void 0, function* () {
        var _a, e_1, _b, _c;
        var _d;
        const editor = vscode.window.activeNotebookEditor;
        if (!editor) {
            return vscode.window.showErrorMessage('No activity');
        }
        const content = (_d = cell.document.getText()) === null || _d === void 0 ? void 0 : _d.toLowerCase();
        if (!content.includes('feedback')) {
            vscode.window.showWarningMessage('This markdown cell does not appear to contain feedback.');
            return;
        }
        const cfg = vscode.workspace.getConfiguration('jupyterAiFeedback');
        const mode = cfg.get('feedbackMode');
        const apiUrl = cfg.get('apiUrl') || '';
        const apiKey = cfg.get('apiKey') || '';
        if (!apiUrl || !apiKey || !mode) {
            return vscode.window.showErrorMessage('Please set apiUrl, apiKey and feedbackMode in your settings');
        }
        yield syncGitRepo();
        const promptTpl = yield getPromptContent(mode);
        const prompt = promptTpl.replace('{{content}}', content);
        const title = mode === 'Expand' ? 'Feedback Expansion' : 'Explanation';
        const body = {
            model: 'gemma3:27b',
            prompt: prompt,
            stream: true
        };
        const header = `**🤖${title}**`;
        const generatingNote = `*(Generating...)*`;
        const finishedNote = `**✅ AI Generation Completed**`;
        // modify markdown cell
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
            const resp = yield axios_1.default.post(apiUrl, body, {
                headers: {
                    'content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`
                },
                responseType: 'stream'
            });
            let accumulated = '';
            try {
                for (var _e = true, _f = __asyncValues(resp.data), _g; _g = yield _f.next(), _a = _g.done, !_a;) {
                    _c = _g.value;
                    _e = false;
                    try {
                        const chunk = _c;
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
                        _e = true;
                    }
                }
            }
            catch (e_1_1) { e_1 = { error: e_1_1 }; }
            finally {
                try {
                    if (!_e && !_a && (_b = _f.return)) yield _b.call(_f);
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
          body {
            margin: 0;
            padding: 0;
            font-family: sans-serif;
            height: 100vh;
            display: flex;
            flex-direction: column;
          }

          #chat {
            flex: 1;
            overflow-y: auto;
            padding: 1em;
            background: #f4f4f4;
          }

          .message {
            max-width: 80%;
            margin: 0.5em 0;
            padding: 0.75em 1em;
            border-radius: 10px;
            line-height: 1.4;
          }

          .user {
            background-color: #d1e7ff;
            align-self: flex-end;
            text-align: right;
          }

          .assistant {
            background-color: #ffffff;
            align-self: flex-start;
            border: 1px solid #ccc;
          }

          #inputArea {
            display: flex;
            padding: 0.5em;
            border-top: 1px solid #ccc;
            background: #fff;
          }

          #input {
            flex: 1;
            padding: 0.5em;
            font-size: 1em;
            border: 1px solid #ccc;
            border-radius: 5px;
          }

          button {
            margin-left: 0.5em;
            padding: 0.5em 1em;
            font-size: 1em;
          }
        </style>
        <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
      </head>
      <body>
        <div id="chat"></div>

        <div id="inputArea">
          <input id="input" placeholder="Type your follow-up question..." />
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

          document.getElementById('sendBtn').addEventListener('click', () => {
            const input = document.getElementById('input');
            const question = input.value.trim();
            if (question) {
              appendMessage('user', question);
              vscode.postMessage({ type: 'ask', question });
              input.value = '';
            }
          });

          window.addEventListener('message', event => {
            const msg = event.data;
            if (msg.type === 'answer') {
              appendMessage('assistant', msg.content);
            }
          });
        </script>
      </body>
      </html>`;
        }
        panel.webview.html = getHTML();
        panel.webview.onDidReceiveMessage((msg) => __awaiter(this, void 0, void 0, function* () {
            var _h;
            if (msg.type === 'ask') {
                const question = msg.question;
                conversation.push({ role: 'user', content: question });
                const cfg = vscode.workspace.getConfiguration('jupyterAiFeedback');
                const apiUrl = cfg.get('apiUrl') || '';
                const apiKey = cfg.get('apiKey') || '';
                //const fullPrompt = conversation.map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`).join('\n') + '\nAssistant:';
                const fullPrompt = conversation
                    .filter(msg => msg.role !== 'followup')
                    .map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
                    .join('\n') + '\nAssistant:';
                const body = {
                    model: 'gemma3:27b',
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
                    const answer = ((_h = resp.data.message) === null || _h === void 0 ? void 0 : _h.content) || resp.data.response || 'No response received';
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
            if (cell.kind === vscode.NotebookCellKind.Markup &&
                cell.document.getText().includes('**🤖Explanation**')) {
                const item = new vscode.NotebookCellStatusBarItem('💬 Ask follow-up question', vscode.NotebookCellStatusBarAlignment.Right);
                item.command = 'jupyterAiFeedback.askFollowUpFromButton';
                item.tooltip = 'Ask a follow-up question about this explanation';
                items.push(item);
            }
            return items;
        }
    }));
}
exports.activate = activate;
function deactivate() { }
exports.deactivate = deactivate;
//# sourceMappingURL=extension.js.map