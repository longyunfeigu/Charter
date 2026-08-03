import { createReadStream, promises as fs } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';

const MIME_TYPES: Record<string, string> = {
  '.avif': 'image/avif',
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function argument(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

function respond(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

async function main(): Promise<void> {
  const directory = argument('directory');
  if (!directory) throw new Error('Missing --directory');
  const root = await fs.realpath(resolve(process.cwd(), directory));
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
      const requested = resolve(root, `.${pathname}`);
      if (requested !== root && !requested.startsWith(root + sep)) {
        respond(response, 403, 'Forbidden');
        return;
      }
      let target = await fs.realpath(requested);
      if (target !== root && !target.startsWith(root + sep)) {
        respond(response, 403, 'Forbidden');
        return;
      }
      const initial = await fs.stat(target);
      if (initial.isDirectory()) target = join(target, 'index.html');
      const stat = await fs.stat(target);
      if (!stat.isFile()) {
        respond(response, 404, 'Not found');
        return;
      }
      response.writeHead(200, {
        'Content-Type': MIME_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': stat.size,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      });
      if (request.method === 'HEAD') response.end();
      else createReadStream(target).pipe(response);
    } catch {
      respond(response, 404, 'Not found');
    }
  });
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    const port = address && typeof address === 'object' ? address.port : 0;
    process.stdout.write(`Charter static preview listening on http://127.0.0.1:${port}/\n`);
  });
  const close = (): void => {
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
