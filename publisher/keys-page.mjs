import { CLIENT_SCOPES } from './keys.mjs';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[ch]);
}

function when(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function shell(title, inner) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
</head>
<body>
${inner}
</body>
</html>`;
}

const OWNER_FIELD = '<label>Owner code <input type="password" name="bootstrap" autocomplete="off" required></label>';

const CLIENT_LABEL = {
  'grok-bot': 'full HQ read and write',
  claude: 'full HQ read and write',
  instinct: 'research status and research read only'
};

function issueForm() {
  const options = Object.keys(CLIENT_SCOPES).map((client) =>
    `<option value="${escapeHtml(client)}">${escapeHtml(client)} — ${escapeHtml(CLIENT_LABEL[client] || CLIENT_SCOPES[client].join(', '))}</option>`
  ).join('');
  return `<form method="post" action="/publisher/keys" autocomplete="off">
<input type="hidden" name="action" value="issue">
<p><label>Client <select name="client" required>${options}</select></label></p>
<p><label>Label (optional) <input type="text" name="label" maxlength="80" autocomplete="off"></label></p>
<p>${OWNER_FIELD}</p>
<button type="submit">Create key</button>
</form>
<form method="post" action="/publisher/keys" autocomplete="off">
<input type="hidden" name="action" value="list">
<p>${OWNER_FIELD}</p>
<button type="submit">Show existing keys</button>
</form>`;
}

export function keysHomePage() {
  return shell('HQ publisher keys', `<h1>HQ publisher keys</h1>
<p>Owner only. A key lets one client use the HQ research publisher at /mcp with an <code>Authorization: Bearer</code> header. Each key lasts 90 days and can be revoked here at any time.</p>
<p>Scopes are fixed per client. grok-bot and claude can read and write HQ listings, pipeline, escrow, tasks, notes, the watchlist, and the investment plan, and they can publish research. instinct can only read research status and research notes. No key can run SQL, use a service-role credential, or place a trade.</p>
${issueForm()}`);
}

function keyTable(keys) {
  if (!keys.length) return '<p>No keys yet.</p>';
  const rows = keys.map((k) => {
    const active = !k.revoked_at && new Date(k.expires_at).getTime() > Date.now();
    const revoke = active ? `<form method="post" action="/publisher/keys" autocomplete="off">
<input type="hidden" name="action" value="revoke">
<input type="hidden" name="id" value="${escapeHtml(k.id)}">
${OWNER_FIELD}
<button type="submit">Revoke</button>
</form>` : (k.revoked_at ? 'Revoked' : 'Expired');
    return `<tr><td>${escapeHtml(k.client)}</td><td>${escapeHtml(k.label || '')}</td><td>${escapeHtml((k.scopes || []).join(', '))}</td><td>${when(k.created_at)}</td><td>${when(k.expires_at)}</td><td>${when(k.revoked_at)}</td><td>${when(k.last_used_at)}</td><td>${revoke}</td></tr>`;
  }).join('\n');
  return `<table>
<thead><tr><th>Client</th><th>Label</th><th>Scopes</th><th>Created</th><th>Expires</th><th>Revoked</th><th>Last used</th><th></th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`;
}

export function keysListPage(keys, notice = '') {
  return shell('HQ publisher keys', `<h1>HQ publisher keys</h1>
${notice ? `<p>${escapeHtml(notice)}</p>` : ''}
${keyTable(keys)}
<h2>Create another key</h2>
${issueForm()}`);
}

export function keyIssuedPage(issued, keys) {
  return shell('HQ publisher key created', `<h1>Key created for ${escapeHtml(issued.client)}</h1>
<p>Copy this key now. It is shown only once and HQ keeps only its hash. Select the text below and copy it into the client's <code>Authorization: Bearer</code> header.</p>
<p><input type="text" readonly size="60" value="${escapeHtml(issued.key)}" aria-label="New publisher key"></p>
<p>Scopes: ${escapeHtml((issued.scopes || []).join(', '))}. Expires ${when(issued.expires_at)}.</p>
<p>MCP URL: https://hq.hovikp.com/mcp</p>
<h2>All keys</h2>
${keyTable(keys)}`);
}

export function keysErrorPage(message) {
  return shell('HQ publisher keys', `<h1>HQ publisher keys</h1>
<p>${escapeHtml(message)}</p>
<p><a href="/publisher/keys">Back</a></p>`);
}
