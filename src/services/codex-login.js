const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

// Fixed CLI actions only. Never return raw CLI output or credential files.
function createCodexLogin({ environment, launch = spawn, timeoutMs = 600000 } = {}) {
  let active, checking, state = { state: 'idle' }, stopped = false;
  const snapshot = () => ({ ...state });
  function command(args, timeout) {
    let child, timer, output = '', settled = false;
    let finish;
    const done = new Promise(resolve => { finish = result => {
      if (settled) return;
      settled = true; clearTimeout(timer); resolve(result);
    }; });
    const stop = () => {
      if (!settled && child) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
      finish({ ok: false });
    };
    try {
      child = launch('codex', args, { env: environment(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const read = chunk => {
        output = (output + chunk).slice(-16000);
        if (args.includes('--device-auth') && active?.child === child) {
          const plain = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
          const code = plain.match(/\b[A-Z0-9]{4}-[A-Z0-9]{5}\b/);
          if (code) state.code = code[0];
        }
      };
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', read); child.stderr.on('data', read);
      child.once('error', () => finish({ ok: false }));
      child.once('close', code => finish({ ok: code === 0 }));
      timer = setTimeout(stop, timeout); timer.unref?.();
    } catch { finish({ ok: false }); }
    return { child, done, stop };
  }
  return {
    async status() {
      if (active || state.state === 'failed') return snapshot();
      const check = checking || (checking = command(['login', 'status'], 10000));
      const result = await check.done;
      if (checking === check) checking = null;
      return active ? snapshot() : { state: result.ok ? 'connected' : 'disconnected' };
    },
    async start() {
      if (stopped) throw Object.assign(new Error('Сервис остановлен.'), { status: 503 });
      if (active) return snapshot();
      // Reserve before asynchronous mkdir so simultaneous clicks cannot start two logins.
      const reservation = {};
      active = reservation; state = { state: 'running', expiresAt: Date.now() + timeoutMs };
      try {
        const env = environment();
        await fs.mkdir(env.CODEX_HOME || path.join(env.HOME || os.homedir(), '.codex'), { recursive: true, mode: 0o700 });
        if (stopped || active !== reservation) return snapshot();
        const operation = command(['login', '--device-auth'], timeoutMs);
        active = operation;
        void operation.done.then(result => {
          if (active !== operation) return;
          active = null;
          state = { state: result.ok ? 'connected' : 'failed' };
        });
        return snapshot();
      } catch { if (active === reservation) { active = null; state = { state: 'failed' }; } return snapshot(); }
    },
    cancel() { const operation = active; active = null; operation?.stop?.(); state = { state: 'idle' }; return snapshot(); },
    close() { stopped = true; checking?.stop(); this.cancel(); },
  };
}
module.exports = { createCodexLogin };
