import http from 'k6/http';
import { check } from 'k6';
import { SharedArray } from 'k6/data';
import exec from 'k6/execution';

const users = new SharedArray('test sessions', () => JSON.parse(open(__ENV.SESSIONS_FILE)));
const vus = Number(__ENV.VUS || 5);
const iterations = Number(__ENV.ITERATIONS || 10);
const runId = __ENV.RUN_ID;
const oneAccount = __ENV.ONE_ACCOUNT === '1';
if (!/^[a-zA-Z0-9_-]{4,80}$/.test(runId || '') || !Number.isInteger(vus) || vus < 1 || vus > (oneAccount ? 25 : users.length)
  || !Number.isInteger(iterations) || iterations < 1 || iterations > 100) throw new Error('Invalid queue load limits');

export const options = {
  scenarios: { submissions: { executor: 'shared-iterations', vus, iterations, maxDuration: '2m' } },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
  thresholds: { checks: ['rate==1'], http_req_failed: ['rate<0.001'] },
};

export default function () {
  const iteration = exec.scenario.iterationInTest;
  const user = users[oneAccount ? 0 : iteration % users.length];
  const requestId = `load:${runId}:${iteration}`;
  const body = [{ requestId, modelId: 'kie:grok-imagine-video-1-5-preview',
    input: { prompt: `Mock load ${requestId}`, duration: 8, aspect_ratio: '16:9', resolution: '720p' }, sourceFiles: [] }];
  const response = http.post(`${__ENV.BASE_URL || 'http://media:3000'}/api/rpc/createTask`, JSON.stringify(body), {
    headers: { Host: __ENV.HOST_HEADER || '127.0.0.1:3001', Cookie: user.cookie,
      'X-Media-Client': 'web', 'X-Media-User': user.id, 'Content-Type': 'application/json' }, timeout: '15s',
  });
  check(response, { 'task accepted': r => r.status === 200 && Boolean(r.json('result.id')) });
}
