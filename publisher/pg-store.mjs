import pg from 'pg';
import { hashToken } from './oauth.mjs';
import { publisherDbConfig } from './db-config.mjs';

export function createPgStore(connectionString, options = {}) {
  const pool = new pg.Pool(publisherDbConfig(connectionString, options));

  return {
    async saveCode(row) {
      await pool.query(
        'select hq_private.oauth_save_code($1,$2,$3,$4,$5,to_timestamp($6 / 1000.0))',
        [row.hash, row.clientId, row.redirectUri, row.challenge, row.scope.join(' '), row.exp]
      );
    },
    async consumeCode(hash) {
      const { rows } = await pool.query('select * from hq_private.oauth_consume_code($1)', [hash]);
      if (!rows.length) return null;
      return {
        clientId: rows[0].client_id,
        redirectUri: rows[0].redirect_uri,
        challenge: rows[0].challenge,
        scope: String(rows[0].scope).split(/\s+/),
        exp: new Date(rows[0].expires_at).getTime()
      };
    },
    async saveGrant(row) {
      await pool.query(
        'select hq_private.oauth_save_grant($1,$2,$3,$4,to_timestamp($5 / 1000.0),to_timestamp($6 / 1000.0))',
        [row.accessHash, row.refreshHash, row.family, row.scope.join(' '), row.accessExp, row.refreshExp]
      );
    },
    async rotate(row) {
      const { rows } = await pool.query(
        'select hq_private.oauth_rotate($1,$2,$3,to_timestamp($4 / 1000.0),to_timestamp($5 / 1000.0)) as result',
        [row.oldHash, row.accessHash, row.refreshHash, row.accessExp, row.refreshExp]
      );
      const result = rows[0].result;
      if (!result.ok) return { ok: false };
      return { ok: true, scope: String(result.scope).split(/\s+/), family: result.family };
    },
    async introspect(hash) {
      const { rows } = await pool.query('select hq_private.oauth_introspect($1) as scope', [hash]);
      if (!rows[0] || rows[0].scope == null) return null;
      return { scope: String(rows[0].scope).split(/\s+/) };
    },
    async revoke(hash) {
      await pool.query('select hq_private.oauth_revoke($1)', [hash]);
    },
    async hit(bucket, limit, windowSeconds) {
      const { rows } = await pool.query(
        'select hq_private.oauth_hit($1, $2, $3) as ok',
        [bucket, limit, windowSeconds]
      );
      return rows[0].ok === true;
    },
    async purge() {
      try { await pool.query('select hq_private.oauth_purge_expired()'); }
      catch { /* retention is best-effort and must not change the client error */ }
    },
    async query(sql, params) {
      return pool.query(sql, params);
    },
    hash: hashToken,
    async end() { await pool.end(); }
  };
}
