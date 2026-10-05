# Sieve

Multi-agent code review for [Claude Code](https://claude.com/claude-code) with an interactive UI.

Point it at a GitHub PR (or your local branch). Several reviewer agents check it in parallel against **your project's own rules**, every finding is re-checked by an independent validator, and the survivors open in a local web UI where you:

- discuss each finding with Claude in its own thread (it can read the code),
- accept or reject it — rejections can be remembered so future reviews don't repeat them,
- generate a short PR comment (in the language you choose, with a ```suggestion block when the fix is trivial),
- publish everything as **one** GitHub review, inline where possible.

A second tab, **Map**, shows how the code the PR touches actually works — the flows it is part of, as a graph — so you understand the change before you look at what's wrong with it.

Nothing is posted until you press **Publish**.

```
/sieve:review https://github.com/acme/web/pull/1234
```

## How it works

```
prepare ──► reviewers (parallel) ──► merge ──► validators (parallel) ──► finalize ──► UI ──► publish
  CLI        Claude Code subagents   orchestr.   Claude Code subagents      CLI      Bun+Vue   gh api
```

| Step       | Who               | What                                                                                                                                                                                                         |
| ---------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| prepare    | `cli/sieve.ts`    | Resolves the input, fetches the PR into a detached git worktree at the PR head, takes the diff exactly as GitHub shows it, drops ignored files, finds applicable rule files, renders a prompt per reviewer.  |
| review     | subagents         | Each enabled reviewer gets its own prompt and returns findings as JSON. Default: `rules` (sonnet), `bugs-diff` (opus), `bugs-logic` (opus), `quality` (sonnet); `history` (git blame/log) is off by default. |
| merge      | orchestrator      | Merges duplicates found by several reviewers.                                                                                                                                                                |
| candidates | CLI               | Normalizes paths, drops findings outside changed files or below `minSeverity`, computes where an inline comment can be anchored.                                                                             |
| validate   | subagents         | One skeptical validator per finding (opus for bugs/security, sonnet for rules by default). Rejected / low-confidence findings go to the _Filtered out_ tab.                                                  |
| UI         | `server/` + `ui/` | Local server on `127.0.0.1`. Per-finding chat runs `claude -p` with `--resume`, read-only tools (`Read`, `Grep`, `Glob`), cwd = the PR worktree.                                                             |
| map        | subagent / server | Optional. A cartographer agent traces the flows the PR touches through the real code; the map is normalized against the diff and opens in the **Map** tab. See [PR map](#pr-map).                            |
| publish    | `gh api`          | `POST /repos/{o}/{r}/pulls/{n}/reviews` with `commit_id` = PR head. Findings outside the diff go into the review body with permalinks.                                                                       |

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
/sieve:review 1234 --only quality,history              # run only these reviewers (even if disabled)
/sieve:review 1234 --skip quality                      # the usual set minus these reviewers
/sieve:review 1234 --min-severity nit                  # show everything, down to nits
/sieve:review 1234 --force                             # re-review a revision that was already reviewed
```

Run it from inside the repository when you can: agents then read files inside your project and Claude Code won't ask for extra read permissions. For a PR of a repo you don't have locally, Sieve clones it to `~/.sieve/repos/<owner>/<repo>` (consider adding `~/.sieve` to `permissions.additionalDirectories` in your Claude Code settings).

Run data lives in `<repo>/.sieve/runs/` and is excluded from git automatically (via `.git/info/exclude`). Re-running the same PR revision just reopens the UI.

### UI shortcuts

Review: `j`/`k` — next/previous finding · `a` — accept · `r` — reject · `g` — generate comment · `Enter` — send chat message

Map: `[`/`]` — previous/next flow · `Esc` — deselect the step · `f` — fit the graph

The current tab, flow and step live in the URL (`#review`, `#map/<flow>/<step>`), so reloads and links keep your place.

## PR map

<!-- screenshot: docs/map.png -->

The **Map** tab answers "how does this work?" before the review answers "what's wrong?":

- **Overview** — what the PR does and why, the affected areas, and a few architectural risks.
- **Flows** — 1–5 scenarios the PR takes part in ("add a product to the cart", "app start", or "how module X works" for refactorings), each a graph of real steps: trigger → component → composable → store → API → …
- **Steps** point to real files and lines. Steps changed by the PR are highlighted (`+` added, `~` modified, `−` removed — checked against the diff, not taken on the agent's word), unchanged steps are dimmed.
- **Findings** of the review show up as badges on the steps they fall into; click through from a step to the finding and back ("Show on map").
- **Chat per step** — ask Claude how the step works and how the change affects it (same read-only tools as the finding chat).

When the map is built is set by `map.mode`:

| Mode                  | What happens                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------- |
| `on-demand` (default) | The tab offers a **Build map** button. The build runs on the server; closing the tab doesn't stop it. |
| `always`              | The skill runs the cartographer in parallel with the reviewers; the map is ready when the UI opens.   |
| `off`                 | No map tab.                                                                                           |

"Rebuild" replaces the map and resets the step chats. Nothing from the map is ever posted to GitHub.

## Inbox

```
/sieve:inbox
```

A page at `http://127.0.0.1:7438/inbox` (always the same port, `inbox.port`) with every open PR that requests your review, across all repos your `gh` token can see — with what GitHub says about it and what Sieve has done with it. Start a review with one click; it runs in the background and the page shows how far it got.

Only PRs that need something from you are listed, in two groups:

- **In progress** — a Sieve review is running or queued.
- **To review** — you are requested and have not reviewed the current commit, or new commits came after your review or approval. PRs nobody has approved on their current commit come first (an approval given before newer commits does not count), then those approved by others; within each, PRs whose Sieve findings wait for you go first.

PRs you already reviewed or approved on their current commit (comments published from Sieve included) are hidden until new commits come, as are merged and closed ones. Being personally requested again, or your review being dismissed, brings a PR back.

Each row shows:

- **On GitHub** — review decision and approvals, your last review and whether new commits came after it, CI checks, merge conflicts, unresolved threads, the team you were requested through, labels, size.
- **In Sieve** — findings of the run on the current head by severity, how many are left to go through or ready to publish, the published review, whether a map was built; a run on an older commit is marked as such.
- **Action** — Review / Open / Review again / Cancel. While a review runs, the Sieve column shows a progress ring and what it is doing ("Reviewers 2 of 4", "Checked 6 of 14 findings") with the elapsed time.

The header has **Stop** (stops the inbox server, cancelling running and queued reviews) and the same language button as the review page; there "save as default" writes `~/.sieve/settings.json`, since the inbox spans projects.

The inbox is off by default and reads **only** `~/.sieve/settings.json` (it spans repos, so a repo's settings never change it):

```jsonc
{
  "inbox": {
    "enabled": true,
    "port": 7438, // always http://127.0.0.1:7438/inbox — bookmark it
    "requested": "me-or-team", // "me" = only requested from you personally, not via a team
    "repos": [], // ["acme/web"] — only these repos; empty = all
    "owners": [], // ["acme"] — only these users / orgs
    "excludeRepos": [], // ["acme/legacy"]
    "includeDrafts": false,
    "showReviewed": true, // also PRs you reviewed that got new commits, when not requested again
    "checkouts": { "acme/web": "~/code/web" }, // where to run reviews from
  },
}
```

How a review started from the inbox runs:

- `claude -p "/sieve:review <url>"` — the same skill, headless, with your Claude Code login. It may use `bun`, `git`, `gh`, read-only tools and subagents without asking; anything else is denied. One review at a time, the rest are queued.
- It runs from the repo's local checkout when Sieve knows one: from `checkouts`, or a checkout you already ran `/sieve:review` in (remembered in `~/.sieve/checkouts.json`). Otherwise the repo is cloned to `~/.sieve/repos/<owner>/<repo>`.
- It does not open a browser. **Open** starts the run's UI on its own port; that server stops after 2 hours without requests.
- The orchestrator's output is kept in `~/.sieve/logs/inbox-<owner>-<repo>-<n>.jsonl`; a failed review shows its error and the log path.

GitHub is asked at most once a minute (Refresh asks right away). Organizations with SSO need the `gh` token authorized for them, otherwise their PRs are missing.

## Configuration

Settings are merged in this order (later wins):

1. built-in defaults
2. `~/.sieve/settings.json` — your personal defaults for every project
3. `<repo>/.sieve/settings.json` — team settings, commit it
4. `<repo>/.sieve/settings.local.json` — your personal overrides for this project, keep it out of git
5. CLI flags (`--lang`, `--comment-lang`, `--min-severity`)

Languages can also be switched in the UI (languages button in the header); "save as default" writes them to `settings.local.json` (in the inbox: to `~/.sieve/settings.json`).

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
  "map": { "mode": "on-demand", "model": "sonnet" }, // on-demand | always | off
  "server": { "port": 0, "open": true },
}
```

Full reference: [`schema/settings.schema.json`](schema/settings.schema.json). Examples: [`examples/.sieve/`](examples/.sieve).

### Project rules

By default Sieve looks for: `CLAUDE.md` and `AGENTS.md` (scoped to their folder and below), `.claude/rules/**/*.md`, `.sieve/rules/**/*.md`, `.cursor/rules/**/*.mdc`, `.cursorrules`, `.github/copilot-instructions.md`, `.github/instructions/**/*.md`, `CONTRIBUTING.md`. Rules — and project reviewers, `learned.md` and `.sieve/settings*.json` — are read from your local checkout, gitignored files included (rules are often a personal setup), not from the PR head. A repo Sieve had to clone into `~/.sieve/repos` has no working files there, so its reviews run with the built-in and `~/.sieve` reviewers only; for the inbox, point `inbox.checkouts` at your checkout.

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

Reviewers are read-only by default. A reviewer that has to run something — say, start the app and click through it in a browser — lists the extra tools it may use, comma-separated, and can opt out of validation (the validator only reads code, so it would reject what was checked in the browser):

```markdown
---
name: browser
tools: mcp__chrome-devtools, Bash(yarn:*), Bash(kill:*)
validate: false
---
```

The inbox grants these tools to its headless runs. For an interactive `/sieve:review`, add them to `.claude/settings.local.json` to avoid a prompt on every call. Everything else (installing deps, which port to use, stopping the dev server) belongs in the reviewer's own text.

### Learning from rejections

When you reject a finding with a reason and keep "Remember for future reviews" checked, the reason is appended to `<repo>/.sieve/learned.md`. Every reviewer reads that file next time. Commit it to share with the team, or keep it local.

## CLI

The skill drives the CLI, but you can use it directly:

```
bun cli/sieve.ts prepare [PR] [--base ref] [--lang l] [--comment-lang l] [--only a,b] [--skip a,b] [--min-severity s] [--force]
bun cli/sieve.ts candidates <runDir>  < findings.json
bun cli/sieve.ts finalize <runDir>    < verdicts.json
bun cli/sieve.ts map <runDir>         < map.json        # normalize the cartographer's output into map.json
bun cli/sieve.ts serve <runDir> [--port n] [--no-open] [--detach] [--idle-exit min]
bun cli/sieve.ts runs
bun cli/sieve.ts inbox [--json] [--port n] [--no-open]   # inbox page (background server), or its data as JSON
```

## Development

```
bun install
bun run dev                     # API + Vite on a sample run (examples/dev-run) → http://localhost:5173
                                # + the inbox on your real GitHub queue → http://localhost:5173/inbox
                                #   (reviews there replay a recorded run; SIEVE_CLAUDE_BIN=claude for real ones;
                                #   FAKE_SPEED=0.2, FAKE_FINDINGS=40, FAKE_FAIL=1 tune the replay)
bun test                      # unit tests (diff parsing, anchors, review payload, map normalization, inbox)
bun run typecheck
bun run build                 # build the UI into ui/dist
bun cli/sieve.ts serve <runDir> --port 4545 --no-open
bun run dev:ui                # Vite dev server, proxies /api to :4545 (or $SIEVE_API)
```

Try the plugin without installing: `claude --plugin-dir /path/to/sieve`, then `/sieve:review`.

Server API (used by the UI): `GET /api/run`, `PATCH /api/findings/:id`, `POST /api/findings/:id/{chat,comment,reset}` (SSE for chat/comment), `GET /api/findings/:id/context`, `GET /api/code?file=&line=&endLine=`, `GET /api/map`, `POST /api/map/build` (SSE), `GET /api/map/progress` (SSE), `POST /api/map/cancel`, `POST /api/map/nodes/:flowId/:nodeId/{chat,reset}`, `GET /api/publish/preview`, `POST /api/publish`, `GET /api/export`. Inbox server: `GET /api/inbox[?refresh=1]`, `POST /api/inbox/{review,cancel,dismiss}` (`{ url }`), `POST /api/inbox/open` (`{ runDir }`), `PUT /api/inbox/settings`, `POST /api/inbox/shutdown`, `GET /api/inbox/ping`.

```
.claude-plugin/        plugin + marketplace manifests
skills/review/         SKILL.md (orchestrator), reviewers/, templates/
skills/inbox/          SKILL.md (opens the inbox)
cli/                   prepare / candidates / finalize / serve / inbox
server/                Hono API: findings, chat threads (SSE), PR map builds, GitHub publish; inbox + headless reviews
ui/                    Vue 3 + Vite UI
shared/types.ts        types shared by all of the above
schema/                JSON schema for settings
```

## License

MIT
