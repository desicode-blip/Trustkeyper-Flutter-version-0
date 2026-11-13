const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const root = path.resolve(__dirname, '../website/site/dist');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.otf': 'font/otf', '.wasm': 'application/wasm' };
http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1:8096');
  response.setHeader('Cache-Control', 'no-store');
  if (url.pathname.startsWith('/api/')) {
    response.writeHead(503, { 'Content-Type': 'application/json' });
    return response.end(JSON.stringify({ accepted: false, message: 'Local previews do not submit real enquiries.' }));
  }
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405);
    return response.end();
  }
  if (url.pathname === '/__responsive') {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    return response.end('<!doctype html><html><head><title>TrustKeyper responsive preview</title></head><body style="margin:0;background:#ddd;display:flex;gap:20px"><iframe title="Phone" src="/" style="border:0;width:390px;height:844px;flex:none"></iframe><iframe title="Tablet" src="/" style="border:0;width:834px;height:1100px;flex:none"></iframe></body></html>');
  }
  let filename;
  try {
    filename = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
    if (filename !== root && !filename.startsWith(root + path.sep)) throw new Error('Invalid path');
  } catch {
    response.writeHead(400);
    return response.end();
  }
  if (fs.existsSync(filename) && fs.statSync(filename).isDirectory()) filename = path.join(filename, 'index.html');
  let status = 200;
  if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) {
    filename = path.join(root, '404.html');
    status = 404;
  }
  response.writeHead(status, { 'Content-Type': types[path.extname(filename)] ?? 'application/octet-stream' });
  if (request.method === 'HEAD') return response.end();
  fs.createReadStream(filename).pipe(response);
}).listen(8096, '127.0.0.1', () => console.log('Website preview: http://127.0.0.1:8096 — local enquiries never send mail.'));
