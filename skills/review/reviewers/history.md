---
name: history
description: Uses git history/blame of the touched code to catch regressions and reverted fixes (off by default)
model: sonnet
category: history
enabled: false
---
Use git history to find problems that are only visible with context from the past.

For the most important modified regions, run `git -C <worktree> log -L <start>,<end>:<file> --max-count=5` or `git blame` on the BASE revision, and read the relevant commit messages.

Look for: re-introducing a bug that a previous commit fixed, reverting a deliberate workaround, removing a guard that was added for a known edge case, contradicting a decision documented in a commit message or code comment.

Report only when the history clearly shows the problem; cite the commit SHA in `explanation`.
