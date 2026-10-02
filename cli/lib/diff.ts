import type { ParsedFile, ParsedHunk } from '../../shared/types.ts'

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/

function unquote(p: string): string {
  // git quotes paths with special chars: "a/foo bar.ts"
  if (p.startsWith('"') && p.endsWith('"')) {
    try {
      return JSON.parse(p)
    } catch {
      return p.slice(1, -1)
    }
  }
  return p
}

function stripPrefix(p: string): string {
  p = unquote(p.trim())
  if (p === '/dev/null') return p
  return p.replace(/^[ab]\//, '')
}

/** Parse a unified diff produced by `git diff` / `gh pr diff`. */
export function parseDiff(patch: string): ParsedFile[] {
  const files: ParsedFile[] = []
  let file: ParsedFile | null = null
  let hunk: ParsedHunk | null = null
  let oldNo = 0
  let newNo = 0

  const lines = patch.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!

    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git (\S+|"[^"]+") (\S+|"[^"]+")$/)
      file = {
        path: m ? stripPrefix(m[2]!) : line.slice(11),
        status: 'modified',
        binary: false,
        hunks: [],
      }
      if (m) {
        const oldP = stripPrefix(m[1]!)
        if (oldP !== file.path) file.oldPath = oldP
      }
      files.push(file)
      hunk = null
      continue
    }
    if (!file) continue

    // Some tools strip the leading space of empty context lines.
    if (hunk && line === '' && newNo < hunk.newStart + hunk.newLines && oldNo < hunk.oldStart + hunk.oldLines) {
      hunk.lines.push({ type: 'ctx', old: oldNo++, new: newNo++, text: '' })
      continue
    }

    if (!hunk || !(line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || line.startsWith('\\'))) {
      // header area (or end of hunk)
      if (line.startsWith('new file mode')) file.status = 'added'
      else if (line.startsWith('deleted file mode')) file.status = 'deleted'
      else if (line.startsWith('rename from ')) {
        file.status = 'renamed'
        file.oldPath = unquote(line.slice(12))
      } else if (line.startsWith('rename to ')) {
        file.status = 'renamed'
        file.path = unquote(line.slice(10))
      } else if (line.startsWith('Binary files') || line === 'GIT binary patch') file.binary = true
      else if (line.startsWith('--- ')) {
        const p = stripPrefix(line.slice(4))
        if (p === '/dev/null') file.status = 'added'
      } else if (line.startsWith('+++ ')) {
        const p = stripPrefix(line.slice(4))
        if (p === '/dev/null') file.status = 'deleted'
        else file.path = p
      }
      const hm = line.match(HUNK_RE)
      if (hm) {
        hunk = {
          header: line,
          oldStart: +hm[1]!,
          oldLines: hm[2] === undefined ? 1 : +hm[2],
          newStart: +hm[3]!,
          newLines: hm[4] === undefined ? 1 : +hm[4],
          lines: [],
        }
        oldNo = hunk.oldStart
        newNo = hunk.newStart
        file.hunks.push(hunk)
      }
      continue
    }

    // inside a hunk
    const hm = line.match(HUNK_RE)
    if (hm) {
      hunk = {
        header: line,
        oldStart: +hm[1]!,
        oldLines: hm[2] === undefined ? 1 : +hm[2],
        newStart: +hm[3]!,
        newLines: hm[4] === undefined ? 1 : +hm[4],
        lines: [],
      }
      oldNo = hunk.oldStart
      newNo = hunk.newStart
      file.hunks.push(hunk)
      continue
    }
    const c = line[0]
    const text = line.slice(1)
    if (c === '+') hunk.lines.push({ type: 'add', new: newNo++, text })
    else if (c === '-') hunk.lines.push({ type: 'del', old: oldNo++, text })
    else if (c === ' ') hunk.lines.push({ type: 'ctx', old: oldNo++, new: newNo++, text })
    // "\ No newline at end of file" is ignored
  }
  return files
}

/** Hunk index for each RIGHT-side line GitHub accepts comments on. */
function rightLines(f: ParsedFile): Map<number, number> {
  const m = new Map<number, number>()
  f.hunks.forEach((h, hi) => {
    for (const l of h.lines) if (l.new !== undefined) m.set(l.new, hi)
  })
  return m
}

/**
 * Decide where an inline comment can be anchored.
 * GitHub only accepts RIGHT-side lines that are part of a hunk; a multi-line
 * comment must start and end in the same hunk.
 */
export function anchorFor(
  files: ParsedFile[],
  path: string,
  line: number,
  endLine?: number,
): { line: number; startLine?: number } | null {
  const f = files.find((x) => x.path === path)
  if (!f || f.binary || f.status === 'deleted') return null
  const map = rightLines(f)
  const end = endLine && endLine > line ? endLine : line

  if (map.has(line) && map.has(end) && map.get(line) === map.get(end)) {
    return end > line ? { line: end, startLine: line } : { line }
  }
  // Fall back to the first commentable line inside the range.
  for (let n = line; n <= end; n++) if (map.has(n)) return { line: n }
  // Or the last one, if the range ended inside a hunk.
  if (map.has(end)) return { line: end }
  return null
}

/** Hunks that overlap [line, endLine] (with some slack), for showing context in the UI. */
export function hunksAround(files: ParsedFile[], path: string, line: number, endLine?: number, slack = 3) {
  const f = files.find((x) => x.path === path)
  if (!f) return []
  const a = line - slack
  const b = (endLine || line) + slack
  return f.hunks.filter((h) => {
    const hs = h.newStart
    const he = h.newStart + Math.max(h.newLines, 1) - 1
    return he >= a && hs <= b
  })
}
