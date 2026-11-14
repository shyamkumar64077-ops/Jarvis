#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');

const env = {};
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/['"]/g, '').split(',').map(s => s.trim()).filter(Boolean);
  });
} catch (e) {}

const PROVIDERS = {
  gemini:     { base: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'models/gemini-3.5-flash', keys: env.GEMINI_KEYS || [] },
  groq:       { base: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b', keys: env.GROQ_KEYS || [] },
  openrouter: { base: 'https://openrouter.ai/api/v1', model: 'nvidia/nemotron-3.5-super-vl:free', keys: env.OPENROUTER_KEYS || [] },
  nvidia:     { base: 'https://integrate.api.nvidia.com/v1', model: 'deepseek-ai/deepseek-coder-6.7b-instruct', keys: env.NVIDIA_KEYS || [] },
  freellmapi: { base: 'http://127.0.0.1:3002/v1', model: 'auto', keys: env.FREELLMAPI_KEYS || ['freellmapi-local'] }
};

let cursors = { gemini: 0, groq: 0, openrouter: 0, nvidia: 0, freellmapi: 0 };
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

async function chat(req, res, body) {
  const est = body.length;
  
  // EXACT ROUTING RULES REQUESTED
  const route = est > 25000 
    ? ['gemini', 'openrouter', 'freellmapi'] 
    : ['groq', 'gemini', 'nvidia'];

  for (const providerName of route) {
    const p = PROVIDERS[providerName];
    const keyData = getKey(providerName);
    if (!p || !keyData) continue;

    try {
      let payload = body;
      if (body.length) {
        try { 
          const j = JSON.parse(body.toString()); 
           
          delete j.reasoning;
          delete j.reasoning_effort; delete j.reasoning; j.model = p.model; 
          payload = Buffer.from(JSON.stringify(j)); 
        } catch {}
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);

      const up = await fetch(`${p.base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${keyData.key}` },
        body: payload,
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (up.status !== 200) {
        console.log(`[PROXY] ❌ ${providerName}#${keyData.idx} (${p.model}) -> ${up.status}`);
        if ([429, 401, 403].includes(up.status)) {
            cooldowns[`${providerName}_${keyData.idx}`] = Date.now() + 60000;
        }
        continue;
      }

      console.log(`[PROXY] ✅ ${providerName}#${keyData.idx} (${p.model}) -> 200 OK`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (up.body) {
        const reader = up.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      }
      return res.end();
    } catch (e) {
      console.log(`[PROXY] ❌ ${providerName}#${keyData.idx} -> TIMEOUT`);
      cooldowns[`${providerName}_${keyData.idx}`] = Date.now() + 60000;
    }
  }
  res.writeHead(503, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'All providers failed' } }));
}

http.createServer((req, res) => {
  if (req.url === '/_proxy/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'healthy' }));
  }
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ object: 'list', data: [{ id: 'auto', object: 'model' }] }));
  }
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => chat(req, res, Buffer.concat(chunks)).catch(e => {
    if (!res.headersSent) res.writeHead(500); res.end('Internal Error');
  }));
}).listen(4000, '127.0.0.1', () => console.log('🚀 Dynamic Super Proxy running on port 4000'));
