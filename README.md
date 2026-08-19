# fx-any — run Vercel `fx` on **any** standards-based endpoint

A ~230-line local shim that lets Vercel's [`fx`](https://github.com/vercel-labs/fx) coding-agent CLI talk
to **any OpenAI-compatible endpoint** — llama.cpp server, Ollama, LM Studio, vLLM, OpenRouter, OpenAI —
instead of being locked to the Vercel AI Gateway. Proven end-to-end (streaming text, a real local
llama.cpp model, and a full tool-call round-trip).

## Important: this is a *shim*, not a fork
**fx's source is not modified.** We run the stock `fx` binary and sit a translation proxy in front of it,
using fx's **own** built-in loopback override. That means it **survives fx updates** and needs no Zig
recompile. (fx is written in Zig and only ships as a binary; the source is Apache-2.0 on GitHub — we
cloned it read-only to learn the wire protocol, nothing more.)

## Why this is needed
fx is hard-wired to `https://ai-gateway.vercel.sh`. Its config exposes **no** custom base-URL, no
OpenAI-compatible key, no local-model support — every credential path routes through Vercel's gateway.
That's a **monetization choice, not a technical limit**. This shim adds the standards compliance Vercel
left out.

## How it works
1. **The seam.** fx honors three *loopback-gated* env vars (from `src/gateway/client.zig`,
   `resolveE2eGatewayUrl`): `FX_E2E_GATEWAY_CHAT_URL`, `FX_E2E_GATEWAY_MODELS_URL`,
   `FX_E2E_GATEWAY_CREDITS_URL`. Point them at `http://127.0.0.1:PORT/...` and set a dummy
   `AI_GATEWAY_API_KEY`, and fx sends its requests to **us**.
2. **The translation.** fx speaks Vercel's **AI SDK LanguageModelV2** protocol
   (`POST /v3/ai/language-model`). The shim translates it to/from the OpenAI `/v1/chat/completions`
   shape — the lingua franca that llama.cpp/Ollama/vLLM/LM Studio/OpenRouter/OpenAI all speak.

```
 fx ──(LanguageModelV2)──▶ fx-any shim ──(OpenAI /v1/chat/completions)──▶ any endpoint
    ◀──(v2 SSE parts)─────            ◀──(OpenAI SSE)──────────────────
```

### Request mapping (fx → OpenAI)
| fx (LanguageModelV2) | OpenAI |
|---|---|
| `prompt: [{role, content:[{type:'text',text}] }]` | `messages` |
| assistant `{type:'tool-call', toolCallId, toolName, input}` | `tool_calls` |
| tool `{type:'tool-result', toolCallId, output}` | `role:'tool'` message |
| `tools: [{type:'function', name, description, inputSchema}]` | `tools: [{type:'function', function:{name,description,parameters}}]` |
| `toolChoice: {type}` | `tool_choice` |
| header `ai-language-model-id` | `model` (overridable) |

### Response mapping (OpenAI SSE → fx v2 stream parts)
Emitted as `data: {json}\n\n`: `response-metadata` → `text-start`/`text-delta`/`text-end` →
(`tool-input-start`/`tool-input-delta`/`tool-input-end`/`tool-call`) → `finish`.

> **The one non-obvious gotcha:** fx's parser requires `finish.finishReason` to be an **object**
> `{ "unified": "<v>" }` (not a string). Valid values: `stop | length | content-filter | tool-calls |
> error | other`.

## Run it
```bash
# 1) start the shim, pointed at your endpoint
FXANY_TARGET_URL=http://127.0.0.1:8080/v1 \   # llama.cpp / Ollama / vLLM / OpenRouter / OpenAI
FXANY_API_KEY=sk-...            \             # blank for local servers
FXANY_MODEL=your-model          \             # overrides fx's model id
node server.js                                # listens on 127.0.0.1:8899

# 2) run fx against the shim
AI_GATEWAY_API_KEY=dummy \
FX_E2E_GATEWAY_CHAT_URL=http://127.0.0.1:8899/v3/ai/language-model \
FX_E2E_GATEWAY_MODELS_URL=http://127.0.0.1:8899/coding-agent/v1/models \
FX_E2E_GATEWAY_CREDITS_URL=http://127.0.0.1:8899/coding-agent/v1/credits \
FX_MODEL=your-model fx ask "hello"
```

### Env / config
| var | meaning |
|---|---|
| `FXANY_TARGET_URL` | base URL of the OpenAI-compatible endpoint (default `http://127.0.0.1:8080/v1`) |
| `FXANY_API_KEY` | bearer key for the target (blank OK for local) |
| `FXANY_MODEL` | model id to send upstream (overrides fx's) |
| `FXANY_PORT` | shim listen port (default `8899`) |
| `FXANY_DEBUG=1` | log each upstream call |
| `FXANY_STRIP_TOOLS=1` | test aid — drop tools to shrink the prompt for very small models |

## Files
- **`server.js`** — the shim (the whole thing).
- `mock-openai.js` — canned OpenAI SSE, for key-less validation of the translation.
- `mock-tools.js` — two-turn mock that requests a tool, to validate the full tool round-trip.
- `capture.js` — logging proxy used to reverse-engineer fx's protocol.

## Proven
- **Streaming text:** fx rendered a full reply routed through the shim.
- **Real local model:** `fx → shim → llama.cpp (Qwen2.5-0.5B)` → *"Hi there! My name is FX…"* — no Vercel, no key.
- **Tool round-trip:** model requests `read_file` → **fx executes it** → result fed back → model answers. Full coding-agent loop.

## Roadmap
`fx-any` one-command wrapper (sets env + launches shim + fx) · Anthropic Messages adapter (Claude API
shape, not just OpenAI) · config file for target/model/key · streaming reasoning passthrough.

*Built as a clean-room shim from fx's public Apache-2.0 protocol. No fx code redistributed.*
