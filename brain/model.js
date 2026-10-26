// One adapter for every model call. Swap the provider here and nothing else changes,
// which is what lets the whole loop later run on an open-weight model inside the company.
// `transport` defaults to fetch; in n8n pass a wrapper around this.helpers.httpRequest.

const PROVIDERS = {
  anthropic: {
    url: 'https://api.anthropic.com/v1/messages',
    headers: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }),
    body: ({ model, system, user, maxTokens }) => ({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
    text: (j) => (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(''),
    usage: (j) => ({ in: j.usage?.input_tokens || 0, out: j.usage?.output_tokens || 0 }),
  },
  // Any server that speaks the OpenAI chat-completions shape: vLLM, Ollama, llama.cpp, LM Studio.
  openaiCompatible: {
    url: process.env.LOCAL_MODEL_URL || 'http://localhost:11434/v1/chat/completions',
    headers: (key) => ({ authorization: `Bearer ${key || 'local'}`, 'content-type': 'application/json' }),
    body: ({ model, system, user, maxTokens }) => ({ model, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    text: (j) => j.choices?.[0]?.message?.content || '',
    usage: (j) => ({ in: j.usage?.prompt_tokens || 0, out: j.usage?.completion_tokens || 0 }),
  },
};

const ledger = { calls: 0, in: 0, out: 0 };

async function ask({ system, user, model = 'claude-opus-5-5', maxTokens = 4000, provider = 'anthropic', key = process.env.ANTHROPIC_API_KEY, transport = fetch, retries = 2 }) {
  const p = PROVIDERS[provider];
  for (let attempt = 0; ; attempt++) {
    const res = await transport(p.url, { method: 'POST', headers: p.headers(key), body: JSON.stringify(p.body({ model, system, user, maxTokens })) });
    const j = await res.json();
    if (res.ok) {
      const u = p.usage(j); ledger.calls++; ledger.in += u.in; ledger.out += u.out;
      return p.text(j);
    }
    if (attempt >= retries || ![429, 500, 502, 503, 529].includes(res.status)) throw new Error(`model call failed ${res.status}: ${JSON.stringify(j).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
  }
}

// Structured answer: the model must call a "submit" tool whose input is the JSON we want.
// The API guarantees the tool input is valid JSON, so no parsing of free text is needed.
async function askStructured({ system, user, schema, model = 'claude-opus-5-5', maxTokens = 6000, key = process.env.ANTHROPIC_API_KEY, transport = fetch, retries = 2 }) {
  const body = { model, max_tokens: maxTokens, system: `${system}\n\nAnswer only by calling the submit tool once. Do not write the answer as text.`, messages: [{ role: 'user', content: user }],
    tools: [{ name: 'submit', description: 'Submit your final answer. This is the only way to answer.', input_schema: schema }], tool_choice: { type: 'auto' } };
  for (let attempt = 0; ; attempt++) {
    const res = await transport(PROVIDERS.anthropic.url, { method: 'POST', headers: PROVIDERS.anthropic.headers(key), body: JSON.stringify(body) });
    const j = await res.json();
    if (res.ok) {
      const u = PROVIDERS.anthropic.usage(j); ledger.calls++; ledger.in += u.in; ledger.out += u.out;
      const t = (j.content || []).find((c) => c.type === 'tool_use');
      if (t) return t.input;
      if (attempt >= retries) throw new Error('no structured answer returned');
      continue;
    }
    if (attempt >= retries || ![429, 500, 502, 503, 529].includes(res.status)) throw new Error(`model call failed ${res.status}: ${JSON.stringify(j).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
  }
}

// Pull the first JSON object or array out of a reply
function json(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text.slice(Math.min(...['{', '['].map((c) => { const i = text.indexOf(c); return i < 0 ? Infinity : i; })));
  try { return JSON.parse(raw); } catch (e) {
    return JSON.parse(raw.trim().replace(/,\s*([}\]])/g, '$1'));
  }
}

module.exports = { ask, askStructured, json, ledger };
