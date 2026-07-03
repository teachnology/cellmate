import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import axios from 'axios';

const RAG_CACHE_DIR = path.join(os.tmpdir(), 'cellmate_rag');
const RAG_INDEX_FILE = path.join(RAG_CACHE_DIR, 'index.json');

// English stopwords to filter out during tokenization
const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
  'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
  'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
  'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each',
  'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
  'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
  'just', 'because', 'but', 'and', 'or', 'if', 'while', 'about', 'up',
  'that', 'this', 'it', 'its', 'i', 'me', 'my', 'we', 'our', 'you',
  'your', 'he', 'him', 'his', 'she', 'her', 'they', 'them', 'their',
  'what', 'which', 'who', 'whom', 'these', 'those',
]);

/**
 * A single chunk of knowledge content
 */
export interface RagChunk {
  id: string;          // hash-based unique ID
  source: string;      // relative path, e.g., "lectures/week2_loops.md"
  title: string;       // heading or filename
  content: string;     // chunk text
  tokens: string[];    // lowercased, deduplicated keyword tokens
  embedding?: number[];// dense vector from embedding API (semantic mode)
}

/**
 * Tokenize text into lowercase keywords, filtering out stopwords and short tokens
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter(t => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * Generate a short hash ID for a chunk
 */
function hashId(source: string, title: string): string {
  return crypto.createHash('md5').update(source + '::' + title).digest('hex').slice(0, 12);
}

/**
 * Chunk a Markdown file by ## headings.
 * If a section exceeds maxWords, split further on double newlines.
 */
function chunkMarkdown(content: string, source: string, maxWords: number = 500): RagChunk[] {
  const chunks: RagChunk[] = [];
  // Split on ## headings, keeping the heading with its section
  const sections = content.split(/^(?=## )/m);

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;

    // Extract title from heading line, or use filename
    const headingMatch = trimmed.match(/^##\s+(.+)$/m);
    const title = headingMatch ? headingMatch[1].trim() : path.basename(source);

    const words = trimmed.split(/\s+/);
    if (words.length <= maxWords) {
      const tokens = [...new Set(tokenize(trimmed))];
      chunks.push({
        id: hashId(source, title),
        source,
        title,
        content: trimmed,
        tokens,
      });
    } else {
      // Split large sections on double newlines
      const paragraphs = trimmed.split(/\n\n+/);
      let buffer = '';
      let partIdx = 0;
      for (const para of paragraphs) {
        if (buffer && (buffer + '\n\n' + para).split(/\s+/).length > maxWords) {
          const subTitle = `${title} (part ${partIdx + 1})`;
          const tokens = [...new Set(tokenize(buffer))];
          chunks.push({
            id: hashId(source, subTitle),
            source,
            title: subTitle,
            content: buffer.trim(),
            tokens,
          });
          buffer = para;
          partIdx++;
        } else {
          buffer = buffer ? buffer + '\n\n' + para : para;
        }
      }
      if (buffer.trim()) {
        const subTitle = partIdx > 0 ? `${title} (part ${partIdx + 1})` : title;
        const tokens = [...new Set(tokenize(buffer))];
        chunks.push({
          id: hashId(source, subTitle),
          source,
          title: subTitle,
          content: buffer.trim(),
          tokens,
        });
      }
    }
  }

  return chunks;
}

/**
 * Chunk a Python file by top-level def/class blocks
 */
function chunkPython(content: string, source: string): RagChunk[] {
  const chunks: RagChunk[] = [];
  // Split on top-level function/class definitions (lines starting at column 0)
  const blocks = content.split(/^(?=(?:def |class ))/m);

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    // Extract function/class name as title
    const nameMatch = trimmed.match(/^(?:def|class)\s+(\w+)/);
    const title = nameMatch ? nameMatch[1] : path.basename(source);

    const tokens = [...new Set(tokenize(trimmed))];
    chunks.push({
      id: hashId(source, title),
      source,
      title,
      content: trimmed,
      tokens,
    });
  }

  // If no def/class found, treat entire file as one chunk
  if (chunks.length === 0 && content.trim()) {
    const title = path.basename(source);
    const tokens = [...new Set(tokenize(content))];
    chunks.push({
      id: hashId(source, title),
      source,
      title,
      content: content.trim(),
      tokens,
    });
  }

  return chunks;
}

/**
 * Parse a Jupyter Notebook (.ipynb) file and chunk its cells.
 * Markdown cells are chunked using the markdown chunker.
 * Code cells are chunked using the Python chunker.
 */
function chunkNotebook(content: string, source: string): RagChunk[] {
  const chunks: RagChunk[] = [];

  let notebook: any;
  try {
    notebook = JSON.parse(content);
  } catch {
    // If JSON parsing fails, skip this file
    return chunks;
  }

  if (!notebook.cells || !Array.isArray(notebook.cells)) return chunks;

  // Accumulate consecutive markdown cells into sections for better chunking
  let mdBuffer = '';
  let mdStartIdx = -1;

  function flushMarkdown() {
    if (mdBuffer.trim()) {
      const sectionSource = `${source} [cells ${mdStartIdx}+]`;
      chunks.push(...chunkMarkdown(mdBuffer, sectionSource));
    }
    mdBuffer = '';
    mdStartIdx = -1;
  }

  for (let i = 0; i < notebook.cells.length; i++) {
    const cell = notebook.cells[i];
    // Cell source can be a string or an array of strings
    const cellSource = Array.isArray(cell.source) ? cell.source.join('') : (cell.source || '');
    if (!cellSource.trim()) continue;

    if (cell.cell_type === 'markdown') {
      if (mdStartIdx < 0) mdStartIdx = i;
      mdBuffer += cellSource + '\n\n';
    } else if (cell.cell_type === 'code') {
      // Flush any accumulated markdown before processing code
      flushMarkdown();
      const codeSource = `${source} [cell ${i}]`;
      chunks.push(...chunkPython(cellSource, codeSource));
    }
  }

  // Flush remaining markdown
  flushMarkdown();

  return chunks;
}

/**
 * Recursively collect all files from a directory with given extensions
 */
function collectFiles(dir: string, extensions: string[]): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(fullPath, extensions));
    } else if (extensions.some(ext => entry.name.endsWith(ext))) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Build the RAG index from the knowledge/ directory in the synced repo.
 * Chunks .md files by heading and .py files by function/class definitions.
 * Caches the index as JSON in the temp directory.
 */
