import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const ui = { globalThis: {} };
ui.globalThis = ui;
vm.runInNewContext(fs.readFileSync(new URL('../arrange.js', import.meta.url), 'utf8'), ui);
const HQArrange = ui.HQArrange;

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function memory() {
  const store = {};
  return {
    store,
    getItem(key) { return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null; },
    setItem(key, value) { store[key] = String(value); }
  };
}

test('default arrangement puts chat in the center', () => {
  assert.deepEqual(plain(HQArrange.defaultState()), {
    center: 'chat',
    bar: ['tasks', 'markets', 'listings', 'agents']
  });
  assert.equal(HQArrange.STORAGE_KEY, 'hq.arrange.v1');
  assert.deepEqual(plain(HQArrange.normalize(null)), plain(HQArrange.defaultState()));
});

test('swap exchanges the center panel with the clicked bar slot', () => {
  const start = HQArrange.defaultState();
  const snapshot = JSON.stringify(start);
  const next = HQArrange.swap(start, 'tasks');
  assert.equal(JSON.stringify(start), snapshot);
  assert.deepEqual(plain(next), {
    center: 'tasks',
    bar: ['chat', 'markets', 'listings', 'agents']
  });
  const middle = HQArrange.swap(next, 'listings');
  assert.deepEqual(plain(middle), {
    center: 'listings',
    bar: ['chat', 'markets', 'tasks', 'agents']
  });
  assert.deepEqual(plain(HQArrange.swap(next, 'chat')), JSON.parse(snapshot));
});

test('swap ignores the center id and unknown ids', () => {
  const start = HQArrange.defaultState();
  assert.deepEqual(plain(HQArrange.swap(start, 'chat')), plain(start));
  assert.deepEqual(plain(HQArrange.swap(start, 'retired')), plain(start));
  assert.deepEqual(plain(HQArrange.swap(start, '')), plain(start));
});

test('unknown or partial saves fall back without dropping known panels', () => {
  assert.deepEqual(plain(HQArrange.normalize(undefined)), plain(HQArrange.defaultState()));
  assert.deepEqual(plain(HQArrange.normalize('nope')), plain(HQArrange.defaultState()));
  assert.deepEqual(plain(HQArrange.normalize([])), plain(HQArrange.defaultState()));
  assert.deepEqual(plain(HQArrange.normalize({ center: 'retired-panel', bar: ['nope', 'markets', 'markets', 4, 'chat'] })), {
    center: 'chat',
    bar: ['markets', 'tasks', 'listings', 'agents']
  });
  assert.deepEqual(plain(HQArrange.normalize({ center: 'tasks', bar: ['ghost', 'agents'] })), {
    center: 'tasks',
    bar: ['agents', 'chat', 'markets', 'listings']
  });
  assert.deepEqual(plain(HQArrange.normalize({ center: 'markets' })), {
    center: 'markets',
    bar: ['chat', 'tasks', 'listings', 'agents']
  });
});

test('arrangement persists under the namespaced key and reloads', () => {
  const storage = memory();
  const arranged = HQArrange.swap(HQArrange.defaultState(), 'tasks');
  const saved = HQArrange.saveState(storage, arranged);
  assert.deepEqual(plain(saved), plain(arranged));
  assert.equal(Object.keys(storage.store).join(','), HQArrange.STORAGE_KEY);
  assert.deepEqual(JSON.parse(storage.store[HQArrange.STORAGE_KEY]), plain(arranged));
  assert.deepEqual(plain(HQArrange.loadState(storage)), plain(arranged));

  storage.store[HQArrange.STORAGE_KEY] = '{';
  assert.deepEqual(plain(HQArrange.loadState(storage)), plain(HQArrange.defaultState()));
  storage.store[HQArrange.STORAGE_KEY] = JSON.stringify({ center: 'not-a-panel', bar: ['also-gone'] });
  assert.deepEqual(plain(HQArrange.loadState(storage)), plain(HQArrange.defaultState()));
  assert.deepEqual(plain(HQArrange.loadState(memory())), plain(HQArrange.defaultState()));
});
