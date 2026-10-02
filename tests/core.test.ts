import { describe, expect, test } from 'bun:test'
import { parseDiff, anchorFor } from '../cli/lib/diff.ts'
import { parseInput } from '../cli/lib/source.ts'
import { buildReview } from '../server/publish.ts'
import type { Finding, RunMeta, RunState } from '../shared/types.ts'

const PATCH = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@
 const a = 1
-const b = 2
+const b = 3
+const c = 4

 export { a }
@@ -20,2 +21,3 @@ function x() {
   return 1
+  // added
 }
diff --git a/new.ts b/new.ts
new file mode 100644
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+line1
+line2
diff --git a/gone.ts b/gone.ts
deleted file mode 100644
--- a/gone.ts
+++ /dev/null
@@ -1 +0,0 @@
-bye
`

describe('parseDiff', () => {
  const files = parseDiff(PATCH)

  test('files and statuses', () => {
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ['src/a.ts', 'modified'],
      ['new.ts', 'added'],
      ['gone.ts', 'deleted'],
    ])
  })

  test('line numbers', () => {
    const h = files[0]!.hunks[0]!
    expect(h.lines.filter((l) => l.type === 'add').map((l) => l.new)).toEqual([2, 3])
    expect(h.lines.find((l) => l.type === 'del')!.old).toBe(2)
    // the empty context line keeps numbering intact
    expect(h.lines.at(-1)).toMatchObject({ type: 'ctx', new: 5, text: 'export { a }' })
    expect(files[0]!.hunks[1]!.lines.find((l) => l.type === 'add')!.new).toBe(22)
  })

  test('anchors', () => {
    expect(anchorFor(files, 'src/a.ts', 2)).toEqual({ line: 2 })
    expect(anchorFor(files, 'src/a.ts', 2, 3)).toEqual({ line: 3, startLine: 2 })
    // range spanning two hunks collapses to the first commentable line
    expect(anchorFor(files, 'src/a.ts', 3, 22)).toEqual({ line: 3 })
    expect(anchorFor(files, 'src/a.ts', 10)).toBeNull()
    expect(anchorFor(files, 'gone.ts', 1)).toBeNull()
    expect(anchorFor(files, 'new.ts', 1, 2)).toEqual({ line: 2, startLine: 1 })
  })
})

describe('parseInput', () => {
  test('variants', () => {
    expect(parseInput('https://github.com/VirtoCommerce/vc-frontend/pull/1234/files')).toEqual({
      kind: 'pr',
      owner: 'VirtoCommerce',
      repo: 'vc-frontend',
      number: 1234,
    })
    expect(parseInput('acme/web#7')).toEqual({ kind: 'pr', owner: 'acme', repo: 'web', number: 7 })
    expect(parseInput('#42')).toEqual({ kind: 'pr', number: 42 })
    expect(parseInput('')).toEqual({ kind: 'local', base: undefined })
    expect(() => parseInput('nonsense here')).toThrow()
  })
})

describe('buildReview', () => {
  const meta = { owner: 'o', repo: 'r', number: 1, headSha: 'abc', mode: 'pr' } as RunMeta
  const base = {
    severity: 'major' as const,
    category: 'bug',
    title: 't',
    explanation: 'e',
    reviewers: [] as string[],
    validation: { verdict: 'valid' as const },
    filtered: false,
  }
  const findings: Finding[] = [
    { ...base, id: 'f1', file: 'a.ts', line: 2, endLine: 3, inDiff: true, anchor: { line: 3, startLine: 2 } },
    { ...base, id: 'f2', file: 'b.ts', line: 50, inDiff: false, anchor: null },
    { ...base, id: 'f3', file: 'c.ts', line: 1, inDiff: true, anchor: { line: 1 } },
  ]
  const state: RunState = {
    findings: {
      f1: { status: 'accepted', comment: 'Fix it\n```suggestion\nx\n```', messages: [] },
      f2: { status: 'accepted', comment: 'Outside\n```suggestion\ny\n```', messages: [] },
      f3: { status: 'rejected', comment: 'nope', messages: [] },
    },
  }

  test('inline vs body', () => {
    const plan = buildReview(meta, findings, state, { summary: 'Summary' })
    expect(plan.ids).toEqual(['f1', 'f2'])
    expect(plan.payload.comments).toEqual([
      {
        path: 'a.ts',
        line: 3,
        start_line: 2,
        side: 'RIGHT',
        start_side: 'RIGHT',
        body: 'Fix it\n```suggestion\nx\n```',
      },
    ])
    expect(plan.payload.body).toContain('Summary')
    expect(plan.payload.body).toContain('https://github.com/o/r/blob/abc/b.ts#L50')
    expect(plan.payload.body).not.toContain('```suggestion')
    expect(plan.payload.commit_id).toBe('abc')
  })

  test('allGeneral', () => {
    const plan = buildReview(meta, findings, state, { allGeneral: true })
    expect(plan.payload.comments).toHaveLength(0)
    expect(plan.general).toBe(2)
  })

  test('published items are skipped', () => {
    const s2: RunState = { findings: { ...state.findings, f1: { ...state.findings.f1!, published: { at: 'now' } } } }
    expect(buildReview(meta, findings, s2).ids).toEqual(['f2'])
  })
})
