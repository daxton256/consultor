'use strict';
// Manage access codes for a Consultor server exposed to the internet.
//
//   node tools/access-code.js              generate a new code (optional label after)
//   node tools/access-code.js new phone    generate a new code labelled "phone"
//   node tools/access-code.js list         list codes on file (hashes only)
//   node tools/access-code.js revoke <id>  revoke one code
//   node tools/access-code.js revoke all   revoke everything (server becomes open again)
//
// Codes are stored hashed — they cannot be recovered later, only revoked.
// While at least one code exists, every API request must carry a valid code;
// with none on file the server is open (normal local use).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'access-codes.json');
const CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I, L, O, 0, 1

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return { codes: [] };
  }
}
function save(data) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}
function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

const [cmd = 'new', arg = ''] = process.argv.slice(2);
const data = load();

if (cmd === 'list') {
  if (!data.codes.length) {
    console.log('No access codes on file — the server is OPEN (no code required).');
  } else {
    console.log(`${data.codes.length} access code(s) on file — the server REQUIRES a code.\n`);
    for (const c of data.codes) {
      console.log(`  id: ${c.id}   created: ${c.createdAt.slice(0, 10)}   label: ${c.label || '(none)'}`);
    }
    console.log('\nRevoke with: node tools/access-code.js revoke <id>');
  }
} else if (cmd === 'revoke') {
  if (arg === 'all') {
    save({ codes: [] });
    console.log('All access codes revoked. The server is now OPEN (no code required).');
  } else {
    const before = data.codes.length;
    data.codes = data.codes.filter(c => c.id !== arg);
    if (data.codes.length === before) {
      console.error(`No code with id "${arg}". Use: node tools/access-code.js list`);
      process.exit(1);
    }
    save(data);
    console.log(`Code ${arg} revoked. ${data.codes.length} code(s) remain.`);
  }
} else if (cmd === 'new' || cmd) {
  const label = cmd === 'new' ? arg : cmd; // allow `access-code.js mylabel` shorthand
  let raw = '';
  for (let i = 0; i < 20; i++) raw += CHARSET[crypto.randomInt(CHARSET.length)];
  const pretty = raw.match(/.{5}/g).join('-');
  data.codes.push({
    id: crypto.randomBytes(3).toString('hex'),
    hash: sha256(raw),
    label: label || '',
    createdAt: new Date().toISOString()
  });
  save(data);
  console.log('\n  New access code' + (label ? ` (${label})` : '') + ':\n');
  console.log(`      ${pretty}\n`);
  console.log('  Paste it into the app when asked. It is stored hashed and');
  console.log('  cannot be shown again — generate another if you lose it.');
  console.log(`  Codes on file: ${data.codes.length} — the server now requires a code.\n`);
}
