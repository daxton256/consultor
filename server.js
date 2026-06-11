'use strict';

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Server-wide config (config.json next to server.js) — created with defaults
// on first run. Restart the server after editing it.
// ---------------------------------------------------------------------------
const CONFIG_FILE = path.join(__dirname, 'config.json');
const DEFAULT_CONFIG = {
  port: 3000,
  localBaseUrl: 'http://localhost:11434',
  localModel: 'gemma4:latest'
};
let CONFIG = DEFAULT_CONFIG;
try {
  CONFIG = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
} catch {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2));
}

const PORT = process.env.PORT || CONFIG.port;
const DATA_DIR = path.join(__dirname, 'data');
const CHATS_DIR = path.join(DATA_DIR, 'chats');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

fs.mkdirSync(CHATS_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Tiny JSON file store
// ---------------------------------------------------------------------------
function readJson(file, fallback) {
  try {
    // strip a UTF-8 BOM if present — files edited by other tools (notably
    // Windows PowerShell) may carry one, and JSON.parse rejects it
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`WARNING: could not read ${file} (${err.message}) — using fallback. ` +
        'Refusing to silently lose data is better than this; check the file!');
    }
    return fallback;
  }
}
function writeJson(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

let users = readJson(USERS_FILE, {});
let sessions = readJson(SESSIONS_FILE, {});
const saveUsers = () => writeJson(USERS_FILE, users);
const saveSessions = () => writeJson(SESSIONS_FILE, sessions);

function chatFile(username) {
  // usernames are restricted to [a-z0-9_-], safe as a filename
  return path.join(CHATS_DIR, username + '.json');
}
function loadChats(username) {
  return readJson(chatFile(username), { chats: [] });
}
function saveChats(username, data) {
  writeJson(chatFile(username), data);
}

// ---------------------------------------------------------------------------
// Auth helpers (scrypt, no external deps)
// ---------------------------------------------------------------------------
function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, expectedHash) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(expectedHash, 'hex'));
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 365; // 1 year, renewed on every visit

