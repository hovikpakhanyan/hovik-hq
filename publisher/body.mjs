export async function readWebBody(req, limit = 262144) {
  if (!req.body) return '';
  const reader = req.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        const error = Object.assign(new Error('oversize'), { status: 413, code: 'oversize' });
        try { await reader.cancel(error); } catch { /* the stream is already closing */ }
        throw error;
      }
      chunks.push(Buffer.from(value));
    }
  } catch (err) {
    if (err && err.status === 413) throw err;
    try { await reader.cancel(); } catch { /* the stream is already closed */ }
    throw Object.assign(new Error('bad_body'), { status: 400, code: 'bad_body' });
  }
  return Buffer.concat(chunks).toString('utf8');
}

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
  if (method !== 'GET' && method !== 'POST') return { status: 405, error: 'method_not_allowed' };
  return null;
}
