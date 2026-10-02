export interface ShResult {
  ok: boolean
  code: number
  stdout: string
  stderr: string
}

export function sh(cmd: string[], opts: { cwd?: string; input?: string; env?: Record<string, string> } = {}): ShResult {
  const p = Bun.spawnSync(cmd, {
    cwd: opts.cwd,
    stdin: opts.input !== undefined ? new TextEncoder().encode(opts.input) : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...opts.env },
  })
  return {
    ok: p.exitCode === 0,
    code: p.exitCode ?? -1,
    stdout: p.stdout.toString(),
    stderr: p.stderr.toString(),
  }
}

/** Run and throw on failure. Returns trimmed stdout. */
export function run(cmd: string[], opts: { cwd?: string; input?: string } = {}): string {
  const r = sh(cmd, opts)
  if (!r.ok) {
    throw new Error(`Command failed (${r.code}): ${cmd.join(' ')}\n${r.stderr.trim() || r.stdout.trim()}`)
  }
  return r.stdout.trim()
}

export function has(bin: string): boolean {
  return Bun.which(bin) !== null
}
