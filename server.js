// fx-any — a local shim that lets Vercel's `fx` talk to ANY standards-based endpoint.
//
// fx speaks Vercel's AI SDK "LanguageModelV2" gateway protocol. This server implements
// that protocol on loopback and translates it to/from the OpenAI /v1/chat/completions
// shape (which llama.cpp server, Ollama, LM Studio, vLLM, OpenRouter, and OpenAI all speak).
//
// Point fx at it with (all loopback-gated in fx):
//   FX_E2E_GATEWAY_CHAT_URL=http://127.0.0.1:PORT/v3/ai/language-model
//   FX_E2E_GATEWAY_MODELS_URL=http://127.0.0.1:PORT/coding-agent/v1/models
//   FX_E2E_GATEWAY_CREDITS_URL=http://127.0.0.1:PORT/coding-agent/v1/credits
//   AI_GATEWAY_API_KEY=anything   (we intercept everything; fx just needs a non-empty cred)
//
// Config (env):
//   FXANY_TARGET_URL   base URL of the OpenAI-compatible endpoint (e.g. http://127.0.0.1:8080/v1)
//   FXANY_API_KEY      bearer key for the target (blank ok for local llama.cpp/Ollama)
//   FXANY_MODEL        model id to send upstream (overrides fx's model id)
//   FXANY_PORT         listen port (default 8899)

const http = require('http');

const PORT = parseInt(process.env.FXANY_PORT || '8899', 10);
const TARGET_URL = (process.env.FXANY_TARGET_URL || 'http://127.0.0.1:8080/v1').replace(/\/$/, '');
const API_KEY = process.env.FXANY_API_KEY || '';
const MODEL_OVERRIDE = process.env.FXANY_MODEL || '';
const DEBUG = process.env.FXANY_DEBUG === '1';
const log = (...a) => { if (DEBUG) console.error('[fx-any]', ...a); };

// ── request translation: fx LanguageModelV2 body → OpenAI chat/completions ──────────
function partsToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((p) => p && p.type === 'text').map((p) => p.text).join('');
  return '';
}
function toOpenAIMessages(prompt) {
  const out = [];
  for (const m of prompt) {
    const role = m.role;
    const content = m.content;
    if (role === 'system') { out.push({ role: 'system', content: partsToText(content) }); continue; }
    if (role === 'user') { out.push({ role: 'user', content: partsToText(content) }); continue; }
    if (role === 'assistant') {
      const text = partsToText(content);
      const toolCalls = (Array.isArray(content) ? content : []).filter((p) => p.type === 'tool-call').map((p) => ({
        id: p.toolCallId, type: 'function',
        function: { name: p.toolName, arguments: typeof p.input === 'string' ? p.input : JSON.stringify(p.input ?? {}) },
      }));
      const msg = { role: 'assistant', content: text || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
      continue;
    }
    if (role === 'tool') {
      // each tool-result part becomes its own OpenAI tool message
      const parts = Array.isArray(content) ? content : [content];
      for (const p of parts) {
        if (!p || p.type !== 'tool-result') continue;
        const result = p.output ?? p.result ?? p;
        out.push({ role: 'tool', tool_call_id: p.toolCallId, content: typeof result === 'string' ? result : JSON.stringify(result) });
      }
      continue;
    }
    out.push({ role, content: partsToText(content) });
  }
  return out;
}
function toOpenAITools(tools) {
  if (process.env.FXANY_STRIP_TOOLS === '1') return undefined; // test aid: shrink prompt for tiny local models
  if (!Array.isArray(tools)) return undefined;
  const fns = tools.filter((t) => t.type === 'function').map((t) => ({
    type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema || { type: 'object', properties: {} } },
  }));
  return fns.length ? fns : undefined;
}
function toOpenAIToolChoice(tc) {
  if (!tc || !tc.type) return undefined;
  if (tc.type === 'auto') return 'auto';
  if (tc.type === 'none') return 'none';
  if (tc.type === 'required') return 'required';
  if (tc.type === 'tool' && tc.toolName) return { type: 'function', function: { name: tc.toolName } };
  return 'auto';
}

// ── SSE writing (fx side) ───────────────────────────────────────────────────────────
function sse(res, obj) { res.write(`data: ${JSON.stringify(obj)}\n\n`); }
const mapFinish = (r) => (r === 'tool_calls' ? 'tool-calls' : r === 'length' ? 'length' : r === 'content_filter' ? 'content-filter' : 'stop');

