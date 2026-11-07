export function publisherDbConfig(connectionString, options = {}) {
  let parsed;
  try { parsed = new URL(String(connectionString || '')); }
  catch { throw Object.assign(new Error('unconfigured'), { code: 'unconfigured' }); }
  const localHost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '';
  if (options.allowLocal === true && localHost) {
    return { connectionString, max: 1, idleTimeoutMillis: 1000, connectionTimeoutMillis: 5000, allowExitOnIdle: true };
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw Object.assign(new Error('unconfigured'), { code: 'unconfigured' });
  }
  const mode = (parsed.searchParams.get('sslmode') || '').toLowerCase();
  if (mode !== 'require' && mode !== 'verify-ca' && mode !== 'verify-full') {
    throw Object.assign(new Error('tls_required'), { code: 'tls_required' });
  }
  const user = decodeURIComponent(parsed.username || '');
  if (!user.startsWith('hq_publisher') || user === 'postgres' || user.startsWith('postgres.') || user.includes('service_role')) {
    throw Object.assign(new Error('publisher_role_required'), { code: 'publisher_role_required' });
  }
  const config = {
    connectionString,
    max: 1,
    idleTimeoutMillis: 1000,
    connectionTimeoutMillis: 5000,
    allowExitOnIdle: true
  };
  if (mode === 'require') config.ssl = { rejectUnauthorized: false };
  if (mode === 'verify-ca' || mode === 'verify-full') config.ssl = { rejectUnauthorized: true };
  return config;
}
