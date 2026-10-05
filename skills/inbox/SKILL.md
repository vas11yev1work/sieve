---
name: inbox
description: Open the Sieve inbox — a page with the GitHub PRs waiting for your review across repos, their GitHub status and their Sieve runs, where a review can be started with one click. Use when the user asks for their review queue, PRs assigned to them for review, or the Sieve inbox.
allowed-tools: Bash(bun:*), Bash(realpath:*)
---

# Sieve inbox

`SIEVE` = the directory two levels above this skill's base directory (it contains `cli/sieve.ts`).
Resolve it with `realpath "<skill base dir>/../.."`.

```bash
bun "$SIEVE/cli/sieve.ts" inbox
```

It starts the inbox server in the background (or reuses a running one), opens the browser and prints `{ "url": … }`.

- If it fails with "The inbox is off", tell the user to add `{ "inbox": { "enabled": true } }` to
  `~/.sieve/settings.json` (the inbox reads only this file) and offer to do it.
- If `gh` is missing or not logged in, say so: the inbox needs `gh auth login`.

Reply in one or two lines with the link. Reviews started from the page run headless in the background;
nothing is posted to GitHub until the user publishes from a review's page.
