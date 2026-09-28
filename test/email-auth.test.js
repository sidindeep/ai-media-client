const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/database/database');
const { testPool } = require('./helpers/pg-pool');
const { createEmailAuth } = require('../src/auth/email');

test('email registration requires its link, login checks password, and reset revokes sessions', async t => {
  const pool = await openDatabase({}, testPool());
  t.after(() => pool.end());
  const messages = [];
  const mailer = { sendMail: async message => { messages.push(message); } };
  const issueSession = async (_client, _req, accountId) => `session-for-${accountId}`;
  const email = createEmailAuth({ pool, config: { origin: 'https://app.test', email: { enabled: true, smtp: { from: 'test@app.test' } } },
    issueSession, mailer });
  await email.register(' New@Example.test ', 'long-password-123');
  assert.equal(messages.length, 1);
  assert.equal((await pool.query('SELECT count(*) AS n FROM media_accounts')).rows[0].n, 0);
  const verifyToken = new URL(messages[0].text.match(/https:\/\/\S+/)[0]).searchParams.get('token');
  await assert.rejects(email.verify({}, 'invalid'), /недействительна/);
  const session = await email.verify({}, verifyToken);
  assert.match(session, /^session-for-/);
  assert.equal((await pool.query('SELECT count(*) AS n FROM media_accounts')).rows[0].n, 1);
  await assert.rejects(email.verify({}, verifyToken), /устарела/);
  await assert.rejects(email.login({}, 'new@example.test', 'wrong-password'), /Неверный email или пароль/);
  assert.equal(await email.login({}, 'new@example.test', 'long-password-123'), session);
  const accountId = (await pool.query('SELECT account_id,password_hash FROM media_email_credentials WHERE email=$1', ['new@example.test'])).rows[0];
  assert.ok(!accountId.password_hash.includes('long-password-123'));
  await pool.query("INSERT INTO media_sessions(token_hash,account_id,expires_at) VALUES('existing-session',$1,now()+interval '1 day')", [accountId.account_id]);
  await email.forgot('new@example.test');
  const resetToken = new URL(messages[1].text.match(/https:\/\/\S+/)[0]).searchParams.get('reset');
  await email.reset(resetToken, 'another-long-password');
  assert.equal((await pool.query('SELECT count(*) AS n FROM media_sessions WHERE account_id=$1', [accountId.account_id])).rows[0].n, 0);
  await assert.rejects(email.login({}, 'new@example.test', 'long-password-123'), /Неверный email или пароль/);
  assert.equal(await email.login({}, 'new@example.test', 'another-long-password'), session);
  await assert.rejects(email.reset(resetToken, 'another-long-password'), /устарела/);
});
