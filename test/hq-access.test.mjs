import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CLIENT_SCOPES, KEY_SCOPES } from '../publisher/keys.mjs';
import { prepareDomain } from '../publisher/hq-tools.mjs';

const migration = fs.readFileSync(new URL('../supabase/migrations/20261123180000_hq_domain_access.sql', import.meta.url), 'utf8');
const page = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('domain migration does not seed data or delete deal rows', () => {
  assert.equal(migration.includes('delete from public.deal_records'), false);
  assert.equal(migration.includes('delete from public.listings'), false);
  assert.equal(migration.includes('delete from public.escrows'), false);
  assert.equal(migration.includes('alter table public.listings'), false);
  assert.equal(migration.includes('alter table public.tasks'), false);
  assert.equal(migration.includes('alter table public.notes'), false);
  assert.equal(migration.includes('# Hovik'), false);
  assert.equal(/grant execute on function hq_private\.task_mutate\(text, jsonb, text, uuid\) to (anon|authenticated|service_role)/.test(migration), false);
  assert.match(migration, /grant execute on function hq_private\.task_mutate\(text, jsonb, text, uuid\) to hq_publisher/);
  assert.match(migration, /existing publisher_keys rows changed/);
  for (const scope of KEY_SCOPES) assert.equal(migration.includes(`'${scope}'`), true);
  assert.deepEqual([...CLIENT_SCOPES.instinct], ['research.status.read', 'research.read']);
  assert.equal(CLIENT_SCOPES['grok-bot'].includes('listings.write'), true);
  assert.equal(CLIENT_SCOPES.claude.includes('plan.write'), true);
});

test('domain tools reject quotes, trades, and oversize fields before a write', () => {
  const bad = prepareDomain('create_listing', { external_key: 'L1', title: 'A', status_label: 'Open', lane: 'current', updated_at: new Date().toISOString(), quote: 1 });
  assert.equal(bad.error_code, 'forbidden_field');
  const trade = prepareDomain('create_note', { body: 'buy', side: 'buy' });
  assert.equal(trade.error_code, 'forbidden_field');
  const archived = prepareDomain('update_escrow', { external_key: 'E1', archive: true });
  assert.equal(archived.ok, true);
  assert.equal(archived.fn, 'deal_mutate');
  assert.equal(archived.args[0], 'escrow');
  assert.equal(archived.write, true);
  assert.equal(prepareDomain('delete_listing', { external_key: 'L1' }), null);
  const one = prepareDomain('get_watchlist', { symbol: 'NVDA', bucket: 'watch' });
  assert.deepEqual(one.args, [null, 'NVDA', 'watch', null]);
  const listed = prepareDomain('list_watchlist', { symbol: 'NVDA', bucket: 'watch', limit: 1 });
  assert.deepEqual(listed.args, [null, 'NVDA', 'watch', 1]);
  const task = prepareDomain('delete_task', { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' });
  assert.equal(task.fn, 'task_mutate');
  assert.equal(task.args[0], 'delete');
});

test('local export stays out of the markets page and does not read manual figures', () => {
  const start = page.indexOf('async function exportLocalToHq');
  const end = page.indexOf('async function loadDealRows');
  const fn = page.slice(start, end);
  assert.equal(start > 0 && end > start, true);
  assert.equal(fn.includes('investment-plan.md'), true);
  assert.equal(fn.includes('hq_tasks'), true);
  assert.equal(fn.includes('hq_notes'), true);
  assert.equal(fn.includes('hq_plan'), true);
  assert.equal(fn.includes('marketKey'), false);
  assert.equal(fn.includes('paper'), false);
  assert.equal(fn.includes('figure-manual'), false);
  assert.equal(page.includes('id="export-local"'), true);
  const markets = page.indexOf('id="markets-panel"');
  const tasks = page.indexOf('id="tasks-panel"');
  const button = page.indexOf('id="export-local"');
  assert.equal(button > tasks && button < markets, true);
});
