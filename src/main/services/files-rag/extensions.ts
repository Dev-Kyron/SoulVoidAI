/**
 * Single source of truth for the file-RAG extension table. Imported by both
 * the main-side `extract.ts` (which decides whether to even send a file to
 * the worker) and the worker (`worker.ts`, which double-checks before
 * reading bytes).
 *
 * Drift between the two lists would silently skip files OR redundantly try
 * to parse unsupported ones — keeping a single export prevents that.
 */
export const PLAIN_TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.rst',
  '.csv',
  '.tsv',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
  '.html',
  '.htm',
  '.log',
  '.ini',
  '.env',
  '.cfg'
])

export const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.py',
  '.rs',
  '.go',
  '.java',
  '.kt',
  '.swift',
  '.c',
  '.cc',
  '.cpp',
  '.h',
  '.hpp',
  '.cs',
  '.rb',
  '.php',
  '.lua',
  '.r',
  '.sh',
  '.bash',
  '.zsh',
  '.ps1',
  '.bat',
  '.sql',
  '.css',
  '.scss',
  '.vue',
  '.svelte',
  '.uplugin'
])

/** Document formats handled via dynamic-import parsers in the worker. */
export const DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set(['.pdf', '.docx'])

/** Convenience: every extension the file-RAG pipeline recognises. */
export function isSupportedExtension(ext: string): boolean {
  const lower = ext.toLowerCase()
  return (
    PLAIN_TEXT_EXTENSIONS.has(lower) ||
    CODE_EXTENSIONS.has(lower) ||
    DOCUMENT_EXTENSIONS.has(lower)
  )
}
