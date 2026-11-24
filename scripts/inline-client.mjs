import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const output = resolve('dist/client');
const path = resolve(output, 'index.html');
const html = await readFile(path, 'utf8');
const script = html.match(/<script type="module" crossorigin src="\/([^"]+)"><\/script>/);
const style = html.match(/<link rel="stylesheet" crossorigin href="\/([^"]+)">/);
if (!script || !style) throw new Error('Expected a JS bundle and a stylesheet.');
const js = await readFile(resolve(output, script[1]), 'utf8');
const css = await readFile(resolve(output, style[1]), 'utf8');
if (/<\/script/i.test(js) || /<\/style/i.test(css)) throw new Error('Unsafe inline asset.');
await writeFile(path, html.replace(script[0], () => `<script type="module">\n${js}\n</script>`)
  .replace(style[0], () => `<style>\n${css}\n</style>`));
