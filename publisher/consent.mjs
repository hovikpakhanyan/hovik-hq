function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[ch]);
}

export function consentPage(fields) {
  const names = ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'scope', 'state'];
  const hidden = names.map((name) =>
    `<input type="hidden" name="${name}" value="${escapeHtml(fields[name] || '')}">`
  ).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<title>Allow HQ research</title>
</head>
<body>
<h1>Allow HQ research publishing</h1>
<p>The redirect below is the only destination this consent will use. Approving it lets that client publish research notes, publish listing, pipeline, and escrow records, and read publication status.</p>
<p>This does not approve trades, messages, deletes, credential changes, or any other action.</p>
<p>Redirect: ${escapeHtml(fields.redirect_uri || '')}</p>
<p>Scopes: ${escapeHtml(fields.scope || '')}</p>
<form method="post" action="/oauth/authorize" autocomplete="off">
${hidden}
<label>Owner code <input type="password" name="bootstrap" autocomplete="off" required></label>
<button type="submit">Allow this client</button>
</form>
</body>
</html>`;
}
