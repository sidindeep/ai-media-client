const { randomBytes, randomUUID, createHash } = require('node:crypto');
const { transaction } = require('../database/database');
const { createProviders } = require('./providers');
const token = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
const cookieValue = (req, name) => (req.headers.cookie || '').split(';').map(item => item.trim()).find(item => item.startsWith(name + '='))?.slice(name.length + 1) || '';
function createAuth({ pool, config, providers = createProviders(config) }) {
  const secure = config.origin.startsWith('https:');
  const cookie = (name, value, age) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure ? '; Secure' : ''}`;
  const sessionName = secure ? '__Host-media-session' : 'media-session';
  const flowName = secure ? '__Host-media-flow' : 'media-flow';
  const sessionSeconds = config.sessionSeconds;
  return {
    sessionName,
    async identities(accountId) { return (await pool.query('SELECT provider,subject FROM media_identities WHERE account_id=$1', [accountId])).rows; },
    providers: () => [...providers].map(([id, adapter]) => ({ id, label: adapter.label })),
    async user(req) {
      const raw = cookieValue(req, sessionName);
      if (!/^[\w-]{43}$/.test(raw)) return null;
      return (await pool.query('SELECT a.id,a.display_name AS name,a.role FROM media_sessions s JOIN media_accounts a ON a.id=s.account_id WHERE s.token_hash=$1 AND s.expires_at>now()', [hash(raw)])).rows[0] || null;
    },
    async begin(provider) {
      const adapter = providers.get(provider);
      if (!adapter) throw new Error('Этот способ входа ещё не настроен');
      const state = token(), browser = token(), verifier = token();
      await pool.query('DELETE FROM media_oauth_flows WHERE expires_at<now()');
      await pool.query('DELETE FROM media_sessions WHERE expires_at<now()');
      await pool.query("INSERT INTO media_oauth_flows(state_hash,browser_hash,provider,verifier,expires_at) VALUES($1,$2,$3,$4,now()+interval '10 minutes')", [hash(state), hash(browser), provider, verifier]);
      return { cookie: cookie(flowName, browser, 600), location: adapter.authorize({ state, challenge: createHash('sha256').update(verifier).digest('base64url'), redirectUri: `${config.origin}/auth/${provider}/callback` }) };
    },
    async finish(req, provider, params) {
      const adapter = providers.get(provider), state = params.get('state'), browser = cookieValue(req, flowName);
      if (!adapter || !state || !/^[\w-]{43}$/.test(state) || !/^[\w-]{43}$/.test(browser)) throw new Error('Вход устарел. Начните заново');
      const flow = (await pool.query('DELETE FROM media_oauth_flows WHERE state_hash=$1 AND browser_hash=$2 AND provider=$3 AND expires_at>now() RETURNING verifier', [hash(state), hash(browser), provider])).rows[0];
      if (!flow || params.get('error') || !params.get('code') || params.get('code').length > 4096) throw new Error('Вход не подтверждён. Начните заново');
      let profile;
      try { profile = await adapter.exchange({ state, code: params.get('code'), deviceId: params.get('device_id'), verifier: flow.verifier, redirectUri: `${config.origin}/auth/${provider}/callback` }); }
      catch { throw new Error('Не удалось подтвердить аккаунт у провайдера'); }
      if (typeof profile.subject !== 'string' || !profile.subject || profile.subject.length > 255) throw new Error('Некорректный аккаунт');
      const raw = token();
      await transaction(pool, async client => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${provider}:${profile.subject}`]);
        let identity = (await client.query('SELECT account_id FROM media_identities WHERE provider=$1 AND subject=$2', [provider, profile.subject])).rows[0];
        const isAdmin = config.adminIdentities.includes(`${provider}:${profile.subject}`);
        if (!identity) {
          identity = { account_id: randomUUID() };
          await client.query('INSERT INTO media_accounts(id,display_name,role) VALUES($1,$2,$3)', [identity.account_id, String(profile.name).slice(0, 200), isAdmin ? 'admin' : 'user']);
          await client.query('INSERT INTO media_identities(provider,subject,account_id) VALUES($1,$2,$3)', [provider, profile.subject, identity.account_id]);
          await client.query('INSERT INTO media_wallets(account_id) VALUES($1)', [identity.account_id]);
        } else if (isAdmin) await client.query("UPDATE media_accounts SET role='admin' WHERE id=$1", [identity.account_id]);
        // Rotate any previous session in this browser. Email never merges identities.
        const previous = cookieValue(req, sessionName);
        if (previous) await client.query('DELETE FROM media_sessions WHERE token_hash=$1', [hash(previous)]);
        await client.query('INSERT INTO media_sessions(token_hash,account_id,expires_at) VALUES($1,$2,$3)', [hash(raw), identity.account_id, new Date(Date.now() + sessionSeconds * 1000)]);
      });
      return [cookie(sessionName, raw, sessionSeconds), cookie(flowName, '', 0)];
    },
    async logout(req) {
      const raw = cookieValue(req, sessionName);
      if (raw) await pool.query('DELETE FROM media_sessions WHERE token_hash=$1', [hash(raw)]);
      return cookie(sessionName, '', 0);
    }
  };
}
module.exports = { createAuth, hash, cookieValue };
