import { createHash, randomBytes } from 'node:crypto';

// Long-lived publisher keys: "hqpk_" + 32 random bytes as base64url (43 chars).
// Only sha256 hex of the whole string is stored, the same hash form as OAuth tokens.
export const KEY_PREFIX = 'hqpk_';
const KEY_PATTERN = /^hqpk_[A-Za-z0-9_-]{43}$/;

export const KEY_SCOPES = ['research.publish', 'research.status.read', 'research.read'];

// Fixed default scopes per client. Mirrors hq_private.publisher_key_default_scopes.
export const CLIENT_SCOPES = Object.freeze({
  'grok-bot': Object.freeze(['research.publish', 'research.status.read']),
  claude: Object.freeze(['research.status.read', 'research.read']),
  instinct: Object.freeze(['research.status.read', 'research.read'])
});

// The only tools a key may ever call. Deal, listing, pipeline, and escrow tools
// are never reachable with a key, whatever scopes a row carries.
export const KEY_TOOLS = Object.freeze({
  publish_stock_research: 'research.publish',
  research_status: 'research.status.read',
  read_stock_research: 'research.read'
});

export function looksLikeKey(raw) {
  return typeof raw === 'string' && KEY_PATTERN.test(raw);
}

export function hashKey(raw) {
  return createHash('sha256').update(String(raw)).digest('hex');
}

export function generateKey() {
  return KEY_PREFIX + randomBytes(32).toString('base64url');
}
