import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

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

