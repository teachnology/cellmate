import * as vscode from 'vscode';
import * as fs from 'fs';
import { startFFmpegRecording, stopFFmpegRecording } from './ffmpegRecorder';
import { getProviderConfig } from './configParser';
import { sendAudioToApi } from './apiCaller';
import { ensureLocalServer } from './localServer';

let isRecording = false;

export async function toggleRecording(cell: vscode.NotebookCell) {
  if (!cell || cell.document.languageId !== 'markdown') {
    vscode.window.showWarningMessage('❗ Please select a markdown cell.');
    return;
  }

  if (!isRecording) {
    const cfg = getProviderConfig();
    if (cfg.provider === 'local') {
      const ok = await ensureLocalServer();
      if (!ok) return;
    }
    startFFmpegRecording();
    isRecording = true;
    return;
  }

  // Stop recording & process audio
  try {
    const audioPath = await stopFFmpegRecording();
    isRecording = false;

    const audioBuffer = fs.readFileSync(audioPath);
    const base64Audio = audioBuffer.toString('base64');

    const config = getProviderConfig();
    const text = await sendAudioToApi(base64Audio, config);

    // Insert text
    const editor = vscode.window.activeNotebookEditor;
    if (!editor) return;

    const doc = cell.document;
    const lastLine = doc.lineCount > 0 ? doc.lineCount - 1 : 0;
    const fullRange = new vscode.Range(0, 0, lastLine, doc.lineAt(lastLine).text.length);
    const trimmed = text.trim(); // Remove leading/trailing empty lines
    const newText = doc.getText().trimEnd() + '\n' + trimmed;

    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, fullRange, newText);
    await vscode.workspace.applyEdit(edit);

    vscode.window.showInformationMessage('✅ Transcription inserted!');
  } catch (err: any) {
    vscode.window.showErrorMessage(`❌ Failed to transcribe: ${err.message}`);
    isRecording = false;
  }
}