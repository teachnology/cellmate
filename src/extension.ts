import * as vscode from 'vscode';
import * as fs from 'fs';
import { existsSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as cp from 'child_process';
import axios from 'axios';
import simpleGit, { SimpleGit } from 'simple-git';
import * as tmp from 'tmp';


//const GIT_REPO_URL = 'https://github.com/teachnology/promptfolio.git';
const GIT_REPO_URL = 'https://github.com/esemsc-hl524/promptfolio.git';
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

async function getPromptContent(promptId: string): Promise<string> {
  const promptPath = path.join(LOCAL_REPO_PATH, 'prompts', `${promptId}.txt`);
  if (!fs.existsSync(promptPath)) throw new Error(`Prompt file ${promptId}.txt not found`);
  return fs.readFileSync(promptPath, 'utf8');
}



export function activate(ctx: vscode.ExtensionContext) {
  const provider: vscode.NotebookCellStatusBarItemProvider = {
    provideCellStatusBarItems(cell) {
      const items: vscode.NotebookCellStatusBarItem[] = [];

      if (cell.document.languageId === 'python' && cell.kind === vscode.NotebookCellKind.Code) {
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

      const text = cell.document.getText().toLowerCase()
      if(cell.kind === vscode.NotebookCellKind.Markup &&
   (text.includes('**feedback**') || text.includes('**🤖feedback expansion**'))){
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

  // 2) 点击按钮后执行的命令
  ctx.subscriptions.push(
    vscode.commands.registerCommand(
      'jupyterAiFeedback.sendNotebookCell',
      async (cell: vscode.NotebookCell) => {
        const editor = vscode.window.activeNotebookEditor;
        if (!editor) {
          return vscode.window.showErrorMessage('没有活动的 Notebook 编辑器');
        }

        // 2.1 读取用户配置
        const cfg = vscode.workspace.getConfiguration('jupyterAiFeedback');
        const apiUrl = cfg.get<string>('apiUrl') || '';
        const apiKey = cfg.get<string>('apiKey') || '';
        const promptTpl = cfg.get<string>('promptTemplate') || '';
        if (!apiUrl || !apiKey || !promptTpl) {
          return vscode.window.showErrorMessage(
            '请先在设置中配置 jupyterAiFeedback.apiUrl、apiKey 和 promptTemplate'
          );
        }

        // 2.2 拿到 cell 里的代码并套入模板
        const code = cell.document.getText();
        const prompt = promptTpl.replace('{{code}}', code);
        const system_role = "You are a patient and detail-oriented Python teaching assistant. "
                            "Based on the analysis below, provide step-by-step, targeted feedback:\n"
                            "- Ask leading questions that guide the student toward discovering the solution, rather than giving full code.\n"
                            "- If helpful, recommend relevant learning resources or key concepts.\n"
        const body = {
        model: 'llama3',
        messages: [
            { role: 'system', content: system_role },
            { role: 'user',   content: prompt }
        ]
        };
        // 2.3 调用你的 LLM 接口
        let feedback: string;
        try {
          const resp = await axios.post(
            apiUrl,
            body,
            {
                headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`
                }
            }
          );
        //   feedback = resp.data.feedback;
        feedback = resp.data.choices[0].message.content;

        } catch (e: any) {
          return vscode.window.showErrorMessage('AI 接口调用失败：' + e.message);
        }

        // 2.4 插入一个空的 Markdown cell（调用内置命令）
        await vscode.commands.executeCommand('notebook.cell.insertMarkdownCellBelow');

        // 2.5 找到新插入的 cell（它在原 cell.index + 1）
        const newCell = editor.notebook.cellAt(cell.index + 1);
        const doc = newCell.document;

        // 2.6 用 WorkspaceEdit 替换这个 cell 的全部内容
        const lastLine = doc.lineCount > 0 ? doc.lineCount - 1 : 0;
        const fullRange = new vscode.Range(
          0,
          0,
          lastLine,
          doc.lineAt(lastLine).text.length
        );
        const content = `**AI Feedback**\n\n${feedback.replace(/\n/g, '  \n')}`;
        const edit = new vscode.WorkspaceEdit();
        edit.replace(doc.uri, fullRange, content);
        await vscode.workspace.applyEdit(edit);
      }
    )
  );

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
        if (!apiUrl || !apiKey || !mode) {
          return vscode.window.showErrorMessage(
            'Please set apiUrl, apiKey and feedbackMode in your settings'
          );
        }

        await syncGitRepo()
        const promptTpl = await getPromptContent(mode);

        const prompt = promptTpl.replace('{{content}}', content);
        const title = mode === 'Expand' ? 'Feedback Expansion' : 'Explanation';

        const body = {
          model : 'gemma3:27b',
          prompt: prompt,
          stream : true
        };

        // modify markdown cell
        let newCell: vscode.NotebookCell;
        const nextIndex = cell.index + 1;
        
        if (
          nextIndex < editor.notebook.cellCount &&
          editor.notebook.cellAt(nextIndex).kind === vscode.NotebookCellKind.Markup &&
          editor.notebook.cellAt(nextIndex).document.getText().startsWith(`**🤖${title}**`)
        ) {
          newCell = editor.notebook.cellAt(nextIndex);
        } else {
          await vscode.commands.executeCommand('notebook.cell.insertMarkdownCellBelow');
          newCell = editor.notebook.cellAt(cell.index + 1);
        }

        const doc = newCell.document;
        const initEdit = new vscode.WorkspaceEdit();
        const initRange = doc.lineCount === 0
          ? new vscode.Range(0,0,0,0)
          : new vscode.Range(0,0,doc.lineCount-1,doc.lineAt(doc.lineCount - 1).text.length);
        initEdit.replace(doc.uri, initRange, `**🤖${title} (Generating...)**\n\n`)
        await vscode.workspace.applyEdit(initEdit);

        // 
        try {
          const resp = await axios.post(apiUrl, body, {
            headers: {
              'content-Type' : 'application/json',
              Authorization: `Bearer ${apiKey}`
            },
            responseType: 'stream'
          });

          let accumulated = '';
          for await (const chunk of resp.data) {
            const line = chunk.toString().trim();
            const match = line.match(/\"response\":\"(.*?)\"/);
            if (match) {
              const delta = match[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
              accumulated += delta;
              const currentText = newCell.document.getText();
              const updated = `**🤖${title} (Generating...)**\n\n${accumulated.replace(/\n/g, '  \n')}`;
              const lastLine = doc.lineCount > 0 ? doc.lineCount - 1 : 0;
              const updateRange = new vscode.Range(0, 0, lastLine, doc.lineAt(lastLine).text.length);
              const edit = new vscode.WorkspaceEdit();
              edit.replace(doc.uri, updateRange,updated);
              await vscode.workspace.applyEdit(edit);
            }
          }

          // give a sign that it is finished generating
          const finalContent = `**🤖${title}**\n\n${accumulated.replace(/\n/g, '  \n')}\n\n**✅ AI Generation Completed**`;
          const finalLine = doc.lineCount > 0 ? doc.lineCount - 1 : 0;
          const finalRange = new vscode.Range(0, 0, finalLine, doc.lineAt(finalLine).text.length);
          const finalEdit = new vscode.WorkspaceEdit();
          finalEdit.replace(doc.uri, finalRange, finalContent);
          await vscode.workspace.applyEdit(finalEdit);

        } catch (e:any) {
          console.error("AI Extension fail:", e); 
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

      conversation.push({role:'assistant', content:explanation});

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

      panel.webview.onDidReceiveMessage(async (msg) => {
        if (msg.type === 'ask') {
          const question = msg.question;
          conversation.push({ role: 'user', content: question });

          const cfg = vscode.workspace.getConfiguration('jupyterAiFeedback');
          const apiUrl = cfg.get<string>('apiUrl') || '';
          const apiKey = cfg.get<string>('apiKey') || '';

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
          }
        }
      });
    })
  );

  ctx.subscriptions.push(
    vscode.notebooks.registerNotebookCellStatusBarItemProvider('jupyter-notebook', {
    provideCellStatusBarItems(cell, _token) {
      const items: vscode.NotebookCellStatusBarItem[] = [];

      if (
        cell.kind === vscode.NotebookCellKind.Markup &&
        cell.document.getText().includes('**🤖Explanation**')
      ) {
        const item = new vscode.NotebookCellStatusBarItem(
          '💬 Ask follow-up question',
          vscode.NotebookCellStatusBarAlignment.Right
        );
        item.command = 'jupyterAiFeedback.askFollowUpFromButton';
        item.tooltip = 'Ask a follow-up question about this explanation';
        items.push(item);
      }

      return items;
    }
  })
);


}





// Markdown cell
  
export function deactivate() {}