function sessionCookie(token, maxAge) {
  return `session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function authMiddleware(req, res, next) {
  const token = parseCookies(req).session;
  const sess = token && sessions[token];
  if (!sess || !users[sess.username]) {
    return res.status(401).json({ error: 'Not logged in' });
  }
  req.username = sess.username;
  req.user = users[sess.username];
  req.sessionToken = token;
  next();
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
const DEFAULT_SETTINGS = {
  persona: '',
  consultant: { provider: 'none', baseUrl: '', apiKey: '', model: '' },
  webSearch: { provider: 'duckduckgo', apiKey: '' }, // 'duckduckgo' | 'ollama' | 'none'
  uiStyle: 'flat', // 'flat' | 'skeuo'
  theme: 'dark' // 'dark' | 'light'
};

function getSettings(user) {
  const s = user.settings || {};
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    consultant: { ...DEFAULT_SETTINGS.consultant, ...(s.consultant || {}) },
    webSearch: { ...DEFAULT_SETTINGS.webSearch, ...(s.webSearch || {}) },
    // the local model is configured server-wide in config.json, not per user
    localBaseUrl: CONFIG.localBaseUrl,
    localModel: CONFIG.localModel
  };
}

function consultantDisplayName(c) {
  if (c.provider === 'anthropic') return 'Claude';
  if (c.provider === 'openai') return 'ChatGPT';
  if (c.provider === 'custom') return c.model || 'an external expert AI';
  return null;
}

function buildSystemPrompt(settings) {
  const lines = [];
  lines.push(
    'You are a helpful, knowledgeable AI assistant in a chat application. ' +
    'Answer clearly and conversationally. Use Markdown formatting (code blocks, lists, bold) when it helps readability.'
  );
  if (settings.persona && settings.persona.trim()) {
    lines.push('');
    lines.push('The user has given you the following custom instructions about how to behave. Follow them:');
    lines.push(settings.persona.trim());
  }
  const c = settings.consultant;
  const name = consultantDisplayName(c);
  const canConsult = !!(name && c.apiKey);
  const canSearch = settings.webSearch.provider !== 'none';
  if (canSearch || canConsult) {
    lines.push('');
    lines.push(
      'IMPORTANT — tools: When you do not know something, do NOT guess or make things up. ' +
      'You have the following tools. To use one, output EXACTLY its tag on a single line and nothing else:'
    );
    if (canSearch) {
      lines.push(
        '- Web search: [[SEARCH: <search query>]] — use this for current events, news, weather, prices, sports, ' +
        'recent product or software releases, "latest" anything, and ANY time-sensitive question whose answer may have changed since your training data.'
      );
    }
    if (canConsult) {
      lines.push(
        `- Expert AI (${name}): [[CONSULT: <a clear, self-contained request>]] — use this for tasks the expert handles better than you, ` +
        'not just facts you lack: writing or debugging non-trivial code, complex math, tricky algorithms, detailed technical designs, ' +
        'and questions needing deep expertise or obscure knowledge. If a task is hard and the expert would likely do a noticeably better job, ' +
        'consult rather than struggle through alone. The expert cannot see this conversation, so put ALL relevant context ' +
        `(the code, the error message, the user's requirements) inside the request itself.${canSearch ? ' Do NOT use it for current events or time-sensitive facts — use web search for those.' : ''}`
      );
    }
    lines.push(
      'You will then receive the results and must use them to give the user a complete, accurate answer in your own words. ' +
      'Only use a tool when genuinely needed — answer directly when you already know. If a tool fails and you still do not know, say so honestly. ' +
      'Never show the [[...]] tag syntax to the user or mention these mechanisms unless the user explicitly asks how you work.'
    );
    if (canSearch) {
      lines.push(
        'Never tell the user to check a website, look it up, or search for themselves — that is your job: use the web search tool and give them the answer directly.'
      );
    }
  } else {
    lines.push('');
    lines.push('If you do not know something or are unsure, say so honestly instead of guessing.');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// LLM backends
// ---------------------------------------------------------------------------

// Stream a chat completion from the local LLM server. Tries Ollama's native
// /api/chat first — "thinking" models (like gemma4) put their reasoning in a
// separate channel there, which we surface as a "Thinking…" status instead of
// chat text. Falls back to the OpenAI-compatible endpoint for non-Ollama
// servers (LM Studio, vLLM, llama.cpp, …).
// onDelta(text, fullSoFar) is called for each content chunk; onThinking() for
// each reasoning chunk; resolves with the full content text.
async function streamLocalCompletion(settings, messages, onDelta, onThinking) {
  const base = settings.localBaseUrl.replace(/\/+$/, '');
  let full = '';

  let native = null;
  try {
    native = await fetch(base + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: settings.localModel, messages, stream: true })
    });
  } catch {
    native = null;
  }

  if (native && native.ok) {
    // native Ollama stream: newline-delimited JSON objects
    const reader = native.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let json;
        try {
          json = JSON.parse(line);
        } catch {
          continue;
        }
        if (json.error) throw new Error('Local LLM server error: ' + json.error);
        if (json.message?.thinking && onThinking) onThinking();
        const delta = json.message?.content || '';
        if (delta) {
          full += delta;
          onDelta(delta, full);
        }
      }
    }
    return full;
  }

  const resp = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: settings.localModel, messages, stream: true })
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Local LLM server returned ${resp.status}: ${body.slice(0, 300)}`);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        const d = json.choices?.[0]?.delta || {};
        if ((d.reasoning || d.reasoning_content) && onThinking) onThinking();
        const delta = d.content || '';
        if (delta) {
          full += delta;
          onDelta(delta, full);
        }
      } catch { /* ignore malformed chunks */ }
    }
  }
  return full;
}

// One-shot call to the configured consultant AI. Returns answer text.
async function callConsultant(consultant, question) {
  const c = consultant;
  if (c.provider === 'anthropic') {
    const base = (c.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
    const resp = await fetch(base + '/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': c.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: c.model || 'claude-sonnet-4-6',
        max_tokens: 2048,
        messages: [{ role: 'user', content: question }]
      })
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Anthropic API error ${resp.status}: ${body.slice(0, 300)}`);
    }
    const json = await resp.json();
    return (json.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  }
  // openai and custom both speak the OpenAI chat completions protocol
  const base = (c.baseUrl || (c.provider === 'openai' ? 'https://api.openai.com' : '')).replace(/\/+$/, '');
  if (!base) throw new Error('Consultant base URL is not configured.');
  const resp = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + c.apiKey
    },
    body: JSON.stringify({
      model: c.model || 'gpt-4o',
      messages: [{ role: 'user', content: question }]
    })
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Consultant API error ${resp.status}: ${body.slice(0, 300)}`);
  }
  const json = await resp.json();
  return json.choices?.[0]?.message?.content || '';
}

// ---------------------------------------------------------------------------
// Web search
// ---------------------------------------------------------------------------
function stripHtml(s) {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Returns formatted results text for the model.
async function webSearch(ws, query) {
  let results;
  if (ws.provider === 'ollama') {
    const resp = await fetch('https://ollama.com/api/web_search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + ws.apiKey
      },
      body: JSON.stringify({ query, max_results: 5 })
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Ollama web search error ${resp.status}: ${body.slice(0, 200)}`);
    }
    const json = await resp.json();
    results = (json.results || []).map(r => ({
      title: r.title || r.url,
      url: r.url,
      snippet: (r.content || '').slice(0, 600)
    }));
  } else {
    // DuckDuckGo HTML endpoint — free, no API key
    const resp = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
      }
    });
    if (!resp.ok) throw new Error('DuckDuckGo returned ' + resp.status);
    const html = await resp.text();
    results = [];
    const blockRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
    let m;
    while (results.length < 5 && (m = blockRe.exec(html)) !== null) {
      let url = m[1];
      const uddg = /[?&]uddg=([^&]+)/.exec(url);
      if (uddg) url = decodeURIComponent(uddg[1]);
      if (url.includes('duckduckgo.com/y.js')) continue; // skip ads
      results.push({ title: stripHtml(m[2]), url, snippet: stripHtml(m[3] || '') });
    }
  }
  if (!results.length) return null;
  return results
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? '\n   ' + r.snippet : ''}`)
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---- access codes (for internet-exposed servers) ----
// Managed with `node tools/access-code.js`. While at least one code exists,
// every API request must carry a valid code in the x-access-code header;
// with none on file the server is open (normal local use). Static files stay
// public — they're just the login shell.
const ACCESS_FILE = path.join(DATA_DIR, 'access-codes.json');

function normalizeAccessCode(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

app.use('/api', async (req, res, next) => {
  const codes = readJson(ACCESS_FILE, { codes: [] }).codes;
  if (!codes.length) return next();
  const raw = normalizeAccessCode(req.headers['x-access-code']);
  const supplied = sha256(raw);
  for (const c of codes) {
    try {
      if (crypto.timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(c.hash, 'hex'))) return next();
    } catch { /* malformed stored hash — treat as no match */ }
  }
  // Wrong guesses eat a 5-second tarpit to make brute-forcing hopeless.
  // No code at all (a first visit) fails fast so the gate screen shows instantly.
  if (raw) await new Promise(resolve => setTimeout(resolve, 5000));
  res.status(403).json({ error: 'access_code_required' });
});

// ---- auth ----
app.post('/api/signup', (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || !/^[a-z0-9_-]{3,32}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-32 chars: lowercase letters, numbers, - or _' });
  }
  if (typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  if (users[username]) {
    return res.status(409).json({ error: 'That username is already taken' });
  }
  const { salt, hash } = hashPassword(password);
  users[username] = { salt, hash, settings: { ...DEFAULT_SETTINGS }, createdAt: new Date().toISOString() };
  saveUsers();
  startSession(res, username);
  res.json({ ok: true, username });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = typeof username === 'string' ? users[username] : null;
  if (!user || typeof password !== 'string' || !verifyPassword(password, user.salt, user.hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  startSession(res, username);
  res.json({ ok: true, username });
});

function startSession(res, username) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions[token] = { username, createdAt: new Date().toISOString() };
  saveSessions();
  res.setHeader('Set-Cookie', sessionCookie(token, SESSION_TTL_SECONDS));
}

app.post('/api/logout', (req, res) => {
  const token = parseCookies(req).session;
  if (token) {
    delete sessions[token];
    saveSessions();
  }
  res.setHeader('Set-Cookie', 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', authMiddleware, (req, res) => {
  // sliding expiration: every visit renews the cookie for another year
  res.setHeader('Set-Cookie', sessionCookie(req.sessionToken, SESSION_TTL_SECONDS));
  const settings = getSettings(req.user);
  res.json({ username: req.username, settings: redactSettings(settings) });
});

// Never send the raw API key back to the browser; send a placeholder flag.
function redactSettings(settings) {
  const out = JSON.parse(JSON.stringify(settings));
  out.consultant.hasApiKey = !!out.consultant.apiKey;
  delete out.consultant.apiKey;
  out.webSearch.hasApiKey = !!out.webSearch.apiKey;
  delete out.webSearch.apiKey;
  return out;
}

// ---- settings ----
app.put('/api/settings', authMiddleware, (req, res) => {
  const cur = getSettings(req.user);
  const b = req.body || {};
  const next = { ...cur };
  if (typeof b.persona === 'string') next.persona = b.persona.slice(0, 8000);
  if (['flat', 'skeuo'].includes(b.uiStyle)) next.uiStyle = b.uiStyle;
  if (['dark', 'light'].includes(b.theme)) next.theme = b.theme;
  if (b.consultant && typeof b.consultant === 'object') {
    const c = b.consultant;
    const nc = { ...cur.consultant };
    if (['none', 'anthropic', 'openai', 'custom'].includes(c.provider)) nc.provider = c.provider;
    if (typeof c.baseUrl === 'string') nc.baseUrl = c.baseUrl.trim();
    if (typeof c.model === 'string') nc.model = c.model.trim();
    // empty string means "keep existing key"; the client sends a value only when changed
    if (typeof c.apiKey === 'string' && c.apiKey !== '') nc.apiKey = c.apiKey.trim();
    if (c.clearApiKey === true) nc.apiKey = '';
    next.consultant = nc;
  }
  if (b.webSearch && typeof b.webSearch === 'object') {
    const w = b.webSearch;
    const nw = { ...cur.webSearch };
    if (['none', 'duckduckgo', 'ollama'].includes(w.provider)) nw.provider = w.provider;
    if (typeof w.apiKey === 'string' && w.apiKey !== '') nw.apiKey = w.apiKey.trim();
    if (w.clearApiKey === true) nw.apiKey = '';
    next.webSearch = nw;
  }
  req.user.settings = next;
  saveUsers();
  res.json({ ok: true, settings: redactSettings(next) });
});

// ---- chats ----
app.get('/api/chats', authMiddleware, (req, res) => {
  const data = loadChats(req.username);
  res.json({
    chats: data.chats
      .map(c => ({ id: c.id, title: c.title, updatedAt: c.updatedAt }))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  });
});

app.post('/api/chats', authMiddleware, (req, res) => {
  const data = loadChats(req.username);
  const chat = {
    id: crypto.randomUUID(),
    title: 'New chat',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: []
  };
  data.chats.push(chat);
  saveChats(req.username, data);
  res.json({ chat: { id: chat.id, title: chat.title, updatedAt: chat.updatedAt } });
});

app.get('/api/chats/:id', authMiddleware, (req, res) => {
  const data = loadChats(req.username);
  const chat = data.chats.find(c => c.id === req.params.id);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  res.json({ chat });
});

app.delete('/api/chats/:id', authMiddleware, (req, res) => {
  const data = loadChats(req.username);
  const before = data.chats.length;
  data.chats = data.chats.filter(c => c.id !== req.params.id);
  if (data.chats.length === before) return res.status(404).json({ error: 'Chat not found' });
  saveChats(req.username, data);
  res.json({ ok: true });
});

app.patch('/api/chats/:id', authMiddleware, (req, res) => {
  const data = loadChats(req.username);
  const chat = data.chats.find(c => c.id === req.params.id);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  if (typeof req.body?.title === 'string' && req.body.title.trim()) {
    chat.title = req.body.title.trim().slice(0, 80);
    chat.updatedAt = new Date().toISOString();
    saveChats(req.username, data);
  }
  res.json({ ok: true, chat: { id: chat.id, title: chat.title } });
});

// ---- the main event: send a message, stream the reply ----
const TOOL_TAGS = { '[[SEARCH:': 'search', '[[CONSULT:': 'consult' };
const TAG_STRINGS = Object.keys(TOOL_TAGS);
const MAX_TAG_LEN = Math.max(...TAG_STRINGS.map(t => t.length));

function findEarliestTag(text, from) {
  let best = null;
  for (const tag of TAG_STRINGS) {
    const index = text.indexOf(tag, from);
    if (index !== -1 && (!best || index < best.index)) best = { index, tag };
  }
  return best;
}

app.post('/api/chats/:id/messages', authMiddleware, async (req, res) => {
  const content = (req.body?.content || '').toString();
  if (!content.trim()) return res.status(400).json({ error: 'Empty message' });

  const data = loadChats(req.username);
  const chat = data.chats.find(c => c.id === req.params.id);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });

  const settings = getSettings(req.user);

  // record the user message immediately
  chat.messages.push({ role: 'user', content, at: new Date().toISOString() });
  if (chat.title === 'New chat') {
    chat.title = content.trim().replace(/\s+/g, ' ').slice(0, 48) || 'New chat';
  }
  chat.updatedAt = new Date().toISOString();
  saveChats(req.username, data);

  // SSE response
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  const send = ev => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  send({ type: 'meta', title: chat.title });

  const systemPrompt = buildSystemPrompt(settings);
  const history = chat.messages.map(m => ({ role: m.role, content: m.content }));
  const llmMessages = [{ role: 'system', content: systemPrompt }, ...history];

  const consulted = []; // names of AIs consulted, for the UI badge
  const searched = []; // web search queries run, for the UI badge
  let finalText = '';

  try {
    let messages = llmMessages;
    const maxRounds = 4; // initial + up to 3 tool uses (search and/or consult)
    for (let round = 0; round < maxRounds; round++) {
      const result = await streamWithToolDetection(settings, messages, send);
      // anything streamed so far stays visible — accumulate it
      finalText += result.text;
      if (!result.tool) break;

      const continueNote =
        ' Continue your reply where it left off — everything you already wrote is still visible to the user, so do not repeat it. Do not output the [[...]] tag syntax again.';
      let note;

      if (result.tool === 'search') {
        if (settings.webSearch.provider === 'none' || round === maxRounds - 1) {
          note = '[system note] Web search is unavailable right now. Answer as best you can yourself and be honest about any uncertainty.' + continueNote;
        } else {
          send({ type: 'status', text: `Searching the web for “${result.payload}”…` });
          let found = null;
          try {
            found = await webSearch(settings.webSearch, result.payload);
            if (found) searched.push(result.payload);
          } catch (err) {
            send({ type: 'status', text: `Web search failed (${err.message}). Answering directly…` });
          }
          note = found
            ? `[system note] Web search results for "${result.payload}":\n\n${found}\n\nUse these results to give the user a complete, accurate, up-to-date answer. Cite or mention sources where it helps.` + continueNote
            : '[system note] The web search returned no results. Answer as best you can yourself and be honest about any uncertainty.' + continueNote;
        }
      } else {
        // model wants to consult the expert AI
        const name = consultantDisplayName(settings.consultant) || 'the expert AI';
        if (!settings.consultant.apiKey || settings.consultant.provider === 'none' || round === maxRounds - 1) {
          note = '[system note] The expert AI is unavailable right now. Answer as best you can yourself and be honest about any uncertainty.' + continueNote;
        } else {
          send({ type: 'status', text: `Consulting ${name}…` });
          let answer = null;
          try {
            answer = await callConsultant(settings.consultant, result.payload);
            consulted.push(name);
          } catch (err) {
            send({ type: 'status', text: `Could not reach ${name} (${err.message}). Answering directly…` });
          }
          note = answer
            ? `[system note] ${name} was consulted and replied:\n\n${answer}\n\nNow use this to give the user a complete, accurate answer in your own words.` + continueNote
            : '[system note] The consultation failed. Answer as best you can yourself and be honest about any uncertainty.' + continueNote;
        }
      }

      messages = [
        ...messages,
        { role: 'assistant', content: result.raw },
        { role: 'user', content: note }
      ];
      // separate the kept partial text from the continuation
      if (finalText.trim()) {
        send({ type: 'delta', text: '\n\n' });
        finalText += '\n\n';
      }
    }

    chat.messages.push({
      role: 'assistant',
      content: finalText,
      at: new Date().toISOString(),
      ...(consulted.length ? { consulted } : {}),
      ...(searched.length ? { searched } : {})
    });
    chat.updatedAt = new Date().toISOString();
    saveChats(req.username, data);
    send({ type: 'done', consulted, searched });
  } catch (err) {
    send({ type: 'error', message: err.message });
  }
  res.end();
});

// Streams one local-LLM completion, forwarding deltas to the client but holding
// back anything that might be the start of a [[SEARCH: ...]] or [[CONSULT: ...]]
// tag. Returns { text, raw, tool, payload } — tool is null when no tag was emitted.
async function streamWithToolDetection(settings, messages, send) {
  let full = '';
  let emitted = 0;
  let tagFound = false;

  const flush = () => {
    if (tagFound) return;
    const found = findEarliestTag(full, Math.max(0, emitted - MAX_TAG_LEN));
    if (found) {
      tagFound = true;
      const visible = full.slice(emitted, found.index);
      if (visible) send({ type: 'delta', text: visible });
      emitted = found.index;
      return;
    }
    // hold back a suffix that could be the beginning of a tag
    let hold = 0;
    for (let k = Math.min(MAX_TAG_LEN - 1, full.length - emitted); k > 0; k--) {
      const suffix = full.slice(full.length - k);
      if (TAG_STRINGS.some(t => t.startsWith(suffix))) {
        hold = k;
        break;
      }
    }
    const upto = full.length - hold;
    if (upto > emitted) {
      send({ type: 'delta', text: full.slice(emitted, upto) });
      emitted = upto;
    }
  };

  let announcedThinking = false;
  await streamLocalCompletion(
    settings,
    messages,
    (_delta, soFar) => {
      full = soFar;
      flush();
    },
    () => {
      if (!announcedThinking) {
        announcedThinking = true;
        send({ type: 'status', text: 'Thinking…' });
      }
    }
  );

  if (!tagFound) {
    // emit whatever was held back at the end
    if (emitted < full.length) send({ type: 'delta', text: full.slice(emitted) });
    return { text: full, raw: full, tool: null, payload: null };
  }

  const found = findEarliestTag(full, 0);
  const after = full.slice(found.index + found.tag.length);
  const end = after.indexOf(']]');
  const payload = (end === -1 ? after : after.slice(0, end)).trim();
  return {
    text: full.slice(0, found.index).trim(),
    raw: full,
    tool: TOOL_TAGS[found.tag],
    payload: payload || 'No query provided.'
  };
}

app.listen(PORT, () => {
  console.log(`Consultor running at http://localhost:${PORT}`);
});
