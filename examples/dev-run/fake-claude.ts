#!/usr/bin/env bun
/**
 * Stand-in for `claude -p` in `bun run dev`: replays the stream-json of a review orchestrator
 * (prepare → 4 reviewers → 3 validators → finalize) so the inbox can be developed without spending tokens.
 * Its result is the dev run (FAKE_RUN). FAKE_SPEED=0.2 → 5× faster; FAKE_FINDINGS=40 → 40 validators;
 * FAKE_FAIL=1 → the review fails at the end.
 */
export {}; // a module: top-level await

const RUN = process.env.FAKE_RUN!;
const say = (o: unknown) => console.log(JSON.stringify(o));
const tool = (id: string, name: string, input: unknown) =>
  say({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id: string, content: string) =>
  say({
    type: 'user',
    parent_tool_use_id: null,
    message: { content: [{ type: 'tool_result', tool_use_id: id, content }] },
  });
const wait = (ms: number) => Bun.sleep(ms * Number(process.env.FAKE_SPEED || 1));
await new Response(Bun.stdin.stream()).text();
say({ type: 'system', session_id: 's1' });
tool('b1', 'Bash', { command: 'bun "/x/cli/sieve.ts" prepare https://github.com/a/b/pull/1' });
await wait(2000);
result('b1', JSON.stringify({ runDir: RUN, reviewers: [] }));
const revs = ['rules', 'bugs-diff', 'bugs-logic', 'quality'];
revs.forEach((r, i) => tool(`t${i}`, 'Agent', { description: `Sieve: ${r}` }));
// a subagent's own tool call must be ignored
say({
  type: 'assistant',
  parent_tool_use_id: 't0',
  message: { content: [{ type: 'tool_use', id: 'x', name: 'Agent', input: { description: 'nested' } }] },
});
for (let i = 0; i < revs.length; i++) {
  await wait(2500);
  result(`t${i}`, '[]');
}
tool('b2', 'Bash', { command: 'bun "/x/cli/sieve.ts" candidates "/r" <<SIEVE_JSON' });
await wait(500);
result('b2', '{}');
const N = Number(process.env.FAKE_FINDINGS || 3);
for (let i = 0; i < N; i++) tool(`v${i}`, 'Agent', { description: `Sieve: validate f${i + 1}` });
for (let i = 0; i < N; i++) {
  await wait(2000);
  result(`v${i}`, '{}');
}
tool('b3', 'Bash', { command: 'bun "/x/cli/sieve.ts" finalize "/r"' });
await wait(1500);
result('b3', '{}');
if (process.env.FAKE_FAIL) {
  say({ type: 'result', is_error: true, result: 'Permission denied: Bash(rm)' });
  process.exit(1);
}
say({ type: 'result', subtype: 'success', result: 'Done: 3 findings.' });
