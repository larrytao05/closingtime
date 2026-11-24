import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import worker from '../dist/server/index.js';

const origin = 'http://127.0.0.1:4173';
createServer(async (request, response) => {
  try {
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    const result = await worker.fetch(new Request(origin + request.url, {
      method: request.method,
      headers: request.headers,
      ...(hasBody ? { body: Readable.toWeb(request), duplex: 'half' } : {}),
    }), process.env);
    response.writeHead(result.status, Object.fromEntries(result.headers));
    if (result.body) Readable.fromWeb(result.body).pipe(response);
    else response.end();
  } catch {
    response.writeHead(500).end('The game server encountered an error.');
  }
}).listen(4173, '127.0.0.1', () => console.log(`Closing Time is running at ${origin}`));
