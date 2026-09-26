import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { Trend } from 'k6/metrics';

const users = new SharedArray('test sessions', () => JSON.parse(open(__ENV.SESSIONS_FILE)));
const base = __ENV.BASE_URL || 'http://media:3000';
const host = __ENV.HOST_HEADER || '127.0.0.1:3001';
const vus = Number(__ENV.VUS || 1);
const arrivalRate = Number(__ENV.ARRIVAL_RATE || 0);
const latency = {
  landing: new Trend('load_landing_ms', true),
  studio: new Trend('load_studio_ms', true),
  account: new Trend('load_account_ms', true),
  'workspace-full': new Trend('load_workspace_full_ms', true),
  'workspace-delta': new Trend('load_workspace_delta_ms', true),
};
if (!Number.isInteger(vus) || vus < 1 || vus > 500) throw new Error('VUS must be 1..500');
if (!Number.isInteger(arrivalRate) || arrivalRate < 0 || arrivalRate > 200) throw new Error('ARRIVAL_RATE must be 0..200 iterations/s');

export const options = {
  scenarios: arrivalRate ? {
    web: { executor: 'constant-arrival-rate', rate: arrivalRate, timeUnit: '1s',
      duration: __ENV.DURATION || '30s', preAllocatedVUs: vus, maxVUs: vus },
  } : {
    web: { executor: 'constant-vus', vus, duration: __ENV.DURATION || '30s' },
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate<0.001'],
    ...(arrivalRate ? { dropped_iterations: ['count==0'] } : {}),
  },
};

function get(route, name, cookie) {
  const response = http.get(`${base}${route}`, {
    headers: { Host: host, ...(cookie ? { Cookie: cookie } : {}) },
    tags: { name },
    timeout: '10s',
  });
  latency[name].add(response.timings.duration);
  check(response, { [`${name} returns 200`]: r => r.status === 200 });
  return response;
}

export default function () {
  const user = users[(__VU - 1) % users.length];
  get('/', 'landing', null);
  get('/app', 'studio', user.cookie);
  get('/api/account', 'account', user.cookie);
  const full = get('/api/workspace/sync', 'workspace-full', user.cookie);
  if (full.status === 200) {
    let cursor;
    try { cursor = full.json('result.cursor'); } catch { /* Count as a failed check below. */ }
    check(full, { 'workspace has cursor': () => typeof cursor === 'string' && !Number.isNaN(Date.parse(cursor)) });
    if (cursor) get(`/api/workspace/sync?since=${encodeURIComponent(cursor)}`, 'workspace-delta', user.cookie);
  }
  if (!arrivalRate) sleep(1);
}
