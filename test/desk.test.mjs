import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { dealPreflight } from '../publisher/deals.mjs';

const ui = { Intl, Date, Number, String, Set, Math };
vm.runInNewContext(fs.readFileSync(new URL('../desk.js', import.meta.url), 'utf8'), ui);
const HQDesk = ui.HQDesk;
const now = new Date('2026-11-11T20:00:00Z');

function deal(extra = {}) {
  return {
    schema_version: 1,
    record_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    external_key: 'thread-1',
    kind: 'escrow',
    lane: 'escrow',
    title: 'Record',
    status_label: 'Open',
    updated_at: '2026-11-11T18:00:00Z',
    ...extra
  };
}

test('empty desk stays at zero with honest labels', () => {
  const view = HQDesk.buildDesk({ listings: [], escrows: [], deals: [], now });
  assert.equal(view.pipelineCount, 0);
  assert.equal(view.projected.cents, 0);
  assert.equal(view.projected.hasAmount, false);
  assert.match(view.projected.label, /No pipeline records/);
  assert.equal(view.closed.cents, 0);
  assert.match(view.closed.label, /No closed amount dated 2026/);
  assert.equal(view.tabs.listings.length, 0);
  assert.equal(view.lanes.sold.length, 0);
});

test('active listings are not closed earnings and a year-like status is not money', () => {
  const view = HQDesk.buildDesk({
    listings: [{ id: '1', data: { address: 'A', status: 'Active', price: 10, net_est: 5 } }],
    escrows: [
      { id: '2', data: { address: 'B', status: 'Pipeline', net_est: 2.5 } },
      { id: '3', data: { address: 'C', status: '2027', net_est: 100, price: 50 } },
      { id: '4', data: { address: 'D', status: 'Unconfirmed', net_est: 'later' } }
    ],
    deals: [],
    now
  });
  assert.equal(view.tabs.listings.length, 1);
  assert.equal(view.tabs.pipeline.length, 1);
  assert.equal(view.tabs.escrows.length, 2);
  assert.equal(view.projected.cents, 250);
  assert.equal(view.closed.cents, 0);
  assert.equal(view.lanes.sold.length, 0);
});

test('sold rows without a close date stay out of this year', () => {
  const view = HQDesk.buildDesk({
    listings: [{ id: '1', data: { address: 'A', status: 'Sold', net_est: 4 } }],
    escrows: [],
    deals: [
      { kind: 'listing', lane: 'sold', title: 'B', status_label: 'Sold', net_est_cents: 300, closed_on: '2026-01-02' },
      { kind: 'listing', lane: 'sold', title: 'C', status_label: 'Sold', net_est_cents: 900, closed_on: '2025-12-01' }
    ],
    now
  });
  assert.equal(view.lanes.sold.length, 3);
  assert.equal(view.closed.cents, 300);
  assert.match(view.closed.label, /no close date/);
  assert.match(view.closed.label, /other years/);
  assert.equal(HQDesk.formatCents(300), '$3.00');
});

test('task edits overlay remote rows and local creates stay until they match', () => {
  const remote = [{ id: 'abc', data: { subject: 'Call', priority: 'High', note: 'n' } }];
  const merged = HQDesk.mergeTasks(remote, {
    patches: { abc: { subject: 'Call', priority: 'Low', note: 'n2', completed: true, completed_at: '2026-11-11T00:00:00Z' } },
    created: [{ id: 'local-1', subject: 'New', priority: '', note: '', completed: false }]
  });
  assert.equal(merged.items.length, 2);
  assert.equal(merged.items[0].completed, true);
  assert.equal(merged.items[0].priority, 'Low');
  assert.equal(merged.items[1].remote, false);
  const caughtUp = HQDesk.mergeTasks(
    [{ id: 'abc', data: { subject: 'Call', priority: 'Low', note: 'n2', completed: true, completed_at: '2026-11-11T00:00:00Z' } }],
    merged.store
  );
  assert.equal(caughtUp.store.patches.abc, undefined);
  assert.equal(caughtUp.items[0].priority, 'Low');
});

test('deal payloads reject quotes and owner fields and accept cent amounts', () => {
  assert.equal(dealPreflight(deal({ owner_id: 'x' })).error_code, 'forbidden_field');
  assert.equal(dealPreflight(deal({ price: 12 })).error_code, 'forbidden_field');
  assert.equal(dealPreflight(deal({ quote: 1 })).field, 'quote');
  assert.equal(dealPreflight(deal({ kind: 'listing', lane: 'pipeline' })).error_code, 'invalid_payload');
  assert.equal(dealPreflight(deal({ closed_on: '2026-01-02' })).error_code, 'invalid_payload');
  assert.equal(dealPreflight(deal({ price_cents: 150000, net_est_cents: 2500 })).ok, true);
  assert.equal(dealPreflight(deal({ kind: 'listing', lane: 'sold', closed_on: '2026-02-02', price_cents: null })).ok, true);
});

test('the investment plan is stored verbatim and the markets page does not invent balances', () => {
  const plan = fs.readFileSync(new URL('../investment-plan.md', import.meta.url), 'utf8');
  assert.equal(plan.startsWith('# Hovik\u2019s Investment Plan\n'), true);
  assert.match(plan, /Hovik is not connected to Fidelity/);
  assert.match(plan, /SPCX \(SpaceX\)/);
  assert.match(plan, /A starting virtual balance has not been set yet and should not be invented/);
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.equal(html.includes('id="page-markets"'), true);
  assert.equal(html.includes('No figures entered yet'), true);
  assert.equal(html.includes('Not a priced holding'), true);
  assert.equal(html.includes('stock-research chat'), true);
  assert.equal(html.includes('Fidelity sync'), false);
  assert.equal(/\$\d{2,}/.test(html.slice(html.indexOf('id="page-markets"'), html.indexOf('id="page-markets"') + 8000)), false);
});

test('deal migration is fail-closed and does not seed records', () => {
  const sql = fs.readFileSync(new URL('../supabase/migrations/20261111223000_deal_publisher.sql', import.meta.url), 'utf8');
  assert.match(sql, /revoke all on function hq_private\.publish_deal\(jsonb\) from public, anon, authenticated/);
  assert.match(sql, /grant execute on function hq_private\.publish_deal\(jsonb\) to hq_publisher/);
  assert.match(sql, /grant select on table public\.deal_records to authenticated/);
  assert.match(sql, /force row level security/);
  assert.equal(sql.includes('service_role'), true);
  assert.equal(/grant execute on function hq_private\.publish_deal\(jsonb\) to (anon|authenticated|service_role)/.test(sql), false);
  assert.equal(sql.includes('insert into public.listings'), false);
  assert.equal(sql.includes('insert into public.escrows'), false);
  assert.equal(sql.includes('insert into public.tasks'), false);
});