export async function buildRagIndex(repoPath: string): Promise<RagChunk[]> {
  const knowledgeDir = path.join(repoPath, 'knowledge');
  if (!fs.existsSync(knowledgeDir)) return [];

  const files = collectFiles(knowledgeDir, ['.md', '.py', '.txt', '.ipynb']);
  const allChunks: RagChunk[] = [];

  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf8');
    const relativePath = path.relative(knowledgeDir, filePath);

    if (filePath.endsWith('.ipynb')) {
      allChunks.push(...chunkNotebook(content, relativePath));
    } else if (filePath.endsWith('.py')) {
      allChunks.push(...chunkPython(content, relativePath));
    } else {
      // .md and .txt files use markdown chunking
      allChunks.push(...chunkMarkdown(content, relativePath));
    }
  }

  // Cache the index to disk
  if (!fs.existsSync(RAG_CACHE_DIR)) {
    fs.mkdirSync(RAG_CACHE_DIR, { recursive: true });
  }
  fs.writeFileSync(RAG_INDEX_FILE, JSON.stringify(allChunks, null, 2), 'utf8');

  return allChunks;
}

// ======================== Semantic RAG (Embedding) ========================

/**
 * Compute cosine similarity between two vectors
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Derive the embedding API URL from the user's existing LLM apiUrl.
 * - OpenAI-compatible: /v1/chat/completions → /v1/embeddings
 * - Ollama: /api/generate → /api/embed
 */
export function deriveEmbeddingUrl(apiUrl: string): string {
  if (apiUrl.includes('/chat/completions')) {
    // OpenAI-compatible: replace /chat/completions with /embeddings
    return apiUrl.replace(/\/chat\/completions.*/, '/embeddings');
  }
  if (apiUrl.includes('/api/generate')) {
    // Ollama: replace /api/generate with /api/embed
    return apiUrl.replace(/\/api\/generate.*/, '/api/embed');
  }
  // Fallback: assume OpenAI-compatible, append /v1/embeddings
  return apiUrl.replace(/\/$/, '') + '/v1/embeddings';
}


/**
 * Load the cached RAG index from disk.
 * Returns an empty array if the cache does not exist.
 */
export function loadRagIndex(): RagChunk[] {
  if (!fs.existsSync(RAG_INDEX_FILE)) return [];
  try {
    const data = fs.readFileSync(RAG_INDEX_FILE, 'utf8');
    return JSON.parse(data) as RagChunk[];
  } catch {
    return [];
  }
}

/**
 * Retrieve the top-K most relevant chunks for a given query using BM25-lite scoring.
 *
 * Scoring formula per chunk:
 *   score = sum of IDF(term) for each query term found in the chunk
 *   IDF(term) = log(N / (1 + df))
 *   where N = total chunks, df = number of chunks containing the term
 *
 * Returns the concatenated content of the top-K chunks with source attribution.
 */
export function retrieveContext(query: string, index: RagChunk[], topK: number = 3): string {
  if (index.length === 0) return '';

  const queryTokens = [...new Set(tokenize(query))];
  if (queryTokens.length === 0) return '';

  const N = index.length;

  // Pre-compute document frequency for each query token
  const df = new Map<string, number>();
  for (const token of queryTokens) {
    let count = 0;
    for (const chunk of index) {
      if (chunk.tokens.includes(token)) count++;
    }
    df.set(token, count);
  }

  // Score each chunk
  const scored = index.map(chunk => {
    let score = 0;
    const chunkTokenSet = new Set(chunk.tokens);
    for (const token of queryTokens) {
      if (chunkTokenSet.has(token)) {
        const termDf = df.get(token) || 0;
        score += Math.log(N / (1 + termDf));
      }
    }
    return { chunk, score };
  });

  // Sort by score descending, take top-K
  scored.sort((a, b) => b.score - a.score);
  const topChunks = scored.slice(0, topK).filter(s => s.score > 0);

  if (topChunks.length === 0) return '';

  // Format the retrieved context with source attribution
  return topChunks
    .map(({ chunk }) => `### ${chunk.title}\n*(Source: ${chunk.source})*\n\n${chunk.content}`)
    .join('\n\n---\n\n');
}
