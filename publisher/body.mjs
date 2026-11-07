export function readBody(req, limit = 262144) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true;
        reject(Object.assign(new Error('oversize'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', (err) => { if (!failed) reject(err); });
  });
}

export function authorizeTransport(method, queryHasBootstrap) {
  if (queryHasBootstrap) return { status: 400, error: 'bootstrap_in_query' };
  if (method !== 'POST') return { status: 405, error: 'use_post_body' };
  return null;
}
