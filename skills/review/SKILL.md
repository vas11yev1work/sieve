---
name: review
description: Multi-agent code review of a GitHub PR (URL or number) or of local changes, opened in an interactive UI where each finding can be discussed, turned into a short comment and published to the PR. Use when the user asks to review a PR / pull request / their changes with Sieve.
argument-hint: "[PR url | owner/repo#123 | 123] [--base <branch>] [--lang <lang>] [--comment-lang <lang>] [--force]"
allowed-tools: Bash(bun:*), Bash(realpath:*), Bash(gh:*), Bash(git:*), Task, Read
---

# Sieve — multi-agent code review with an interactive UI

Arguments: `$ARGUMENTS`
(empty → review local changes of the current branch against its base branch)

You are the orchestrator. You do NOT review code yourself: you run the Sieve CLI, launch reviewer
agents in parallel, pass their results back to the CLI, and open the UI. Nothing is ever posted to
GitHub from here — the user publishes from the UI.

## 0. Locate Sieve

`SIEVE` = the directory two levels above this skill's base directory (it contains `cli/sieve.ts`).
Resolve it once with `realpath "<skill base dir>/../.."` and use the absolute path below.
Bun is required: if `bun --version` fails, tell the user to install it (https://bun.sh) and stop.

## 1. Prepare

```bash
bun "$SIEVE/cli/sieve.ts" prepare $ARGUMENTS
```

It prints JSON. Then:

- `existing: true` → this revision was already reviewed. Skip to step 5 (open the UI) and tell the user
  they can re-run with `--force` for a fresh review.
- `stop` is set → tell the user the reason (in their language) and stop.
- `isDraft: true` → mention it in one line and continue.

Remember `runDir`, `reviewers`, `reportLanguage`.

## 2. Run reviewers in parallel

In ONE message, launch one Task per entry in `reviewers` (they must run in parallel):

- `subagent_type`: `general-purpose`
- `model`: the reviewer's `model`
- `description`: `Sieve: <name>`
- `prompt`:
  > Read the file `<prompt>` and follow its instructions exactly. Use only read-only tools.
  > Your final message must be ONLY the JSON array described there — no prose, no code fences.

## 3. Merge and register candidates

Collect the arrays. If a reviewer returned something unparsable, skip it and remember to mention it.

Merge duplicates: findings about the same underlying problem at the same place (same file, overlapping
lines) become one — keep the clearest title/explanation, the highest severity, and list all reviewer
names in `reviewers`. Set `reviewers: ["<name>"]` on every other finding. Do not invent, reword or drop
findings beyond merging.

Pass the merged array to the CLI with a quoted heredoc:

```bash
bun "$SIEVE/cli/sieve.ts" candidates "<runDir>" <<'SIEVE_JSON'
[ ...merged findings... ]
SIEVE_JSON
```

## 4. Validate

If the output has a non-empty `validate` list, launch one Task per item, in parallel (in waves of at
most 10 per message):

- `subagent_type`: `general-purpose`, `model`: the item's `model`, `description`: `Sieve: validate <id>`
- `prompt`:
  > Read the file `<prompt>` and follow its instructions exactly. Use only read-only tools.
  > Your final message must be ONLY the JSON object described there.

Collect the objects into an array (skip unparsable ones) and finalize:

```bash
bun "$SIEVE/cli/sieve.ts" finalize "<runDir>" <<'SIEVE_JSON'
[ ...verdicts... ]
SIEVE_JSON
```

If `validate` is empty (validation disabled or no candidates), run `finalize` with `[]`.

## 5. Open the UI

```bash
bun "$SIEVE/cli/sieve.ts" serve "<runDir>" --detach
```

It starts the UI server in the background (first run installs and builds the UI, ~30s), opens the
browser and prints `{ "url": … }`.

## 6. Report

Reply in `reportLanguage`, briefly: how many findings by severity, how many were filtered out by
validation, which reviewers failed (if any), and the UI link. Remind the user that nothing is posted
until they press "Publish" in the UI. Do not list the findings in detail — they are in the UI.
