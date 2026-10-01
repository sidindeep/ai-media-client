const { randomBytes, createHash, scrypt: scryptCallback, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const nodemailer = require('nodemailer');
const { transaction } = require('../database/database');

const scrypt = promisify(scryptCallback);
const token = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
const normalizedEmail = value => {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Укажите корректный email');
  return email;
};
const validPassword = value => {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128) throw new Error('Пароль должен содержать от 12 до 128 символов');
  return value;
};
async function passwordHash(password) {
  const salt = randomBytes(16).toString('base64url');
  const key = await scrypt(validPassword(password), Buffer.from(salt, 'base64url'), 64);
  return `scrypt$${salt}$${key.toString('base64url')}`;
}
async function matchesPassword(password, stored) {
  if (typeof password !== 'string' || password.length > 128) return false;
  const parts = typeof stored === 'string' ? stored.split('$') : [];
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const expected = Buffer.from(parts[2], 'base64url');
  if (expected.length !== 64) return false;
  const actual = await scrypt(password, Buffer.from(parts[1], 'base64url'), 64);
  return timingSafeEqual(actual, expected);
}
function createEmailAuth({ pool, config, registerAccount, issueSession, mailer }) {
  if (!config.email?.enabled) return null;
  if (typeof registerAccount !== 'function') throw new Error('Account registration is required');
  const smtp = config.email.smtp;
  const sender = mailer || nodemailer.createTransport({ host: smtp.host, port: smtp.port, secure: smtp.port === 465,
    requireTLS: smtp.port !== 465, auth: { user: smtp.user, pass: smtp.password } });
  const send = (to, subject, url) => sender.sendMail({ from: smtp.from, to, subject,
    text: `${subject}\n\nОткройте ссылку: ${url}\n\nЕсли вы не запрашивали это письмо, просто проигнорируйте его.` });
  return {
    async register(value, password) {
      const email = normalizedEmail(value);
      const encrypted = await passwordHash(password);
      await pool.query('DELETE FROM media_email_pending WHERE expires_at<now()');
      if ((await pool.query('SELECT 1 FROM media_email_credentials WHERE email=$1', [email])).rows.length) return;
      const raw = token();
      const inserted = await pool.query(`INSERT INTO media_email_pending(email,password_hash,token_hash,expires_at)
        VALUES($1,$2,$3,now()+interval '30 minutes') ON CONFLICT(email) DO UPDATE SET
        password_hash=EXCLUDED.password_hash,token_hash=EXCLUDED.token_hash,expires_at=EXCLUDED.expires_at,sent_at=now()
        WHERE media_email_pending.sent_at < now()-interval '1 minute' RETURNING email`, [email, encrypted, hash(raw)]);
      if (!inserted.rows.length) return;
      try { await send(email, 'Подтвердите email Медиастудии', `${config.origin}/auth/email/verify?token=${raw}`); }
      catch { await pool.query('DELETE FROM media_email_pending WHERE email=$1 AND token_hash=$2', [email, hash(raw)]); throw new Error('Не удалось отправить письмо. Повторите позже.'); }
    },
    async verify(req, raw) {
      if (typeof raw !== 'string' || !/^[\w-]{43}$/.test(raw)) throw new Error('Ссылка подтверждения недействительна');
      return transaction(pool, async client => {
        const pending = (await client.query('DELETE FROM media_email_pending WHERE token_hash=$1 AND expires_at>now() RETURNING email,password_hash', [hash(raw)])).rows[0];
        if (!pending) throw new Error('Ссылка подтверждения устарела');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`email:${pending.email}`]);
        if ((await client.query('SELECT 1 FROM media_email_credentials WHERE email=$1', [pending.email])).rows.length) throw new Error('Этот email уже зарегистрирован');
        const accountId = await registerAccount(client, { name: pending.email.split('@')[0], role: 'user' });
        await client.query('INSERT INTO media_identities(provider,subject,account_id,verified_email) VALUES($1,$2,$3,$4)', ['email', pending.email, accountId, pending.email]);
        await client.query('INSERT INTO media_email_credentials(email,account_id,password_hash) VALUES($1,$2,$3)', [pending.email, accountId, pending.password_hash]);
        return issueSession(client, req, accountId);
      });
    },
    async login(req, value, password) {
      const email = normalizedEmail(value);
      const record = (await pool.query('SELECT account_id,password_hash FROM media_email_credentials WHERE email=$1', [email])).rows[0];
      if (!record) {
        if (typeof password === 'string' && password.length <= 128) await scrypt(password, Buffer.alloc(16), 64);
        throw new Error('Неверный email или пароль');
      }
      if (!await matchesPassword(password, record.password_hash)) throw new Error('Неверный email или пароль');
      return transaction(pool, client => issueSession(client, req, record.account_id));
    },
    async forgot(value) {
      const email = normalizedEmail(value);
      await pool.query('DELETE FROM media_email_resets WHERE expires_at<now()');
      const record = (await pool.query('SELECT 1 FROM media_email_credentials WHERE email=$1', [email])).rows[0];
      if (!record) return;
      const raw = token();
      const inserted = await pool.query(`INSERT INTO media_email_resets(token_hash,email,expires_at)
        VALUES($1,$2,now()+interval '30 minutes') ON CONFLICT(email) DO UPDATE SET
        token_hash=EXCLUDED.token_hash,expires_at=EXCLUDED.expires_at,sent_at=now()
        WHERE media_email_resets.sent_at < now()-interval '1 minute' RETURNING email`, [hash(raw), email]);
      if (!inserted.rows.length) return;
      try { await send(email, 'Сброс пароля Медиастудии', `${config.origin}/login?reset=${raw}`); }
      catch { await pool.query('DELETE FROM media_email_resets WHERE email=$1 AND token_hash=$2', [email, hash(raw)]); throw new Error('Не удалось отправить письмо. Повторите позже.'); }
    },
    async reset(raw, password) {
      if (typeof raw !== 'string' || !/^[\w-]{43}$/.test(raw)) throw new Error('Ссылка восстановления недействительна');
      const encrypted = await passwordHash(password);
      await transaction(pool, async client => {
        const reset = (await client.query('DELETE FROM media_email_resets WHERE token_hash=$1 AND expires_at>now() RETURNING email', [hash(raw)])).rows[0];
        if (!reset) throw new Error('Ссылка восстановления устарела');
        const account = (await client.query('UPDATE media_email_credentials SET password_hash=$2 WHERE email=$1 RETURNING account_id', [reset.email, encrypted])).rows[0];
        await client.query('DELETE FROM media_sessions WHERE account_id=$1', [account.account_id]);
      });
    }
  };
}

module.exports = { createEmailAuth, passwordHash, matchesPassword };
