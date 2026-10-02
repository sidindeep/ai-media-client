const { randomBytes, createHash, createHmac, timingSafeEqual } = require('node:crypto');
const { transaction } = require('../database/database');

const token = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');

function verifyMaxInitData(initData, botToken) {
  if (typeof initData !== 'string' || initData.length > 8192) throw new Error('Некорректные данные MAX');
  const params = new URLSearchParams(initData);
  const fields = [...params.entries()];
  if (!fields.length || fields.some(([key]) => fields.filter(([other]) => other === key).length !== 1)) throw new Error('Некорректные данные MAX');
  const received = params.get('hash');
  if (!/^[a-f0-9]{64}$/i.test(received || '')) throw new Error('Нет подписи MAX');
  const signed = fields.filter(([key]) => key !== 'hash').sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(signed).digest();
  if (!timingSafeEqual(expected, Buffer.from(received, 'hex'))) throw new Error('Подпись MAX не подтверждена');
  const now = Math.floor(Date.now() / 1000);
  const authDate = Number(params.get('auth_date'));
  if (!Number.isInteger(authDate) || authDate > now + 60 || authDate < now - 600) throw new Error('Вход MAX устарел');
  const state = params.get('start_param');
  if (!/^[\w-]{43}$/.test(state || '')) throw new Error('Некорректная ссылка MAX');
  const rawUser = params.get('user') || '';
  let user;
  try { user = JSON.parse(rawUser); } catch { throw new Error('Некорректный профиль MAX'); }
  const subject = /"id"\s*:\s*(?:"(\d+)"|(\d+))/.exec(rawUser)?.slice(1).find(Boolean);
  if (!subject || !user || typeof user !== 'object') throw new Error('Некорректный профиль MAX');
  const name = [user.first_name, user.last_name].filter(part => typeof part === 'string' && part.trim()).join(' ').trim();
  return { state, subject, name: name.slice(0, 200) || 'Пользователь MAX' };
}

function createMaxAuth({ pool, config, registerAccount, issueSession, cookieValue }) {
  if (!config.max?.botName || !config.max?.botToken) return null;
  if (typeof registerAccount !== 'function') throw new Error('Account registration is required');
  const secure = config.origin.startsWith('https:');
  const flowName = secure ? '__Host-media-max-flow' : 'media-max-flow';
  const cookie = (value, age) => `${flowName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure ? '; Secure' : ''}`;
  const flow = req => {
    const raw = cookieValue(req, flowName).split('.');
    return raw.length === 2 && raw.every(part => /^[\w-]{43}$/.test(part)) ? { state: raw[0], browser: raw[1] } : null;
  };
  return {
    async begin() {
      const state = token(), browser = token();
      await pool.query('DELETE FROM media_max_login_flows WHERE expires_at<now()');
      await pool.query("INSERT INTO media_max_login_flows(state_hash,browser_hash,expires_at) VALUES($1,$2,now()+interval '10 minutes')", [hash(state), hash(browser)]);
      return { cookie: cookie(`${state}.${browser}`, 600), location: '/auth/max/wait' };
    },
    async link(req) {
      const values = flow(req);
      if (!values) throw new Error('Вход MAX устарел');
      const row = (await pool.query('SELECT 1 FROM media_max_login_flows WHERE state_hash=$1 AND browser_hash=$2 AND expires_at>now()', [hash(values.state), hash(values.browser)])).rows[0];
      if (!row) throw new Error('Вход MAX устарел');
      return `https://max.ru/${config.max.botName}?startapp=${values.state}`;
    },
    async confirm(initData) {
      const profile = verifyMaxInitData(initData, config.max.botToken);
      await transaction(pool, async client => {
        const row = (await client.query('SELECT account_id FROM media_max_login_flows WHERE state_hash=$1 AND expires_at>now() FOR UPDATE', [hash(profile.state)])).rows[0];
        if (!row || row.account_id) throw new Error('Вход MAX устарел');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`max:${profile.subject}`]);
        let identity = (await client.query('SELECT account_id FROM media_identities WHERE provider=$1 AND subject=$2', ['max', profile.subject])).rows[0];
        if (!identity) {
          const isAdmin = config.adminIdentities.includes(`max:${profile.subject}`);
          const accountId = await registerAccount(client, { name: profile.name, role: isAdmin ? 'admin' : 'user' });
          await client.query('INSERT INTO media_identities(provider,subject,account_id) VALUES($1,$2,$3)', ['max', profile.subject, accountId]);
          identity = { account_id: accountId };
        }
        await client.query('UPDATE media_max_login_flows SET account_id=$2 WHERE state_hash=$1', [hash(profile.state), identity.account_id]);
      });
    },
    async status(req) {
      const values = flow(req);
      if (!values) throw new Error('Вход MAX устарел');
      return transaction(pool, async client => {
        const row = (await client.query('SELECT account_id FROM media_max_login_flows WHERE state_hash=$1 AND browser_hash=$2 AND expires_at>now() FOR UPDATE', [hash(values.state), hash(values.browser)])).rows[0];
        if (!row) throw new Error('Вход MAX устарел');
        if (!row.account_id) return { ready: false };
        await client.query('DELETE FROM media_max_login_flows WHERE state_hash=$1', [hash(values.state)]);
        return { ready: true, cookie: [await issueSession(client, req, row.account_id), cookie('', 0)] };
      });
    }
  };
}

module.exports = { createMaxAuth, verifyMaxInitData };
