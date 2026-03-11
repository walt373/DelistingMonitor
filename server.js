const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 4173;
const ROOT = __dirname;

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(payload));
}

function serveStatic(req, res) {
  let requestPath = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);
  if (requestPath === '/') requestPath = '/index.html';

  const filePath = path.join(ROOT, requestPath);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404); res.end('Not found'); return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8'
    }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    fs.createReadStream(filePath).pipe(res);
  });
}

async function handleSecProxy(req, res, url) {
  const target = url.searchParams.get('url');
  if (!target) return sendJson(res, 400, { error: 'Missing url parameter' });

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return sendJson(res, 400, { error: 'Invalid target url' });
  }

  if (!['www.sec.gov', 'data.sec.gov'].includes(parsed.hostname)) {
    return sendJson(res, 400, { error: 'Only sec.gov hosts are allowed' });
  }

  try {
    const upstream = await fetch(parsed.toString(), {
      headers: {
        'User-Agent': 'DelistingMonitor/1.0 (contact: local-dev@example.com)',
        'Accept-Encoding': 'gzip, deflate',
      },
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'text/plain; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    });
    res.end(text);
  } catch (error) {
    sendJson(res, 502, { error: String(error) });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/api/sec-proxy') {
    handleSecProxy(req, res, url);
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
