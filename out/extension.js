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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deactivate = exports.activate = void 0;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const cp = __importStar(require("child_process"));
const axios_1 = __importDefault(require("axios"));
const simple_git_1 = __importDefault(require("simple-git"));
const tmp = __importStar(require("tmp"));
const GIT_REPO_URL = 'https://github.com/teachnology/promptfolio.git';
const LOCAL_REPO_PATH = path.join(os.tmpdir(), 'promptfolio_repo');
function syncGitRepo() {
    return __awaiter(this, void 0, void 0, function* () {
        const git = (0, simple_git_1.default)();
        if (!fs.existsSync(LOCAL_REPO_PATH)) {
            yield git.clone(GIT_REPO_URL, LOCAL_REPO_PATH);
        }
        else {
            yield git.cwd(LOCAL_REPO_PATH).pull();
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
function runLocalTest(code, test) {
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
            const python = process.platform === 'win32' ? 'python' : 'python3';
            const cmd = [
                python, '-m', 'pytest', testPath,
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
// Helper function: Extract expected value
function extractExpectedValue(errorMessage) {
    const patterns = [
        /should return (\d+)/i,
        /expected (\d+)/i,
        /assert \d+ == (\d+)/i,
        /Expected:\s*(\d+)/i,
        /expected\s+([^,\n]+)/i,
        /should be\s+([^,\n]+)/i, // "should be True"
    ];
    for (const pattern of patterns) {
        const match = errorMessage.match(pattern);
        if (match) {
            return match[1].trim();
        }
    }
    return '';
}
// Helper function: Extract actual value
function extractActualValue(errorMessage) {
    const patterns = [
        /but got (\d+)/i,
        /got (\d+)/i,
        /assert (\d+) == \d+/i,
        /Actual:\s*(\d+)/i,
        /got\s+([^,\n]+)/i,
        /returned\s+([^,\n]+)/i, // "returned False"
    ];
    for (const pattern of patterns) {
        const match = errorMessage.match(pattern);
        if (match) {
            return match[1].trim();
        }
    }
    return '';
}
// Helper function: Generate improvement suggestions
function generateSuggestions(failedTests, metadata) {
    const suggestions = new Set();
    for (const test of failedTests) {
        const errorMessage = extractErrorMessage(test);
        if (errorMessage.includes('NotImplementedError')) {
            suggestions.add('Please ensure the required function is defined');
        }
        else if (errorMessage.includes('TypeError')) {
            suggestions.add('Please check function parameter types and count');
        }
        else if (errorMessage.includes('RecursionError')) {
            suggestions.add('Recursion depth too large, consider using iteration');
        }
        else if (errorMessage.includes('AssertionError')) {
            suggestions.add('Please check if the function return value is correct');
        }
        else if (errorMessage.includes('NameError')) {
            suggestions.add('Please check if the function name is correct');
        }
        else if (errorMessage.includes('IndentationError')) {
            suggestions.add('Please check if the code indentation is correct');
        }
        else if (errorMessage.includes('SyntaxError')) {
            suggestions.add('Please check if the code syntax is correct');
        }
        else if (errorMessage.toLowerCase().includes('timeout')) {
            suggestions.add('Code execution timeout, possible infinite loop');
        }
    }
    // Add hints from metadata
    const hints = (metadata === null || metadata === void 0 ? void 0 : metadata.hints) || [];
    hints.slice(0, 2).forEach((hint) => suggestions.add(hint));
    return Array.from(suggestions);
}
function extractExerciseId(code) {
    const m = code.match(/^\s*#\s*EXERCISE_ID\s*:\s*([A-Za-z0-9_\-]+)/m);
    return m ? m[1] : null;
}
function activate(ctx) {
    const provider = {
        provideCellStatusBarItems(cell) {
            if (cell.document.languageId !== 'python') {
                return [];
            }
            const item = new vscode.NotebookCellStatusBarItem('$(zap) 🧠 AI Feedback', vscode.NotebookCellStatusBarAlignment.Right);
            item.priority = 100;
            item.command = {
                command: 'jupyterAiFeedback.sendNotebookCell',
                title: 'Send to AI',
                arguments: [cell]
            };
            return [item];
        }
    };
    ctx.subscriptions.push(vscode.notebooks.registerNotebookCellStatusBarItemProvider('*', provider));
    // Command executed when button is clicked
    ctx.subscriptions.push(vscode.commands.registerCommand('jupyterAiFeedback.sendNotebookCell', (cell) => __awaiter(this, void 0, void 0, function* () {
        var _a;
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
        console.log('templateId:', templateId);
        if (!apiUrl || !apiKey || !modelName) {
            return vscode.window.showErrorMessage('Please configure jupyterAiFeedback.apiUrl, apiKey, and modelName in settings');
        }
        const workspaceRoot = ((_a = vscode.workspace.workspaceFolders) === null || _a === void 0 ? void 0 : _a[0].uri.fsPath) || '';
        // Get code from cell
        const code = cell.document.getText();
        // 1. Sync GitHub repository
        yield syncGitRepo();
        // 2. Get prompt content
        const promptContent = yield getPromptContent(templateId);
        // 3. Get test content
        const exId = extractExerciseId(code);
        if (!exId) {
            vscode.window.showWarningMessage('No # EXERCISE_ID found in code');
            return;
        }
        const { test, metadata } = yield getTestFiles(exId);
        // 4. Run tests locally
        const testResult = yield runLocalTest(code, test);
        // 5. Parse test results and generate analysis
        let analysis = '';
        if (testResult.report && testResult.report.tests) {
            const total = testResult.report.tests.length;
            const passed = testResult.report.tests.filter((t) => t.outcome === 'passed').length;
            const failed = total - passed;
            analysis += `## Test Results Overview\n`;
            analysis += `- **Total Tests:** ${total}\n`;
            analysis += `- **Passed:** ${passed} ✅\n`;
            analysis += `- **Failed:** ${failed} ❌\n`;
            analysis += `- **Success Rate:** ${Math.round((passed / total) * 100)}%\n\n`;
            if (failed > 0) {
                analysis += `## Failed Test Details\n\n`;
                const failedTests = testResult.report.tests.filter((t) => t.outcome === 'failed');
                failedTests.forEach((test, index) => {
                    const testName = test.nodeid.split('::').pop() || 'Unknown Test';
                    const errorMessage = extractErrorMessage(test);
                    const expectedValue = extractExpectedValue(errorMessage);
                    const actualValue = extractActualValue(errorMessage);
                    analysis += `### ${index + 1}. ${testName}\n`;
                    analysis += `**Error Message:** ${errorMessage}\n`;
                    if (expectedValue)
                        analysis += `**Expected:** ${expectedValue}\n`;
                    if (actualValue)
                        analysis += `**Actual:** ${actualValue}\n`;
                    analysis += `\n`;
                });
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
        // 6. Assemble prompt
        console.log("promptContent:", promptContent);
        console.log("analysis:", analysis);
        let prompt = promptContent.replace('{{code}}', code) + `\n\n# Hidden Test Results\n\`\`\`\n${analysis}\n\`\`\``;
        console.log("prompt:", prompt);
        const system_role = "You are a patient and detail-oriented Python teaching assistant. ";
        "Based on the analysis below, provide step-by-step, targeted feedback:\n";
        "- Ask leading questions that guide the student toward discovering the solution, rather than giving full code.\n";
        "- If helpful, recommend relevant learning resources or key concepts.\n";
        const body = {
            model: modelName,
            messages: [
                { role: 'system', content: system_role },
                { role: 'user', content: prompt }
            ]
        };
        // Call the LLM interface
        let feedback;
        try {
            const resp = yield axios_1.default.post(apiUrl, body, {
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`
                }
            });
            feedback = resp.data.choices[0].message.content;
        }
        catch (e) {
            return vscode.window.showErrorMessage('AI API call failed: ' + e.message);
        }
        // Insert an empty Markdown cell
        yield vscode.commands.executeCommand('notebook.cell.insertMarkdownCellBelow');
        // Find the newly inserted cell
        const newCell = editor.notebook.cellAt(cell.index + 1);
        const doc = newCell.document;
        // Replace the cell content with WorkspaceEdit
        const lastLine = doc.lineCount > 0 ? doc.lineCount - 1 : 0;
        const fullRange = new vscode.Range(0, 0, lastLine, doc.lineAt(lastLine).text.length);
        const content = `**AI Feedback**\n\n${feedback.replace(/\n/g, '  \n')}`;
        const edit = new vscode.WorkspaceEdit();
        edit.replace(doc.uri, fullRange, content);
        yield vscode.workspace.applyEdit(edit);
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
}
exports.activate = activate;
function deactivate() { }
exports.deactivate = deactivate;
//# sourceMappingURL=extension.js.map