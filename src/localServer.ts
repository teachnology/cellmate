import { spawn, ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import extract from 'extract-zip';
import getPort from 'get-port';
import * as vscode from 'vscode';

let ctx: vscode.ExtensionContext | undefined;
export function setExtensionContext(c: vscode.ExtensionContext) {
  ctx = c;
}

export function getSttPort(): number {
  // If setExtensionContext hasn't been called yet, use default 5000
  if (!ctx) return 5000;
  // Get cached port, fallback to 5000 if not found
  return ctx.globalState.get<number>(STT_PORT_KEY) ?? 5000;
}

// 👉 Replace with your own direct link
const TINY_ZIP  = 'https://github.com/esemsc-zf1124/cellmate/releases/download/v1.0-tiny/whisper_srv_tiny.zip';

// —— Port will be dynamically assigned at runtime ——
let PORT = 5000;
let srv: ChildProcess | null = null;

// 🔑 Key for caching port (also used by apiCaller.ts)
export const STT_PORT_KEY = 'jaif.sttPort';

/* ---------- Common utilities ---------- */
const exists = async (p: string) => !!(await fs.stat(p).catch(() => undefined));
const portAlive = (p: number) =>
  fetch(`http://127.0.0.1:${p}/health`).then(r => r.ok).catch(() => false);

async function downloadAndExtract(url: string, dest: string) {
  console.log('[JAIF] Start downloading from:', url);
  await fs.mkdir(dest, { recursive: true });
  const zipTmp = path.join(dest, 'tmp.zip');
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  await fs.writeFile(zipTmp, buf);
  await extract(zipTmp, { dir: dest });
  await fs.rm(zipTmp);
}

function waitUntil(cond: () => Promise<boolean>, ms: number) {
  const t0 = Date.now();
  return new Promise<void>((ok, bad) => {
    (async function loop() {
      if (await cond()) return ok();
      if (Date.now() - t0 > ms) return bad();
      setTimeout(loop, 1000);
    })();
  });
}

/* ---------- Core functions ---------- */
export async function ensureLocalServer() {
  // 1. First read cached port
  if (!ctx) { throw new Error('Extension context not set'); }
  PORT = ctx.globalState.get(STT_PORT_KEY) ?? 5000;
  if (await portAlive(PORT)) return true;        // Already running

  // 2. If port is occupied, use getPort to find a free port between 5000-5100
  PORT = await getPort({ port: [5000, 5100] });

  // 3. Show dialog
  const choice = await vscode.window.showInformationMessage(
    'Local speech-to-text model is not installed.\n' +
    'The first-time download is ~240 MB and runs completely offline.',
    'Install & run the local model',
    'Use a cloud provider instead'
  );
  if (choice === 'Use a cloud provider instead') {
    vscode.commands.executeCommand(
      'workbench.action.openSettings',
      'jupyterAiFeedback.speech'
    );
    return false;          // Let button logic return early
  }
  if (choice !== 'Install & run the local model') return false;

  // 4. If model directory doesn't exist → download and extract
  const model = 'tiny'; // Define the model name to use
  const root = path.join(process.env.HOME || '', '.jaif', model);
  if (!(await exists(path.join(root, 'run_whisper_server.py')))) {
    const zip = TINY_ZIP; 
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Downloading tiny model…` },
      () => downloadAndExtract(zip, root)
    );
  }

  // 5. Start backend service
  const py = path.join(root, 'venv', 'bin', 'python');      // Linux/macOS; Windows should use Scripts
  srv = spawn(py, ['run_whisper_server.py', '--port', PORT.toString(), '--model', model], {
    cwd: root, stdio: 'ignore'
  });

  try {
    await waitUntil(() => portAlive(PORT), 20000);
    if (!ctx) { throw new Error('Extension context not set'); }
    await ctx.globalState.update(STT_PORT_KEY, PORT);       // Cache port
    vscode.window.showInformationMessage(`Local tiny model ready (port ${PORT}) ✓`);
    return true;
  } catch {
    vscode.window.showErrorMessage('❌ Failed to start local STT service');
    return false;
  }
}

export function killLocal() {
  srv?.kill();
}