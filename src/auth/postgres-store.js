const { randomUUID } = require('node:crypto');
const { transaction } = require('../database/database');

// Application adapter owns the SQL, identity mapping and administrator bootstrap policy.
function createPostgresAuthStore({ pool, registerAccount, adminIdentities = [] }) {
  if (typeof registerAccount !== 'function') throw new Error('Account registration is required');
  const replaceSession = async (client, { tokenHash, previousTokenHash, expiresAt, accountId }) => {
    if (previousTokenHash) await client.query('DELETE FROM media_sessions WHERE token_hash=$1', [previousTokenHash]);
    await client.query('INSERT INTO media_sessions(token_hash,account_id,expires_at) VALUES($1,$2,$3)', [tokenHash, accountId, expiresAt]);
  };
  return {
    replaceSession,
    async identities(accountId) { return (await pool.query('SELECT provider,subject,verified_email AS email FROM media_identities WHERE account_id=$1', [accountId])).rows; },
    async getSession(tokenHash) {
      return (await pool.query('SELECT a.id,a.display_name AS name,a.role FROM media_sessions s JOIN media_accounts a ON a.id=s.account_id WHERE s.token_hash=$1 AND s.expires_at>now()', [tokenHash])).rows[0] || null;
    },
    async deleteSession(tokenHash) { await pool.query('DELETE FROM media_sessions WHERE token_hash=$1', [tokenHash]); },
    async createFlow({ stateHash, browserHash, provider, verifier, expiresAt }) {
      await pool.query('DELETE FROM media_oauth_flows WHERE expires_at<now()');
      await pool.query('DELETE FROM media_sessions WHERE expires_at<now()');
      await pool.query('INSERT INTO media_oauth_flows(state_hash,browser_hash,provider,verifier,expires_at) VALUES($1,$2,$3,$4,$5)', [stateHash, browserHash, provider, verifier, expiresAt]);
    },
    async consumeFlow({ stateHash, browserHash, provider }) {
      return (await pool.query('DELETE FROM media_oauth_flows WHERE state_hash=$1 AND browser_hash=$2 AND provider=$3 AND expires_at>now() RETURNING verifier', [stateHash, browserHash, provider])).rows[0] || null;
    },
    async completeLogin({ provider, profile, session }) {
      return transaction(pool, async client => {
        await client.query('SELECT pg_advisory_xact_lock(18274692)');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${provider}:${profile.subject}`]);
        let identity = (await client.query('SELECT account_id FROM media_identities WHERE provider=$1 AND subject=$2', [provider, profile.subject])).rows[0];
        const isAdmin = adminIdentities.includes(`${provider}:${profile.subject}`);
        if (!identity) {
          identity = { account_id: await registerAccount(client, { name: profile.name, role: isAdmin ? 'admin' : 'user' }) };
          await client.query('INSERT INTO media_identities(provider,subject,account_id) VALUES($1,$2,$3)', [provider, profile.subject, identity.account_id]);
        } else if (isAdmin) await client.query("UPDATE media_accounts SET role='admin' WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM media_role_audit WHERE account_id=$1)", [identity.account_id]);
        const email = provider === 'google' && typeof profile.verifiedEmail === 'string' ? profile.verifiedEmail.trim().toLowerCase() : null;
        await client.query('UPDATE media_identities SET verified_email=$3 WHERE provider=$1 AND subject=$2', [provider, profile.subject, email]);
        if (email) {
          const invitation = (await client.query('UPDATE media_admin_invitations SET consumed_by=$2,consumed_at=now() WHERE email=$1 AND consumed_by IS NULL RETURNING email', [email, identity.account_id])).rows[0];
          if (invitation) {
            const old = (await client.query('SELECT role FROM media_accounts WHERE id=$1 FOR UPDATE', [identity.account_id])).rows[0];
            await client.query("UPDATE media_accounts SET role='admin' WHERE id=$1", [identity.account_id]);
            await client.query('INSERT INTO media_role_audit(id,account_id,old_role,new_role,reason) VALUES($1,$2,$3,$4,$5)', [randomUUID(), identity.account_id, old.role, 'admin', 'Назначение владельца по подтверждённому Google email']);
          }
        }
        await replaceSession(client, { ...session, accountId: identity.account_id });
        return identity.account_id;
      });
    },
  };
}
module.exports = { createPostgresAuthStore };
