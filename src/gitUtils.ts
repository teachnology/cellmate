import * as fs from 'fs';
import { existsSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import simpleGit, { SimpleGit } from 'simple-git';

// Git repository configuration
export const GIT_REPO_URL = 'https://github.com/teachnology/promptfolio.git';
// export const GIT_REPO_URL = 'https://github.com/esemsc-hz2024/promptfolio.git';
// export const GIT_REPO_URL = 'https://github.com/esemsc-sg524/leveled_prompt.git';
export const LOCAL_REPO_PATH = path.join(os.tmpdir(), 'promptfolio_repo');

/**
 * Check if a directory is a valid git repository
 */
export async function isValidRepo(dir: string): Promise<boolean> {
  const git: SimpleGit = simpleGit(dir);
  try {
    await git.revparse(['--is-inside-work-tree']);
    return true;                      // normal git package
  } catch {
    return false;                     // rev-parse fail => not valid
  }
}

/**
 * Sync the git repository - clone if not exists, pull if exists
 */
export async function syncGitRepo(): Promise<void> {
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

/**
 * Get prompt content from the local repository
 */
export async function getPromptContent(promptId: string): Promise<string> {
  const promptPath = path.join(LOCAL_REPO_PATH, 'prompts', `${promptId}.txt`);
  if (!fs.existsSync(promptPath)) throw new Error(`Prompt file ${promptId}.txt not found`);
  return fs.readFileSync(promptPath, 'utf8');
}

/**
 * Get test files from the local repository
 */
export async function getTestFiles(exerciseId: string): Promise<{ test: string, metadata: any }> {
  const testDir = path.join(LOCAL_REPO_PATH, 'tests', exerciseId);
  const testFile = fs.readdirSync(testDir).find(f => f.startsWith('test_') && f.endsWith('.py'));
  const metadataFile = path.join(testDir, 'metadata.json');
  if (!testFile || !fs.existsSync(metadataFile)) throw new Error('Test or metadata not found');
  return {
    test: fs.readFileSync(path.join(testDir, testFile), 'utf8'),
    metadata: JSON.parse(fs.readFileSync(metadataFile, 'utf8'))
  };
}

/**
 * List all available exercises from the local repository
 */
export async function listLocalExercises(): Promise<any[]> {
  const exercisesDir = path.join(LOCAL_REPO_PATH, 'tests');
  if (!fs.existsSync(exercisesDir)) return [];
  
  return fs.readdirSync(exercisesDir, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => ({ id: dirent.name, name: dirent.name }));
}

/**
 * List all available templates from the local repository
 */
export async function listLocalTemplates(): Promise<any[]> {
  const promptsDir = path.join(LOCAL_REPO_PATH, 'prompts');
  if (!fs.existsSync(promptsDir)) return [];
  
  return fs.readdirSync(promptsDir)
    .filter(file => file.endsWith('.txt'))
    .map(file => ({ 
      id: file.replace('.txt', ''), 
      filename: file 
    }));
} 