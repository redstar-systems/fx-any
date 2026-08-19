// Two-turn mock: turn 1 asks fx to call read_file(hello.txt); turn 2 (once it sees the
// tool result in the messages) returns a final text answer. Proves the full tool loop.
const http = require('http');
const PORT = parseInt(process.env.MOCK_PORT || '8092', 10);
const sse = (res, o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
http.createServer((req, res) => {
  if (req.method === 'POST' && (req.url || '').includes('/chat/completions')) {
    let body = ''; req.on('data', (c) => (body += c));
    req.on('end', () => {
      let msgs = []; try { msgs = JSON.parse(body).messages || []; } catch (e) {}
      const sawToolResult = msgs.some((m) => m.role === 'tool');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const base = { id: 'x', object: 'chat.completion.chunk', model: 'mock-tools', choices: [{ index: 0, delta: {}, finish_reason: null }] };
      if (!sawToolResult) {
        // TURN 1: emit a tool call to read_file
        sse(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '' } }] }, finish_reason: null }] });
        sse(res, { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"hello.txt"}' } }] }, finish_reason: null }] });
        sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        // TURN 2: fx sent back the tool result — answer using it
        const toolMsg = msgs.find((m) => m.role === 'tool');
        const seen = (toolMsg && toolMsg.content ? String(toolMsg.content) : '').replace(/\s+/g, ' ').slice(0, 80);
        for (const w of ['I ', 'read ', 'hello.txt', ' via ', 'the ', 'tool. ', 'It ', 'contains: ', seen, '. ', 'Round-trip ', 'complete.']) {
          sse(res, { ...base, choices: [{ index: 0, delta: { content: w }, finish_reason: null }] });
        }
        sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      }
      sse(res, '[DONE]'); res.write('data: [DONE]\n\n'); res.end();
    });
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
}).listen(PORT, '127.0.0.1', () => console.error(`[mock-tools] on ${PORT}`));
