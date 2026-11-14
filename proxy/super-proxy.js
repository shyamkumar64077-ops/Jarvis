#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const env = {};
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/['"]/g, '').split(',').map(s => s.trim()).filter(Boolean);
  });
} catch (e) { console.error("Failed to load .env"); }

// Per-Key Limits (RPM = Requests Per Minute per key, RPD = Requests Per Day per key)
const PROVIDERS = {
  freellmapi: { base: 'http://127.0.0.1:3002/v1', model: 'auto', keys: env.FREELLMAPI_KEYS || ['freellmapi-local'], rpm: 30, rpd: 1000 },
  gemini:     { base: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.5-flash', keys: env.GEMINI_KEYS || [], rpm: 15, rpd: 1400 },
  groq:       { base: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b', keys: env.GROQ_KEYS || [], rpm: 30, rpd: 900 },
  openrouter: { base: 'https://openrouter.ai/api/v1', model: 'nvidia/nemotron-3-ultra-550b-a55b:free', keys: env.OPENROUTER_KEYS || [], rpm: 20, rpd: 45 },
  nvidia:     { base: 'https://integrate.api.nvidia.com/v1', model: 'meta/llama-3.1-70b-instruct', keys: env.NVIDIA_KEYS || [], rpm: 30, rpd: 900 }
};

let cursors = {};
const cooldowns = {};
const usageTracker = {}; // Tracks timestamps PER KEY (e.g., groq_0, groq_1)

for (const [name, p] of Object.entries(PROVIDERS)) {
  cursors[name] = 0;
  for (let i = 0; i < p.keys.length; i++) usageTracker[`${name}_${i}`] = [];
}

function checkKeyLimits(providerName, keyIdx) {
  const p = PROVIDERS[providerName];
  const keyId = `${providerName}_${keyIdx}`;
  const now = Date.now();
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const minuteAgo = now - 60 * 1000;

  // Clean up old timestamps
  usageTracker[keyId] = usageTracker[keyId].filter(t => t > dayAgo);

  const dayCount = usageTracker[keyId].length;
  const minCount = usageTracker[keyId].filter(t => t > minuteAgo).length;

  if (dayCount >= p.rpd) return `Key daily limit (${dayCount}/${p.rpd})`;
  if (minCount >= p.rpm) return `Key minute limit (${minCount}/${p.rpm})`;
  return null;
}

function getKey(providerName) {
  const p = PROVIDERS[providerName];
  if (!p || !p.keys.length) return null;
  const now = Date.now();
  
  for (let i = 0; i < p.keys.length; i++) {
    const idx = (cursors[providerName] + i) % p.keys.length;
    const keyId = `${providerName}_${idx}`;
    
    if (cooldowns[keyId] && cooldowns[keyId] > now) continue; // Still in 429 cooldown
    if (checkKeyLimits(providerName, idx)) continue;         // Hit local quota limit
    
    cursors[providerName] = (idx + 1) % p.keys.length;
    return { key: p.keys[idx], idx: idx, keyId: keyId };
  }
  return null;
}

async function chat(req, res, body) {
  const est = body.length;
  
  const route = est > 20000 
    ? ['gemini', 'openrouter', 'nvidia', 'freellmapi'] 
    : ['groq', 'gemini', 'openrouter', 'nvidia', 'freellmapi'];

  for (const providerName of route) {
    const p = PROVIDERS[providerName];
    const keyData = getKey(providerName);
    if (!p || !keyData) continue;

    try {
      let payload = body;
      if (body.length) {
        try { 
          const j = JSON.parse(body.toString()); 
          delete j.reasoning_effort; delete j.reasoning; delete j.reasoning_content;
          if (j.messages) {
            j.messages.forEach(m => {
              delete m.reasoning; delete m.reasoning_content;
              if (m.content === "" && m.tool_calls) delete m.tool_calls;
            });
          }
          j.model = p.model; 
          payload = Buffer.from(JSON.stringify(j)); 
        } catch {}
      }

      // RESERVE THE SLOT BEFORE FETCHING (Atomic lock)
      usageTracker[keyData.keyId].push(Date.now());

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 45000);

      const up = await fetch(`${p.base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${keyData.key}` },
        body: payload,
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (up.status !== 200) {
        console.log(`[PROXY] ❌ ${keyData.keyId} (${p.model}) -> ${up.status}`);
        if ([429, 401, 403].includes(up.status)) {
            cooldowns[keyData.keyId] = Date.now() + 60000;
        }
        continue; 
      }

      console.log(`[PROXY] ✅ ${keyData.keyId} (${p.model}) -> 200 OK`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (up.body) {
        Readable.fromWeb(up.body).pipe(res);
      } else {
        res.end();
      }
      return;

    } catch (e) {
      console.log(`[PROXY] ❌ ${keyData.keyId} -> TIMEOUT`);
      cooldowns[keyData.keyId] = Date.now() + 60000;
    }
  }
  
  res.writeHead(503, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'All providers failed or limits reached.' } }));
}

http.createServer((req, res) => {
  if (req.url === '/_proxy/status' || req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'healthy', data: [{ id: 'auto' }] }));
  }
  if (req.url === '/quota') {
    const now = Date.now();
    const minuteAgo = now - 60 * 1000;
    const stats = {};
    for (const [name, p] of Object.entries(PROVIDERS)) {
      let totalMin = 0, totalDay = 0;
      for (let i = 0; i < p.keys.length; i++) {
        const keyId = `${name}_${i}`;
        const min = usageTracker[keyId].filter(t => t > minuteAgo).length;
        totalMin += min;
        totalDay += usageTracker[keyId].length;
      }
      stats[name] = { 
        total_rpm: `${totalMin}/${p.rpm * p.keys.length}`, 
        total_rpd: `${totalDay}/${p.rpd * p.keys.length}`
      };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(stats, null, 2));
  }
  
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => chat(req, res, Buffer.concat(chunks)).catch(e => {
    if (!res.headersSent) res.writeHead(500); res.end('Internal Error');
  }));
}).listen(4000, '127.0.0.1', () => {
  console.log('🚀 Per-Key Quota Super Proxy running on port 4000');
  const loaded = {};
  for (const [name, p] of Object.entries(PROVIDERS)) loaded[name] = p.keys.length;
  console.log('🔑 Loaded Keys:', loaded);
  console.log('🔥 Total RPM Capacity: ~630 RPM');
});
