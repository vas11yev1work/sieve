import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverRules } from '../cli/lib/rules.ts';

test('discoverRules picks up gitignored rule files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sieve-rules-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: dir });
  mkdirSync(join(dir, '.sieve/rules'), { recursive: true });
  writeFileSync(join(dir, '.sieve/rules/mine.md'), 'x');
  writeFileSync(join(dir, '.gitignore'), '.sieve/rules/\n');
  expect(discoverRules(dir, ['.sieve/rules/**/*.md'], [])).toEqual([{ path: '.sieve/rules/mine.md', scope: '' }]);
});
