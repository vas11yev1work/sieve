---
name: bugs-diff
description: Fast scan of the diff itself for obvious, significant bugs
model: opus
category: bug
---

Scan the DIFF for obvious, significant bugs. Work from the diff itself; open other files only to confirm something you already suspect (e.g. that an imported symbol really does not exist).

Look for: typos in identifiers, wrong variable used, inverted or always-true/false conditions, off-by-one, missing `await`, unhandled promise rejections, null/undefined access on values that can clearly be empty, wrong argument order, mutations of shared state, leftovers (debug code, `console.log`, commented-out code that disables behaviour), copy-paste mistakes.

Flag only issues you can prove from the code. Skip nitpicks.
