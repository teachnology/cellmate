import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as tmp from 'tmp';
import * as os from 'os';

/**
 * Get the Python path from the active notebook's kernel
 */
export async function getNotebookPythonPath(): Promise<string | undefined> {
  const editor = vscode.window.activeNotebookEditor;
  if (!editor) {
    return;
  }

  // activate Python extension API
  const pyExt = vscode.extensions.getExtension('ms-python.python');
  if (!pyExt) {
    return;
  }
  await pyExt.activate();
  const pyApi = pyExt.exports;

  // API file: https://github.com/microsoft/vscode-python/blob/main/src/api.ts
  const execCmd = pyApi.settings.getExecutionDetails(editor.notebook.uri).execCommand;
  return execCmd?.[0]; // execCmd [ '/Users/xxx/miniconda3/envs/py39/bin/python', ... ]
}

/**
 * Check if a Python package is installed
 */
export function checkPytestInstalled(pythonPath: string, pkg: string): Promise<boolean> {
  return new Promise((resolve) => {
    cp.execFile(pythonPath, ['-m', 'pip', 'show', pkg], (err, stdout) => {
      resolve(!!stdout && !err && stdout.includes(`Name: ${pkg}`));
    });
  });
}

/**
 * Auto install Python dependencies
 */
export function ensurePythonDeps(pythonPath: string, pkgs: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    cp.execFile(pythonPath, ['-m', 'pip', 'install', ...pkgs], (err, stdout, stderr) => {
      if (err) {
        vscode.window.showErrorMessage(`install dependencies failed: ${stderr || err.message}`);
        resolve(false);
      } else {
        vscode.window.showInformationMessage(`installed: ${pkgs.join(', ')}`);
        resolve(true);
      }
    });
  });
}

/**
 * Create or get a virtual environment with system-site-packages and install dependencies
 */
export async function prepareVenv(basePython: string): Promise<string | null> {
  const isWindows = process.platform === 'win32';
  const venvDir = path.join(os.tmpdir(), 'cellmate_venv');
  const venvPython = isWindows ? path.join(venvDir, 'Scripts', 'python.exe') : path.join(venvDir, 'bin', 'python');
  const venvPip = isWindows ? path.join(venvDir, 'Scripts', 'pip.exe') : path.join(venvDir, 'bin', 'pip');

  return new Promise((resolve) => {
    // Check if venv exists and pytest is installed
    if (fs.existsSync(venvPython)) {
      cp.execFile(venvPython, ['-m', 'pytest', '--version'], (err) => {
        if (!err) {
          resolve(venvPython);
        } else {
          // Exists but pytest is broken/missing, reinstall
          installDeps();
        }
      });
    } else {
      // Create venv
      vscode.window.showInformationMessage('Cellmate: Creating test virtual environment... (first time only)');
      cp.execFile(basePython, ['-m', 'venv', '--system-site-packages', venvDir], (err, stdout, stderr) => {
        if (err) {
          vscode.window.showErrorMessage(`Failed to create virtual environment: ${stderr || err.message}`);
          resolve(null);
        } else {
          installDeps();
        }
      });
    }

    function installDeps() {
      const pkgs = ['pytest', 'pytest-json-report'];
      // Use "python -m pip" instead of calling the pip binary directly,
      // because some environments (e.g., macOS system Python) create venvs
      // without a standalone pip executable in bin/
      cp.execFile(venvPython, ['-m', 'pip', 'install', ...pkgs], (err, stdout, stderr) => {
        if (err) {
          vscode.window.showErrorMessage(`Cellmate: install dependencies failed in venv: ${stderr || err.message}`);
          resolve(null);
        } else {
          resolve(venvPython);
        }
      });
    }
  });
}

/**
 * Run local tests using pytest
 */
