import { createHash, randomBytes } from 'node:crypto';

// Long-lived publisher keys: "hqpk_" + 32 random bytes as base64url (43 chars).
// Only sha256 hex of the whole string is stored, the same hash form as OAuth tokens.
export const KEY_PREFIX = 'hqpk_';
const KEY_PATTERN = /^hqpk_[A-Za-z0-9_-]{43}$/;

// Every scope a publisher key is allowed to carry. There is no service-role
// scope, no raw SQL scope, and no trade or order scope.
export const KEY_SCOPES = Object.freeze([
  'research.publish',
  'research.status.read',
  'research.read',
  'listings.read',
  'listings.write',
  'pipeline.read',
  'pipeline.write',
  'escrow.read',
  'escrow.write',
  'tasks.read',
  'tasks.write',
  'notes.read',
  'notes.write',
  'watchlist.read',
  'watchlist.write',
  'plan.read',
  'plan.write'
]);

const FULL = KEY_SCOPES;

// Fixed default scopes per client. Mirrors hq_private.publisher_key_default_scopes.
// grok-bot and claude receive the full set. instinct stays read-only on research.
export const CLIENT_SCOPES = Object.freeze({
  'grok-bot': FULL,
  claude: FULL,
  instinct: Object.freeze(['research.status.read', 'research.read'])
});

export const RESEARCH_TOOLS = Object.freeze({
  publish_stock_research: 'research.publish',
  research_status: 'research.status.read',
  read_stock_research: 'research.read'
});

export const DEAL_WRITE = Object.freeze({
  listing: 'listings.write',
  pipeline: 'pipeline.write',
  escrow: 'escrow.write'
});

export const DEAL_READ = Object.freeze({
  listing: 'listings.read',
  pipeline: 'pipeline.read',
  escrow: 'escrow.read'
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
