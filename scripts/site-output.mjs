import { copyFile, mkdir, rename } from 'node:fs/promises';

await rename('dist/server/worker.js', 'dist/server/index.js');
try {
  await mkdir('dist/.openai', { recursive: true });
  await copyFile('.openai/hosting.json', 'dist/.openai/hosting.json');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
