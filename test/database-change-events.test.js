const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { listenForAccountChanges } = require('../src/database/change-events');

test('LISTEN heartbeat detects lost queries and disposes its connection and listeners', async t => {
  const client = new EventEmitter(), queries = [], releases = [];
  client.query = async sql => { queries.push(sql); if (typeof sql === 'object') throw new Error('Connection terminated unexpectedly'); };
  client.release = value => releases.push(value);
  const listener = listenForAccountChanges({ connect: async () => client }, () => {}, { heartbeatMs: 5 });
  t.after(() => listener.close());
  for (let i = 0; i < 100 && !releases.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(queries[0], 'LISTEN media_account_changed');
  assert.deepEqual(queries[1], { text: 'SELECT 1', query_timeout: 5000 });
  assert.deepEqual(releases, [true]);
  assert.equal(client.listenerCount('notification'), 0);
  assert.equal(client.listenerCount('error'), 0);
  await listener.close();
  assert.equal(releases.length, 1);
});

test('closing while LISTEN is pending releases once and ignores later notifications', async () => {
  const client = new EventEmitter(); let finish, released = 0, notified = 0;
  client.query = () => new Promise(resolve => { finish = resolve; });
  client.release = () => { released++; };
  const listener = listenForAccountChanges({ connect: async () => client }, () => { notified++; });
  await new Promise(resolve => setImmediate(resolve));
  await listener.close(); finish();
  await new Promise(resolve => setImmediate(resolve));
  client.emit('notification', { channel: 'media_account_changed', payload: '00000000-0000-4000-8000-000000000001' });
  assert.equal(released, 1); assert.equal(notified, 0);
});

test('a lost LISTEN session reconnects and delivers validated notifications', async t => {
  const clients = [], notifications = [];
  const listener = listenForAccountChanges({ connect: async () => {
    const client = new EventEmitter();
    client.query = async () => ({}); client.release = () => {};
    clients.push(client); return client;
  } }, account => notifications.push(account));
  t.after(() => listener.close());
  await new Promise(resolve => setImmediate(resolve));
  clients[0].emit('error', new Error('Connection terminated unexpectedly'));
  for (let i = 0; i < 100 && clients.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(clients.length, 2);
  const account = '00000000-0000-4000-8000-000000000001';
  clients[1].emit('notification', { channel: 'media_account_changed', payload: 'invalid' });
  clients[1].emit('notification', { channel: 'media_account_changed', payload: account });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(notifications, [account]);
});
