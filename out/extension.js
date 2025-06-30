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
const axios_1 = __importDefault(require("axios"));
const marked_1 = require("marked");
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
            if (cell.kind === vscode.NotebookCellKind.Markup &&
                /\*\*feedback\*\*/i.test(cell.document.getText())) {
                const markdownItem = new vscode.NotebookCellStatusBarItem('📖 Explain', vscode.NotebookCellStatusBarAlignment.Right);
                markdownItem.command = {
                    command: 'jupyterAiFeedback.explainMarkdownCell',
                    title: 'Explain Feedback Markdown',
                    arguments: [cell]
                };
                markdownItem.priority = 100;
                markdownItem.tooltip = 'Use AI to explain the feedback';
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
        const apiUrl = cfg.get('apiUrl') || '';
        const apiKey = cfg.get('apiKey') || '';
        const promptTpl = cfg.get('promptTemplateMarkdown') || 'Explain the following content:\n\n{{content}}';
        if (!apiUrl || !apiKey || !promptTpl) {
            return vscode.window.showErrorMessage('Please set apiUrl, apiKey and promptTemplateMarkdown');
        }
        const prompt = promptTpl.replace('{{content}}', content);
        const body = {
            model: 'gemma3:27b',
            prompt: prompt,
            stream: true
        };
        // modify markdown cell
        let newCell;
        const nextIndex = cell.index + 1;
        if (nextIndex < editor.notebook.cellCount &&
            editor.notebook.cellAt(nextIndex).kind === vscode.NotebookCellKind.Markup &&
            editor.notebook.cellAt(nextIndex).document.getText().startsWith('**🤖Explanation**')) {
            newCell = editor.notebook.cellAt(nextIndex);
        }
        else {
            yield vscode.commands.executeCommand('notebook.cell.insertMarkdownCellBelow');
            newCell = editor.notebook.cellAt(cell.index + 1);
        }
        const doc = newCell.document;
        const initEdit = new vscode.WorkspaceEdit();
        const initRange = doc.lineCount === 0
            ? new vscode.Range(0, 0, 0, 0)
            : new vscode.Range(0, 0, doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length);
        initEdit.replace(doc.uri, initRange, '**🤖Explanation (Generating...)**\n\n');
        yield vscode.workspace.applyEdit(initEdit);
        // 
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
                        const match = line.match(/\"response\":\"(.*?)\"/);
                        if (match) {
                            const delta = match[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
                            accumulated += delta;
                            const currentText = newCell.document.getText();
                            const updated = `**🤖Explanation (Generating...)**\n\n${accumulated.replace(/\n/g, '  \n')}`;
                            const lastLine = doc.lineCount > 0 ? doc.lineCount - 1 : 0;
                            const updateRange = new vscode.Range(0, 0, lastLine, doc.lineAt(lastLine).text.length);
                            const edit = new vscode.WorkspaceEdit();
                            edit.replace(doc.uri, updateRange, updated);
                            yield vscode.workspace.applyEdit(edit);
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
            const finalContent = `**🤖Explanation**\n\n${accumulated.replace(/\n/g, '  \n')}\n\n**✅ AI Generation Completed**`;
            const finalLine = doc.lineCount > 0 ? doc.lineCount - 1 : 0;
            const finalRange = new vscode.Range(0, 0, finalLine, doc.lineAt(finalLine).text.length);
            const finalEdit = new vscode.WorkspaceEdit();
            finalEdit.replace(doc.uri, finalRange, finalContent);
            yield vscode.workspace.applyEdit(finalEdit);
        }
        catch (e) {
            console.error("AI Extension fail:", e);
            return vscode.window.showErrorMessage('Ai Extension fail:' + e.message);
        }
    })));
    // follow-up quesiton
    //   ctx.subscriptions.push(
    //     vscode.commands.registerCommand('jupyterAiFeedback.askFollowUpFromButton', async () => {
    //       console.log('[FollowUp] Link command triggered!');
    //       const editor = vscode.window.activeNotebookEditor;
    //       if (!editor) {
    //         return vscode.window.showErrorMessage('No active notebook editor');
    //       }
    //       const followUp = await vscode.window.showInputBox({
    //         prompt:  'Ask a follow-up question based on the explanation above',
    //         placeHolder: 'e.g., Can you clarify the last part?'
    //       });
    //       if (!followUp) {
    //         return;
    //       }
    //       // setting
    //       const cfg = vscode.workspace.getConfiguration('jupyterAiFeedback');
    //       const apiUrl = cfg.get<string>('apiUrl') || '';
    //       const apiKey = cfg.get<string>('apiKey') || '';
    //       const model = 'gemma3:27b';
    //       const body = {
    //         model,
    //         prompt: followUp,
    //         stream: false
    //       };
    //       let result = '';
    //       try {
    //         const resp = await axios.post(apiUrl, body, {
    //           headers: {
    //             'Content-Type': 'application/json',
    //             Authorization: `Bearer ${apiKey}`
    //           }
    //         });
    //         console.log('[FollowUp] Raw LLM Response:', resp.data);
    //         result = resp.data.message?.content || resp.data.response || 'No response received';
    //       } catch (e: any) {
    //       console.error("Follow-up AI extension fail:", e);
    //       return vscode.window.showErrorMessage('Follow-up AI failed: ' + e.message);
    //     }
    //       //show result in webview
    //       const panel = vscode.window.createWebviewPanel(
    //         'followUpAnswer',
    //         'Follow-up Answer',
    //         vscode.ViewColumn.One,
    //         {
    //           enableScripts:true
    //         }
    //       );
    //       panel.webview.html = getWebviewContent(followUp, result);
    //    })
    //   );
    ctx.subscriptions.push(vscode.commands.registerCommand('jupyterAiFeedback.askFollowUpFromButton', () => __awaiter(this, void 0, void 0, function* () {
        const editor = vscode.window.activeNotebookEditor;
        if (!editor) {
            return vscode.window.showErrorMessage('No active notebook editor');
        }
        const conversation = [];
        const panel = vscode.window.createWebviewPanel('followUpChat', 'Follow-up Chat', vscode.ViewColumn.One, { enableScripts: true });
        function getHTML(content) {
            return `<!DOCTYPE html>
      <html lang="en">
      <head><meta charset="UTF-8"><style>body{font-family:sans-serif;padding:1em;}textarea{width:100%;height:60px;}button{margin-top:10px;}</style></head>
      <body>
        <div id="chat">${content}</div>
        <textarea id="input" placeholder="Type your follow-up question..."></textarea>
        <button onclick="send()">Send</button>

        <script>
          const vscode = acquireVsCodeApi();
          function send() {
            const input = document.getElementById('input');
            vscode.postMessage({ type: 'ask', question: input.value });
            input.value = '';
          }
        </script>
      </body>
      </html>`;
        }
        panel.webview.html = getHTML('<p>💬 Ask a follow-up question...</p>');
        panel.webview.onDidReceiveMessage((msg) => __awaiter(this, void 0, void 0, function* () {
            var _h;
            if (msg.type === 'ask') {
                const question = msg.question;
                conversation.push({ role: 'user', content: question });
                const cfg = vscode.workspace.getConfiguration('jupyterAiFeedback');
                const apiUrl = cfg.get('apiUrl') || '';
                const apiKey = cfg.get('apiKey') || '';
                const fullPrompt = conversation.map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`).join('\n') + '\nAssistant:';
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
                    const chatHtml = conversation.map(msg => `<p><strong>${msg.role === 'user' ? '👤 You' : '🤖 AI'}:</strong> ${msg.content}</p>`).join('');
                    panel.webview.html = getHTML(chatHtml);
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
    //   ctx.subscriptions.push(
    //   vscode.commands.registerCommand('jupyterAiFeedback.explainActiveMarkdownCell', async () => {
    //     const editor = vscode.window.activeNotebookEditor;
    //     if (!editor) {
    //       return vscode.window.showErrorMessage('No active notebook editor');
    //     }
    //     const activeCell = editor.selections?.[0];
    //     if (!activeCell) {
    //       return vscode.window.showErrorMessage('No selected cell');
    //     }
    //     const cell = editor.notebook.cellAt(activeCell.start);
    //     if (cell.kind !== vscode.NotebookCellKind.Markup) {
    //       return vscode.window.showWarningMessage('Current cell is not a markdown cell.');
    //     }
    //     const content = cell.document.getText().toLowerCase();
    //     if (!content.includes('feedback')) {
    //       return vscode.window.showWarningMessage('This markdown cell does not appear to contain feedback.');
    //     }
    //     const cfg = vscode.workspace.getConfiguration('jupyterAiFeedback');
    //     const apiUrl = cfg.get<string>('apiUrl') || '';
    //     const apiKey = cfg.get<string>('apiKey') || '';
    //     const promptTpl = cfg.get<string>('promptTemplateMarkdown') || 'Explain the following content:\n\n{{content}}';
    //     if (!apiUrl || !apiKey || !promptTpl) {
    //       return vscode.window.showErrorMessage('Please set apiUrl, apiKey and promptTemplateMarkdown');
    //     }
    //     const prompt = promptTpl.replace('{{content}}', content);
    //     const body = {
    //       model: 'gemma3:27b',
    //       messages: [{ role: 'user', content: prompt }]
    //     };
    //     let result;
    //     try {
    //       const resp = await axios.post(apiUrl, body, {
    //         headers: {
    //           'content-Type': 'application/json',
    //           Authorization: `Bearer ${apiKey}`
    //         }
    //       });
    //       result = resp.data.choices[0].message.content;
    //     } catch (e: any) {
    //       return vscode.window.showErrorMessage('AI explain failed: ' + e.message);
    //     }
    //     await vscode.commands.executeCommand('notebook.cell.insertMarkdownCellBelow');
    //     const newCell = editor.notebook.cellAt(cell.index + 1);
    //     const doc = newCell.document;
    //     const lastLine = doc.lineCount > 0 ? doc.lineCount - 1 : 0;
    //     const fullRange = new vscode.Range(0, 0, lastLine, doc.lineAt(lastLine).text.length);
    //     const contentToInsert = `**AI Explanation**\n\n${result.replace(/\n/g, '  \n')}`;
    //     const edit = new vscode.WorkspaceEdit();
    //     edit.replace(doc.uri, fullRange, contentToInsert);
    //     await vscode.workspace.applyEdit(edit);
    //   })
    // );
}
exports.activate = activate;
function getWebviewContent(question, answer) {
    const htmlAnswer = (0, marked_1.marked)(answer); // ✅ 把 markdown 转成 HTML
    return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <style>
        body { font-family: sans-serif; padding: 20px; }
        .question { font-weight: bold; margin-bottom: 1em; }
        .answer { color: #333; }
        h2, h3, h4 { color: #007acc; }
        ul { margin-left: 1.5em; }
        code { background: #eee; padding: 2px 4px; border-radius: 4px; }
      </style>
    </head>
    <body>
      <h2>💬 Follow-up Answer</h2>
      <div class="question">Q: ${question}</div>
      <div class="answer">A:${htmlAnswer}</div>
    </body>
    </html>
  `;
}
// Markdown cell
function deactivate() { }
exports.deactivate = deactivate;
//# sourceMappingURL=extension.js.map