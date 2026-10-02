# Sieve

Multi-agent code review for [Claude Code](https://claude.com/claude-code) with an interactive UI.

Point it at a GitHub PR (or your local branch). Several reviewer agents check it in parallel against **your project's own rules**, every finding is re-checked by an independent validator, and the survivors open in a local web UI where you:

- discuss each finding with Claude in its own thread (it can read the code),
- accept or reject it — rejections can be remembered so future reviews don't repeat them,
- generate a short PR comment (in the language you choose, with a ```suggestion block when the fix is trivial),
- publish everything as **one** GitHub review, inline where possible.

Nothing is posted until you press **Publish**.

```
/sieve:review https://github.com/acme/web/pull/1234
```

## How it works

```
prepare ──► reviewers (parallel) ──► merge ──► validators (parallel) ──► finalize ──► UI ──► publish
  CLI        Claude Code subagents   orchestr.   Claude Code subagents      CLI      Bun+Vue   gh api
```

| Step       | Who               | What                                                                                                                                                                                                        |
| ---------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| prepare    | `cli/sieve.ts`    | Resolves the input, fetches the PR into a detached git worktree at the PR head, takes the diff exactly as GitHub shows it, drops ignored files, finds applicable rule files, renders a prompt per reviewer. |
| review     | subagents         | Each enabled reviewer gets its own prompt and returns findings as JSON. Default: `rules` (sonnet), `bugs-diff` (opus), `bugs-logic` (opus); `history` (git blame/log) is off by default.                    |
| merge      | orchestrator      | Merges duplicates found by several reviewers.                                                                                                                                                               |
| candidates | CLI               | Normalizes paths, drops findings outside changed files or below `minSeverity`, computes where an inline comment can be anchored.                                                                            |
| validate   | subagents         | One skeptical validator per finding (opus for bugs/security, sonnet for rules by default). Rejected / low-confidence findings go to the _Filtered out_ tab.                                                 |
| UI         | `server/` + `ui/` | Local server on `127.0.0.1`. Per-finding chat runs `claude -p` with `--resume`, read-only tools (`Read`, `Grep`, `Glob`), cwd = the PR worktree.                                                            |
| publish    | `gh api`          | `POST /repos/{o}/{r}/pulls/{n}/reviews` with `commit_id` = PR head. Findings outside the diff go into the review body with permalinks.                                                                      |

The pipeline is the same idea as Anthropic's official `code-review` plugin (independent parallel reviewers + per-issue validation), with your rules, your language and a human in the loop before anything is posted.

## Requirements

- [Claude Code](https://claude.com/claude-code) (logged in — Sieve uses your Claude Code auth, no API key)
- [Bun](https://bun.sh) ≥ 1.1
- [GitHub CLI](https://cli.github.com) (`gh auth login`) — for PR reviews
- git

## Install

As a Claude Code plugin (this repo is its own marketplace):

```
/plugin marketplace add vas11yev1work/sieve
/plugin install sieve@sieve
```

Or from a local clone:

```
/plugin marketplace add /path/to/sieve
/plugin install sieve@sieve
```

The UI is built automatically on the first run (`bun install && bun run build`, ~30 s).

## Usage

```
/sieve:review https://github.com/acme/web/pull/1234   # PR by URL
/sieve:review acme/web#1234                            # short form
/sieve:review 1234                                     # PR in the current repo
/sieve:review                                          # local changes vs the default branch
/sieve:review --base develop                           # local changes vs a specific branch
/sieve:review 1234 --lang ru --comment-lang en         # override languages for this run
/sieve:review 1234 --force                             # re-review a revision that was already reviewed
```

Run it from inside the repository when you can: agents then read files inside your project and Claude Code won't ask for extra read permissions. For a PR of a repo you don't have locally, Sieve clones it to `~/.sieve/repos/<owner>/<repo>` (consider adding `~/.sieve` to `permissions.additionalDirectories` in your Claude Code settings).

Run data lives in `<repo>/.sieve/runs/` and is excluded from git automatically (via `.git/info/exclude`). Re-running the same PR revision just reopens the UI.

### UI shortcuts

`j`/`k` — next/previous finding · `a` — accept · `r` — reject · `g` — generate comment · `Enter` — send chat message

## Configuration

Settings are merged in this order (later wins):

1. built-in defaults
2. `~/.sieve/settings.json` — your personal defaults for every project
3. `<repo>/.sieve/settings.json` — team settings, commit it
4. `<repo>/.sieve/settings.local.json` — your personal overrides for this project, keep it out of git
5. CLI flags (`--lang`, `--comment-lang`)

Languages can also be switched in the UI (languages button in the header); "save as default" writes them to `settings.local.json`.

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/vas11yev1work/sieve/main/schema/settings.schema.json",

  "reportLanguage": "ru", // findings, explanations and the chat
  "commentLanguage": "en", // comments published to the PR
  "commentStyle": "Short and friendly, 1-3 sentences. State the problem and the fix.",

  "rulesExtra": ["docs/conventions/**/*.md"], // added to the default rule globs
  "ignoreExtra": ["**/*.generated.ts"], // added to the default ignore globs

  "reviewers": {
    "history": { "enabled": true }, // turn on an optional reviewer
    "bugs-diff": { "model": "sonnet" }, // cheaper model for a reviewer
  },

  "minSeverity": "minor", // critical | major | minor | nit
  "validation": { "enabled": true, "model": "auto", "minConfidence": 0.6 },
  "chat": { "model": "sonnet", "tools": ["Read", "Grep", "Glob"] },
  "server": { "port": 0, "open": true },
}
```

Full reference: [`schema/settings.schema.json`](schema/settings.schema.json). Examples: [`examples/.sieve/`](examples/.sieve).

### Project rules

By default Sieve looks for: `CLAUDE.md` and `AGENTS.md` (scoped to their folder and below), `.claude/rules/**/*.md`, `.sieve/rules/**/*.md`, `.cursor/rules/**/*.mdc`, `.cursorrules`, `.github/copilot-instructions.md`, `.github/instructions/**/*.md`, `CONTRIBUTING.md`. Rules are read from the PR head, so a PR that changes the rules is reviewed against its own version.

### Custom reviewers

A reviewer is a markdown file with frontmatter. Add your own (or override a built-in one by name) in:

- `<repo>/.sieve/reviewers/*.md` — project reviewers (commit them),
- `~/.sieve/reviewers/*.md` — personal reviewers for all projects.

```markdown
---
name: vue
description: Vue 3 + TypeScript specifics
model: sonnet # haiku | sonnet | opus
category: bug # default category of its findings
enabled: true
---

Review only Vue-specific problems in the changed files: lost reactivity, …
```

The body is the reviewer's focus; Sieve wraps it with the PR context, the diff location, the applicable rules, the output format and the shared "high-signal only" guidelines ([`skills/review/templates/reviewer.md`](skills/review/templates/reviewer.md)). See [`examples/.sieve/reviewers/vue.md`](examples/.sieve/reviewers/vue.md).

### Learning from rejections

When you reject a finding with a reason and keep "Remember for future reviews" checked, the reason is appended to `<repo>/.sieve/learned.md`. Every reviewer reads that file next time. Commit it to share with the team, or keep it local.

## CLI

The skill drives the CLI, but you can use it directly:

```
bun cli/sieve.ts prepare [PR] [--base ref] [--lang l] [--comment-lang l] [--force]
bun cli/sieve.ts candidates <runDir>  < findings.json
bun cli/sieve.ts finalize <runDir>    < verdicts.json
bun cli/sieve.ts serve <runDir> [--port n] [--no-open] [--detach]
bun cli/sieve.ts runs
```

## Development

```
bun install
bun test                      # unit tests (diff parsing, anchors, review payload)
bun run typecheck
bun run build                 # build the UI into ui/dist
bun cli/sieve.ts serve <runDir> --port 4545 --no-open
bun run dev:ui                # Vite dev server, proxies /api to :4545 (or $SIEVE_API)
```

Try the plugin without installing: `claude --plugin-dir /path/to/sieve`, then `/sieve:review`.

```
.claude-plugin/        plugin + marketplace manifests
skills/review/         SKILL.md (orchestrator), reviewers/, templates/
cli/                   prepare / candidates / finalize / serve
server/                Hono API: findings, per-finding Claude chat (SSE), GitHub publish
ui/                    Vue 3 + Vite UI
shared/types.ts        types shared by all of the above
schema/                JSON schema for settings
```

## License

MIT
