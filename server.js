const http = require('http');
const https = require('https');
const zlib = require('zlib');
const dns = require('dns');
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

function fetchRemote(url, headers = {}, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(url, {
      method: 'GET',
      headers,
      timeout: 12000,
      family: 4,
      lookup(hostname, options, callback) {
        return dns.lookup(hostname, { ...options, family: 4, all: false }, callback);
      },
    }, (upstream) => {
      const statusCode = upstream.statusCode || 502;
      const location = upstream.headers.location;
      if (location && statusCode >= 300 && statusCode < 400 && redirectCount < 4) {
        upstream.resume();
        resolve(fetchRemote(new URL(location, url), headers, redirectCount + 1));
        return;
      }

      let stream = upstream;
      const encoding = String(upstream.headers['content-encoding'] || '').toLowerCase();
      if (encoding.includes('gzip')) stream = upstream.pipe(zlib.createGunzip());
      else if (encoding.includes('deflate')) stream = upstream.pipe(zlib.createInflate());
      else if (encoding.includes('br')) stream = upstream.pipe(zlib.createBrotliDecompress());

      const chunks = [];
      stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      stream.on('end', () => resolve({
        status: statusCode,
        headers: upstream.headers,
        body: Buffer.concat(chunks),
      }));
      stream.on('error', reject);
    });

    req.on('timeout', () => req.destroy(new Error('Upstream request timed out')));
    req.on('error', reject);
    req.end();
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
    const upstream = await fetchRemote(parsed, {
      'User-Agent': 'DelistingMonitor/1.0 (contact: local-dev@example.com)',
      'Accept-Encoding': 'gzip, deflate, br',
    });
    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers['content-type'] || 'text/plain; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    });
    res.end(upstream.body);
  } catch (error) {
    sendJson(res, 502, { error: String(error) });
  }
}

async function handleMarketProxy(req, res, url) {
  const target = url.searchParams.get('url');
  if (!target) return sendJson(res, 400, { error: 'Missing url parameter' });

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return sendJson(res, 400, { error: 'Invalid target url' });
  }

  if (!['query1.finance.yahoo.com', 'query2.finance.yahoo.com', 'api.nasdaq.com'].includes(parsed.hostname)) {
    return sendJson(res, 400, { error: 'Only approved finance hosts are allowed' });
  }

  try {
    const upstream = await fetchRemote(parsed, {
      'User-Agent': 'Mozilla/5.0 (compatible; DelistingMonitor/1.0)',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Encoding': 'gzip, deflate, br',
      'Origin': 'https://www.nasdaq.com',
      'Referer': 'https://www.nasdaq.com/',
    });
    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers['content-type'] || 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    });
    res.end(upstream.body);
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
  if (url.pathname === '/api/market-proxy') {
    handleMarketProxy(req, res, url);
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
