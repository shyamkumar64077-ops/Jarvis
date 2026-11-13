#!/usr/bin/env node
const http = require('http');

const splitKeys = (v) => (v || '').split(',').map(s => s.trim()).filter(Boolean);

const PROVIDERS = {
  gemini:     { base: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.5-flash', keys: splitKeys(process.env.GEMINI_KEYS) },
  groq:       { base: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b', keys: splitKeys(process.env.GROQ_KEYS) },
  openrouter: { base: 'https://openrouter.ai/api/v1', model: 'nvidia/nemotron-3.5-super-vl:free', keys: splitKeys(process.env.OPENROUTER_KEYS) },
  freellmapi: { base: 'http://127.0.0.1:3001/v1', model: 'auto', keys: splitKeys(process.env.FREELLMAPI_KEYS || 'freellmapi-local') }
};

let cursors = { gemini: 0, groq: 0, openrouter: 0, freellmapi: 0 };
const cooldowns = {};

function getKey(provider) {
  const p = PROVIDERS[provider];
  if (!p || !p.keys.length) return null;
  const now = Date.now();
  for (let i = 0; i < p.keys.length; i++) {
    const idx = (cursors[provider] + i) % p.keys.length;
    const cKey = `${provider}_${idx}`;
    if (!cooldowns[cKey] || cooldowns[cKey] < now) {
      cursors[provider] = (idx + 1) % p.keys.length;
      return { key: p.keys[idx], idx: idx };
    }
  }
  return null;
}

function estTokens(messages) {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

function stripReasoning(payload) {
  if (payload && typeof payload === 'object') {
    delete payload.reasoning_effort;
    delete payload.reasoning;
  }
  return payload;
}

async function tryProvider(providerName, payload, keyData) {
  const p = PROVIDERS[providerName];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const up = await fetch(`${p.base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${keyData.key}` },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timeout);
    return { provider: providerName, status: up.status, ok: up.status === 200, response: up };
  } catch (e) {
    clearTimeout(timeout);
    return { provider: providerName, status: 'TIMEOUT', ok: false, response: null };
  }
}

async function chat(req, res, body) {
  let j;
  try { j = JSON.parse(body.toString()); } catch { j = {}; }
  const messages = j.messages || [];
  const est = estTokens(messages);

  let primary, fallback;
  if (est < 10000) {
    primary = 'groq';
    fallback = 'openrouter';
  } else {
    primary = 'gemini';
    fallback = 'freellmapi';
  }

  console.log(`[PROXY] route=${primary} est_tokens=${est}`);

  const tryOnce = async (providerName) => {
    const keyData = getKey(providerName);
    if (!keyData) return null;
    const p = PROVIDERS[providerName];
    const payload = stripReasoning({ ...j, model: p.model });
    const result = await tryProvider(providerName, payload, keyData);
    console.log(`[PROXY] route=${providerName} est_tokens=${est} status=${result.status}`);
    return result.ok ? result : null;
  };

  let result = await tryOnce(primary);
  if (!result) {
    result = await tryOnce(fallback);
  }

  if (result && result.response) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const reader = result.response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    return res.end();
  }

  res.writeHead(503, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'All providers failed' } }));
}

http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'healthy' }));
  }
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => chat(req, res, Buffer.concat(chunks)).catch(e => {
    if (!res.headersSent) res.writeHead(500); res.end('Internal Error');
  }));
}).listen(4000, '127.0.0.1', () => console.log('🚀 Proxy running on 127.0.0.1:4000'));
