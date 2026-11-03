---
name: prune
description: Free disk space taken by Sieve review worktrees — removes the checkouts of merged/closed PRs, of older revisions of a PR and of repos that no longer exist, after showing the list and asking. Findings stay. Use when the user asks to clean up / prune Sieve runs or worktrees, or Sieve takes too much disk space.
allowed-tools: Bash(bun:*), Bash(realpath:*)
---

# Sieve prune

`SIEVE` = the directory two levels above this skill's base directory (it contains `cli/sieve.ts`).
Resolve it with `realpath "<skill base dir>/../.."`.

1. Dry run:

   ```bash
   bun "$SIEVE/cli/sieve.ts" runs --prune --dry-run
   ```

   It prints `{ items: [{ title, url, reason, sizeMb }], freedMb }`. `reason` is `pr-closed` (merged or closed on
   GitHub), `older-revision` (a newer revision of the same PR was reviewed) or `repo-gone` (the checkout the review
   ran from was deleted).

2. `items` is empty → say there is nothing to clean and stop.

3. Show a short table (PR title, reason, size) and the total `freedMb`, then ask the user to confirm. Never skip
   this question: removal can't be undone. Nothing of the findings is removed, only the checkouts; a pruned review
   still opens from the inbox, and its worktree is recreated on open.

4. After a yes:

   ```bash
   bun "$SIEVE/cli/sieve.ts" runs --prune
   ```

   Reply in one line: how many worktrees were removed and how many MB were freed.

If `gh` isn't logged in, PR states can't be read: only `older-revision` and `repo-gone` show up. Mention it.
