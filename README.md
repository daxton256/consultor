# Consultor ✦

A self-hosted, ChatGPT-style chat app for your **local LLM** — with a twist: when the local
model doesn't know something, it quietly **searches the web** or **consults a bigger AI**
(Claude, ChatGPT, or any OpenAI-compatible API) behind the scenes, then answers using what
it learned.

- 🏠 **Runs entirely on your machine** — Node.js + plain JSON files, no database, no build step
- 💬 **ChatGPT-style UI** — sidebar with saved chats, streaming responses, markdown rendering
- 🔍 **Web search tool** — current events go to DuckDuckGo (free) or Ollama's hosted search
- 💡 **Expert consultant** — hard questions get silently escalated to Claude / ChatGPT / any
  OpenAI-compatible endpoint, with a badge showing when it happened
- 🎭 **Custom personality** — per-user instructions woven into the system prompt
- 🎨 **Two interface styles** — modern flat *and* a skeuomorphic Aero-glass look, each with
  dark & light themes
- 📱 **Installable PWA** — add it to your Android/iOS home screen as a full-screen app
- 🔑 **Access codes** — expose it to the internet safely with generated codes and a
  brute-force tarpit

## Requirements

- **Node.js 18+** (20 or 22 recommended — the app uses built-in `fetch`). No native
  dependencies, so it also runs on ARM (e.g. a Raspberry Pi).
- A local LLM server. [Ollama](https://ollama.com) works out of the box; anything with an
  OpenAI-compatible `/v1/chat/completions` endpoint (LM Studio, vLLM, llama.cpp) works too.

## Quick start

```bash
git clone <your-repo-url>
cd consultor
npm install

# grab a model if you don't have one yet
ollama pull gemma4

npm start
```

Open **http://localhost:3000**, sign up, and chat. The first account is just a signup —
there are no special admin steps.

## Configuration

Server-wide settings live in **`config.json`** next to `server.js` (created automatically
with defaults on first run):

```json
{
  "port": 3000,
  "localBaseUrl": "http://localhost:11434",
  "localModel": "gemma4:latest"
}
```

- `localBaseUrl` — your Ollama / OpenAI-compatible server. If the LLM runs on a different
  machine, put its address here (and for Ollama, set `OLLAMA_HOST=0.0.0.0` on that machine
  so it listens beyond localhost).
- `localModel` — the model every account chats with.
- `port` — listen port (`PORT` env var overrides it).

Restart the server after editing.

Everything else is per-user, in the in-app **Settings** (gear icon):

| Section | What it does |
|---|---|
| Appearance | Flat vs. skeuomorphic UI, dark vs. light theme |
| Personality | Custom instructions for how the assistant behaves |
| Web search | DuckDuckGo (free, default), Ollama web search (API key), or off |
| Expert consultant AI | Anthropic (Claude), OpenAI (ChatGPT), or any custom OpenAI-compatible endpoint + API key |

API keys are stored server-side only and never sent back to the browser.

## How the tools work

The hidden system prompt gives the local model two tags it can emit:

- `[[SEARCH: query]]` — for current events and time-sensitive questions
- `[[CONSULT: question]]` — for hard questions needing deeper expertise

The server intercepts the tag mid-stream (you never see it), runs the search or asks the
consultant AI, feeds the result back, and the model continues its answer. Messages that
used a tool get a chip (🔍 *Searched the web* / 💡 *Consulted Claude*). Thinking models
(like gemma4 via Ollama's native API) show a "Thinking…" status while they reason.

## Install on your phone (PWA)

Visit **`/install.html`** (also linked from the login screen) and tap **Install app**.

Heads-up: browsers only offer PWA installation from a **secure context** — `localhost`
counts, but plain `http://<lan-ip>:3000` doesn't. The install page detects this and
suggests fixes (Tailscale `tailscale serve 3000`, a Cloudflare Tunnel, or a Chrome flag).
Behind any HTTPS tunnel it just works.

## Exposing it to the internet

Put it behind a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
(or similar) — the tunnel makes an outbound connection, so you never open a firewall port.
Then lock it down with access codes:

```bash
node tools/access-code.js new phone     # generate a code (label optional)
node tools/access-code.js list          # see what's on file
node tools/access-code.js revoke <id>   # revoke one
node tools/access-code.js revoke all    # back to open mode
```

While at least one code exists, **every** API request requires a valid code — visitors
just get an "Access code required" screen. Each device enters its code once and remembers
it. Codes are stored hashed, take effect immediately (no restart), and wrong guesses eat a
5-second tarpit. With zero codes on file the server is open, for normal local use.

## Running as a service (Linux)

```ini
# /etc/systemd/system/consultor.service
[Unit]
Description=Consultor chat
After=network.target

[Service]
WorkingDirectory=/opt/consultor
ExecStart=/usr/bin/node server.js
Restart=always
User=youruser

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now consultor
```

Run it as a normal user that owns the app directory — the server writes to `data/`.

## Storage & backup

Everything lives in the `data/` folder as plain JSON — no database:

- `data/users.json` — accounts (scrypt password hashes) + per-user settings, including any
  consultant API keys
- `data/sessions.json` — login sessions (1-year sliding cookies)
- `data/chats/<user>.json` — chat history
- `data/access-codes.json` — hashed access codes

Back up or migrate by copying that folder. It's in `.gitignore` — **never commit it**.

## Project layout

```
server.js                  the whole backend (Express, ~600 lines)
config.json                server-wide config (auto-created, gitignored)
public/                    the web app (vanilla JS, no framework)
  index.html / app.js / style.css
  install.html             PWA installer page
  sw.js                    service worker
  manifest.webmanifest     PWA manifest
  icons/                   app icons (generated)
tools/
  access-code.js           manage access codes
  make-icons.js            regenerate the PWA icons (zero deps)
data/                      all user data (gitignored)
```
