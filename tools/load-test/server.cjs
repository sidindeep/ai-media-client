const { randomUUID } = require('node:crypto');
const { start } = require('/app/server');
const { loadConfig } = require('/app/src/server/config');
const { createKieCreateLimiter } = require('/app/src/services/kie-create-limiter');

// This entrypoint is mounted only by compose.load-test-queue.yaml. No provider
// key or network call is needed to exercise the real account queue and billing.
const config = loadConfig();
const database = new URL(config.database.url);
if (database.hostname !== 'node1.pghost.ru' || database.pathname !== '/bothost_db_c5e6aab87bbb'
  || config.kieKey || config.kieSecondaryKey || config.routerAi.apiKey || config.codex.url
  || config.payments.enabled || config.telegram.enabled) throw new Error('Unsafe load-test configuration');
const limiter = createKieCreateLimiter();
const attempts = new Map();
const rejectEvery = Number(process.env.FAKE_KIE_REJECT_FIRST_EVERY || 0);
if (!Number.isInteger(rejectEvery) || rejectEvery < 0 || rejectEvery > 100) throw new Error('Invalid fake rejection rate');
let uniqueRequests = 0;
const provider = {
  id: 'kie',
  isConfigured: () => true,
  selectAccount: id => {
    if (id !== 'primary') throw new Error('Unknown fake Kie account');
    return provider;
  },
  listAccounts: () => [{ id: 'primary', name: 'Kie test double', configured: true }],
  waitForCreate: async () => {
    await limiter.wait();
    console.log(`LOAD_TEST_KIE_SLOT ${Date.now()}`);
  },
  rateLimited: () => limiter.rateLimited(),
  upload: async () => { throw new Error('Source uploads are outside this load scenario'); },
  async create(_model, input) {
    const key = JSON.stringify(input);
    if (!attempts.has(key)) attempts.set(key, ++uniqueRequests);
    if (rejectEvery && attempts.get(key) % rejectEvery === 0 && !attempts.has(`${key}:retry`)) {
      attempts.set(`${key}:retry`, true);
      throw Object.assign(new Error('Mock provider capacity limit'), { status: 429, outcome: 'rejected' });
    }
    await new Promise(resolve => setTimeout(resolve, 50));
    return { taskId: `mock-${randomUUID()}` };
  },
  async poll() { return { state: 'success', creditsConsumed: 2.5, resultJson: '{"resultUrls":[]}' }; },
  async balance() { return 100000; },
};
const tariffFetcher = async () => ({ ok: true, async json() { return { code: 200, data: { pages: 1, records: [
  { modelDescription: 'Grok Imagine Video 1.5 Preview', creditPrice: '2.5', creditUnit: 'per video',
    anchor: 'https://kie.ai/grok-imagine-video-1-5-preview', interfaceType: 'video', provider: 'Grok' },
] } }; } });

start({ config, provider, tariffFetcher, startupChecks: false }).then(runtime => {
  console.log('Load-test media with in-process Kie double is ready');
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    void runtime.close().then(() => process.exit(0));
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}).catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
