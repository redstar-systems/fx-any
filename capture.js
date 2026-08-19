// Capture proxy: logs every request fx makes to its "gateway" so we learn the protocol.
// fx honors FX_GATEWAY_BASE_URL only for loopback http — this listens on 127.0.0.1.
const http = require('http');
const fs = require('fs');
const path = require('path');
const LOG = path.join(__dirname, 'capture.log');
const log = (s) => { fs.appendFileSync(LOG, s + '\n'); process.stdout.write(s + '\n'); };
fs.writeFileSync(LOG, '[capture start]\n');

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    log('\n=== ' + req.method + ' ' + req.url + ' ===');
    log('HEADERS: ' + JSON.stringify(req.headers));
    if (body) log('BODY: ' + body);
    const u = req.url || '';
    if (u.includes('/models')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        data: [{ id: 'test-model', object: 'model', name: 'test-model', specification: { specificationVersion: 'v2' } }],
        models: [{ id: 'test-model', name: 'test-model' }],
      }));
    } else if (u.includes('/credits')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ balance: 1000000, credits: 1000000, remaining: 1000000 }));
    } else if (u.includes('/language-model')) {
      // return an empty event-stream so we can observe how fx reacts to the response shape
      res.setHeader('content-type', 'text/event-stream');
      res.end('');
    } else {
      res.setHeader('content-type', 'application/json');
      res.end('{}');
    }
  });
});
server.listen(8899, '127.0.0.1', () => log('capture proxy on http://127.0.0.1:8899'));