// ── the main endpoint: /v3/ai/language-model ────────────────────────────────────────
async function handleLanguageModel(req, res, body, headers) {
  let fxReq;
  try { fxReq = JSON.parse(body); } catch (e) { res.writeHead(400); return res.end('bad json'); }
  const model = MODEL_OVERRIDE || headers['ai-language-model-id'] || 'gpt-4o-mini';
  const oaReq = {
    model,
    stream: true,
    messages: toOpenAIMessages(fxReq.prompt || []),
    tools: toOpenAITools(fxReq.tools),
    tool_choice: toOpenAIToolChoice(fxReq.toolChoice),
  };
  Object.keys(oaReq).forEach((k) => oaReq[k] === undefined && delete oaReq[k]);
  log('→ upstream', TARGET_URL + '/chat/completions', 'model=', model, 'msgs=', oaReq.messages.length, 'tools=', (oaReq.tools || []).length);

  let upstream;
  try {
    upstream = await fetch(TARGET_URL + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(API_KEY ? { authorization: `Bearer ${API_KEY}` } : {}) },
      body: JSON.stringify(oaReq),
    });
  } catch (e) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    sse(res, { type: 'error', error: `upstream fetch failed: ${e.message}` });
    return res.end();
  }
  if (!upstream.ok || !upstream.body) {
    const errText = await upstream.text().catch(() => '');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    sse(res, { type: 'error', error: `upstream ${upstream.status}: ${errText.slice(0, 300)}` });
    return res.end();
  }

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  sse(res, { type: 'response-metadata', modelId: model, timestamp: new Date().toISOString() });

  // stream state
  let textOpen = false;
  const toolState = {}; // index -> {id, name, started, argBuf}
  let finishReason = 'stop';
  let usage = null;

  const reader = upstream.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const openText = () => { if (!textOpen) { sse(res, { type: 'text-start', id: '0' }); textOpen = true; } };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const data = t.slice(5).trim();
        if (data === '[DONE]') continue;
        let chunk;
        try { chunk = JSON.parse(data); } catch (e) { continue; }
        const choice = (chunk.choices || [])[0];
        if (chunk.usage) usage = chunk.usage;
        if (!choice) continue;
        const delta = choice.delta || {};
        if (typeof delta.content === 'string' && delta.content.length) {
          openText();
          sse(res, { type: 'text-delta', id: '0', delta: delta.content });
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            let st = toolState[idx];
            if (!st) st = toolState[idx] = { id: tc.id || `call_${idx}`, name: '', started: false, argBuf: '' };
            if (tc.id) st.id = tc.id;
            const fn = tc.function || {};
            if (fn.name) st.name += fn.name;
            if (!st.started && st.name) { sse(res, { type: 'tool-input-start', id: st.id, toolName: st.name }); st.started = true; }
            if (typeof fn.arguments === 'string' && fn.arguments.length) {
              st.argBuf += fn.arguments;
              if (st.started) sse(res, { type: 'tool-input-delta', id: st.id, delta: fn.arguments });
            }
          }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    }
  } catch (e) {
    sse(res, { type: 'error', error: `stream error: ${e.message}` });
    return res.end();
  }

  if (textOpen) sse(res, { type: 'text-end', id: '0' });
  for (const idx of Object.keys(toolState)) {
    const st = toolState[idx];
    if (!st.started) sse(res, { type: 'tool-input-start', id: st.id, toolName: st.name || 'unknown' });
    sse(res, { type: 'tool-input-end', id: st.id });
    let input = st.argBuf;
    try { input = JSON.parse(st.argBuf || '{}'); } catch (e) {}
    sse(res, { type: 'tool-call', toolCallId: st.id, toolName: st.name, input });
  }
  sse(res, {
    type: 'finish', finishReason: { unified: mapFinish(finishReason) },
    usage: usage ? { inputTokens: usage.prompt_tokens || 0, outputTokens: usage.completion_tokens || 0, totalTokens: usage.total_tokens || 0 }
                 : { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  });
  res.end();
}

// ── server ──────────────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const u = req.url || '';
  if (req.method === 'POST' && u.includes('/language-model')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => handleLanguageModel(req, res, body, req.headers).catch((e) => {
      try { res.writeHead(200, { 'content-type': 'text/event-stream' }); sse(res, { type: 'error', error: e.message }); res.end(); } catch (_) {}
    }));
    return;
  }
  if (u.includes('/models')) {
    res.setHeader('content-type', 'application/json');
    const id = MODEL_OVERRIDE || 'default';
    return res.end(JSON.stringify({ data: [{ id, object: 'model', name: id }], models: [{ id, name: id }] }));
  }
  if (u.includes('/credits')) {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ balance: 999999, credits: 999999, remaining: 999999 }));
  }
  res.setHeader('content-type', 'application/json');
  res.end('{}');
});
server.listen(PORT, '127.0.0.1', () => console.error(`[fx-any] shim on http://127.0.0.1:${PORT}  →  ${TARGET_URL}  (model: ${MODEL_OVERRIDE || 'from-fx'})`));