export async function runLocalTest(
  code: string,
  test: string,
  pythonPath: string,
  timeoutMs: number = 15000,
  resourceDirs?: string[]
): Promise<any> {
  // Create temporary directory
  const tmpDir = tmp.dirSync({ unsafeCleanup: true });
  const codePath = path.join(tmpDir.name, 'submission.py');
  const testPath = path.join(tmpDir.name, 'test_hidden.py');
  const reportPath = path.join(tmpDir.name, 'report.json');

  // Write user code and test code
  fs.writeFileSync(codePath, code, 'utf8');
  fs.writeFileSync(testPath, test, 'utf8');

  // If there are resource directories (e.g., data/), copy them into tmpDir
  if (Array.isArray(resourceDirs) && resourceDirs.length > 0) {
    const copyDirectoryRecursive = (srcDir: string, destDir: string) => {
      if (!fs.existsSync(srcDir)) return;
      fs.mkdirSync(destDir, { recursive: true });
      const entries = fs.readdirSync(srcDir, { withFileTypes: true });
      for (const entry of entries) {
        const srcPath = path.join(srcDir, entry.name);
        const destPath = path.join(destDir, entry.name);
        if (entry.isDirectory()) {
          copyDirectoryRecursive(srcPath, destPath);
        } else if (entry.isFile()) {
          fs.copyFileSync(srcPath, destPath);
        }
      }
    };
    try {
      for (const dir of resourceDirs) {
        if (!dir) continue;
        const baseName = path.basename(dir);
        const dest = path.join(tmpDir.name, baseName);
        copyDirectoryRecursive(dir, dest);
      }
    } catch (e:any) {
      vscode.window.showWarningMessage(`Failed to copy resource directories: ${e?.message || e}`);
    }
  }

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
    let timedOut = false;
    let finished = false;

    // Timeout to prevent infinite loops in user code from hanging
    const timer = setTimeout(() => {
      if (finished) return;
      timedOut = true;
      stderr += `\n[Timeout] Test execution exceeded ${timeoutMs} ms and was terminated.`;
      try {
        if (process.platform === 'win32' && typeof proc.pid === 'number') {
          // Terminate the entire process tree on Windows
          cp.exec(`taskkill /PID ${proc.pid} /T /F`);
        } else {
          proc.kill('SIGKILL');
        }
      } catch {
        // ignore
      }
    }, timeoutMs);

    proc.stdout.on('data', (data) => stdout += data.toString());
    proc.stderr.on('data', (data) => stderr += data.toString());

    proc.on('close', () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      let report = {};
      if (fs.existsSync(reportPath)) {
        report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      }
      tmpDir.removeCallback();
      resolve({ stdout, stderr, report, timeout: timedOut });
    });
  });
}

/**
 * Extract error message from test result
 */
export function extractErrorMessage(test: any): string {
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
  } else if (longrepr && typeof longrepr === 'object') {
    const msg = longrepr.longrepr || longrepr.reprcrash?.message || '';
    if (msg) return msg.trim();
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
  const testName = test.nodeid?.split('::').pop() || 'Unknown Test';
  const outcome = test.outcome || 'failed';
  return `${testName} ${outcome}`;
}

/**
 * Extract test input from assertion message
 */
export function extractTestInput(assertionMsg: string): string {
  // Match func(args) format, supporting multiple parameters, negative numbers, floats, strings, lists, etc.
  const m = assertionMsg.match(/([a-zA-Z_][a-zA-Z0-9_]*)\(([^\)]*)\)/);
  if (m) return `${m[1]}(${m[2]})`;
  return '';
}

/**
 * Generate improvement suggestions from failed tests and metadata
 */
export function generateSuggestions(failedTests: any[], metadata: any): string[] {
  const suggestions = new Set<string>();

  // Add hints from metadata
  const hints = metadata?.hints || [];
  hints.slice(0, 3).forEach((hint: string) => suggestions.add(hint));

  return Array.from(suggestions);
}

/**
 * Extract the most readable assertion line from pytest-json-report's longrepr/message
 *   - If reprcrash.message exists ⇒ use it (pytest's concise line)
 *   - Otherwise, scan all lines in longrepr:
 *        Prefer the line containing 'AssertionError' or 'assert'
 *   - If not found, fallback to the first line
 */
export function extractAssertionLine(test: any): string {
  const longreprObj = test.call?.longrepr ?? test.longrepr ?? '';

  // ---- case 1: longrepr is an object (pytest-json-report >= 3) ----
  if (typeof longreprObj === 'object' && longreprObj) {
    const msg = longreprObj.reprcrash?.message;
    if (msg) return msg.trim();

    const lrText: string = longreprObj.longrepr ?? '';
    const runtime = lrText.split('\n').find(l => /AssertionError:/i.test(l));
    if (runtime) return runtime.trim();

    const src = lrText.split('\n').find(l => /\bassert\b/.test(l));
    return (src ?? lrText.split('\n')[0] ?? '').trim();
  }

  // ---- case 2: longrepr is a string ----
  const lines = (longreprObj as string).split('\n');
  const runtime = lines.find(l => /AssertionError:/i.test(l));
  if (runtime) return runtime.trim();

  const src = lines.find(l => /\bassert\b/.test(l));
  return (src ?? lines[0] ?? '').trim();
}

/**
 * Generate concise test summary from test results
 */
export function generateConciseTestSummary(failedTests: any[], totalTests: number): string {
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
    if (testCases.length === 3) break;
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