// Mock OpenAI-compatible endpoint — streams a canned reply so we can validate the
// fx → shim → OpenAI translation with no real model / no API key.
const http = require('http');
const PORT = parseInt(process.env.MOCK_PORT || '8080', 10);

http.createServer((req, res) => {
  if (req.method === 'POST' && (req.url || '').includes('/chat/completions')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const words = ['Hello', ' from', ' a', ' fully', ' local', ' OpenAI-compatible', ' endpoint', ' via', ' the', ' fx', ' shim', '.'];
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const base = { id: 'chatcmpl-mock', object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, delta: {}, finish_reason: null }] };
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })}\n\n`);
      let i = 0;
      const tick = setInterval(() => {
        if (i < words.length) {
          res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: words[i] }, finish_reason: null }] })}\n\n`);
          i++;
        } else {
          res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: words.length, total_tokens: 12 + words.length } })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          clearInterval(tick);
        }
      }, 30);
    });
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ data: [{ id: 'mock', object: 'model' }] }));
}).listen(PORT, '127.0.0.1', () => console.error(`[mock-openai] on http://127.0.0.1:${PORT}`));
