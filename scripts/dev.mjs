#!/usr/bin/env node
// Local development server.
//
// Node standard library only, no dependencies, for the same reason the build
// has none. It builds dist/ and serves it on http://localhost:4321.
//
// This is a convenience for reading the page as a browser will see it. It is
// not a bundler, there is no hot reload, and there is no framework.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from './build.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
// Deliberately not `PORT`: many shells and CI runners already export PORT for
// something else, and silently serving on that would be confusing.
const DEV_PORT = Number(process.env.DEV_PORT || 4321);
const DEV_HOST = process.env.DEV_HOST || '127.0.0.1';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${DEV_HOST}:${DEV_PORT}`);
  // normalize() collapses `..` before we join, so a request cannot escape dist.
  const requested = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  let filePath = join(DIST, requested);

  try {
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = join(filePath, 'index.html');
  } catch {
    // Unknown path with no extension: serve the page shell.
    if (!extname(filePath)) filePath = join(DIST, 'index.html');
  }

  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    // A real 404 page, not a thrown error and not a blank body.
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>404</title><h1>404 &mdash; not found</h1>');
  }
});

await build();

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    process.stderr.write(
      `dev: port ${DEV_PORT} is already in use. Set DEV_PORT to a free port and retry.\n`,
    );
    process.exit(1);
  }
  throw err;
});

server.listen(DEV_PORT, DEV_HOST, () => {
  process.stdout.write(`dev: serving dist/ on http://${DEV_HOST}:${DEV_PORT}\n`);
});
