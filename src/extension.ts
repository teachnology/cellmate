console.log('[Jupyter-AI-Feedback] extension.js loaded');
import * as vscode from 'vscode';
import axios from 'axios';
import { toggleRecording } from './speech';
import { killLocal } from './localServer';
import { setExtensionContext } from './localServer'

let recording = false;

export function activate(ctx: vscode.ExtensionContext) {
  setExtensionContext(ctx);
  const provider: vscode.NotebookCellStatusBarItemProvider = {
    provideCellStatusBarItems(cell) {
      const items: vscode.NotebookCellStatusBarItem[] = [];

      if (cell.document.languageId === 'python') {
        const aiItem = new vscode.NotebookCellStatusBarItem(
          '$(zap) 🧠 AI Feedback',
          vscode.NotebookCellStatusBarAlignment.Right
        );
        aiItem.priority = 100;
        aiItem.command = {
          command: 'jupyterAiFeedback.sendNotebookCell',
          title: 'Send to AI',
          arguments: [cell]
        };
        items.push(aiItem);
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

      return items;
    }
  };

  ctx.subscriptions.push(
    vscode.notebooks.registerNotebookCellStatusBarItemProvider('*', provider)
  );

  // AI Feedback logic
  ctx.subscriptions.push(
    vscode.commands.registerCommand(
      'jupyterAiFeedback.sendNotebookCell',
      async (cell: vscode.NotebookCell) => {
        const editor = vscode.window.activeNotebookEditor;
        if (!editor) {
          return vscode.window.showErrorMessage('No active Notebook editor');
        }

        const cfg = vscode.workspace.getConfiguration('jupyterAiFeedback');
        const apiUrl = cfg.get<string>('apiUrl') || '';
        const apiKey = cfg.get<string>('apiKey') || '';
        const promptTpl = cfg.get<string>('promptTemplate') || '';
        if (!apiUrl || !apiKey || !promptTpl) {
          return vscode.window.showErrorMessage('Please configure apiUrl, apiKey, and promptTemplate first');
        }

        const code = cell.document.getText();
        const prompt = promptTpl.replace('{{code}}', code);
        const system_role = "You are a patient and detail-oriented Python teaching assistant. "
          + "Based on the analysis below, provide step-by-step, targeted feedback:\n"
          + "- Ask leading questions that guide the student toward discovering the solution, rather than giving full code.\n"
          + "- If helpful, recommend relevant learning resources or key concepts.\n";

        const body = {
          model: 'llama3.2',
          stream: false, 
          messages: [
            { role: 'system', content: system_role },
            { role: 'user', content: prompt }
          ]
        };

        let feedback: string;
        try {
          const resp = await axios.post(apiUrl, body, {
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }
          });
          //feedback = resp.data.choices[0].message.content;
          feedback = resp.data.message.content;
        } catch (e: any) {
          return vscode.window.showErrorMessage('AI request failed: ' + e.message);
        }

        await vscode.commands.executeCommand('notebook.cell.insertMarkdownCellBelow');
        const newCell = editor.notebook.cellAt(cell.index + 1);
        const doc = newCell.document;
        const lastLine = doc.lineCount > 0 ? doc.lineCount - 1 : 0;
        const fullRange = new vscode.Range(0, 0, lastLine, doc.lineAt(lastLine).text.length);
        const content = `**AI Feedback**\n\n${feedback.replace(/\n/g, '  \n')}`;
        const edit = new vscode.WorkspaceEdit();
        edit.replace(doc.uri, fullRange, content);
        await vscode.workspace.applyEdit(edit);
      }
    )
  );

  // Speech-to-Text logic
  ctx.subscriptions.push(
    vscode.commands.registerCommand('jupyterAiFeedback.toggleRecording', async (cell: vscode.NotebookCell) => {
      await toggleRecording(cell); 
    })
  );

}

export function deactivate() { killLocal(); }