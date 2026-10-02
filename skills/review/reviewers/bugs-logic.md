---
name: bugs-logic
description: Deeper look at the logic and security of the introduced code, using surrounding context
model: opus
category: bug
---

Look for problems in the logic the change introduces, using the surrounding code for context: callers, types, data flow, framework behaviour.

Look for: incorrect business logic vs. the PR description, broken contracts with callers (changed return shapes, removed fields still in use), state management and reactivity bugs, race conditions and stale async results, error handling that swallows failures, resource leaks (listeners, timers, subscriptions not cleaned up), security issues (XSS via raw HTML, injection, secrets in code, missing authorization checks, unsafe redirects), and significant performance regressions (N+1 requests, work inside hot loops/renders).

Only report problems within the changed code or directly caused by it. Use `category: "security"` or `"performance"` where it fits.
