import { readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

const tests = (await readdir('tests')).filter(name => name.endsWith('.test.ts')).sort();
if (!tests.length) throw new Error('No Closing Time tests found.');

const output = await mkdtemp(join(tmpdir(), 'closing-time-test-'));
try {
  await build({
    entryPoints: tests.map(name => resolve('tests', name)),
    bundle: true,
    outdir: output,
    outExtension: { '.js': '.mjs' },
    platform: 'node',
    format: 'esm',
  });
  const result = spawnSync(process.execPath, ['--test', ...tests.map(name => join(output, name.replace(/\.ts$/, '.mjs')))], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(output, { recursive: true, force: true });
}
