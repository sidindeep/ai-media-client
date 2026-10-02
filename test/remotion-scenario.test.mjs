import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenarioPrompt, parseScenario } from '../web/src/remotion/scenario.mjs';
const sources = [{ id: 'photo', kind: 'image', name: 'Море', title: '', src: 'blob:photo', seconds: 5 }, { id: 'clip', kind: 'video', name: 'Закат', title: '', src: '/api/results/clip', seconds: 5 }];
const plan = scenes => JSON.stringify({ scenes });
test('script prompt sends only bounded metadata, never source URLs or media bytes', () => {
  const prompt = scenarioPrompt('Ролик про отпуск', sources);
  assert.ok(prompt.includes('Ролик про отпуск'));
  assert.ok(prompt.includes('Море'));
  assert.ok(!prompt.includes('blob:photo') && !prompt.includes('/api/results/clip'));
  assert.throws(() => scenarioPrompt('', sources));
  assert.throws(() => scenarioPrompt('x'.repeat(8001), sources));
});
test('AI plan reorders, repeats materials and creates title cards with independent ids', () => {
  let sequence = 0;
  const result = parseScenario('```json\n' + plan([{ sourceId: null, title: 'Отпуск', seconds: 2 }, { sourceId: 'clip', title: 'Закат', seconds: 4 }, { sourceId: 'photo', title: 'Море', seconds: 3 }, { sourceId: 'photo', title: 'Финал', seconds: 2 }]) + '\n```', sources, () => String(++sequence));
  assert.deepEqual(result.map(scene => scene.kind), ['title', 'video', 'image', 'image']);
  assert.equal(result[1].src, '/api/results/clip');
  assert.equal(result[2].src, result[3].src);
  assert.notEqual(result[2].id, result[3].id);
  assert.equal(sources[0].title, '');
});
test('AI plan rejects code, external sources, unknown fields and unsafe durations atomically', () => {
  const valid = { sourceId: 'photo', title: 'Текст', seconds: 3 };
  for (const output of ['<script>alert(1)</script>', plan([]), plan([{ ...valid, sourceId: 'https://evil.test/a.png' }]), plan([{ ...valid, src: 'https://evil.test' }]), plan([{ ...valid, seconds: '3' }]), plan([{ ...valid, seconds: -1 }]), plan([{ ...valid, seconds: 31 }]), plan([{ ...valid, sourceId: 'clip', seconds: 6 }]), plan([{ ...valid, title: 'x'.repeat(301) }]), plan(Array(21).fill(valid)), JSON.stringify({ scenes: [valid], code: 'x' })])
    assert.throws(() => parseScenario(output, sources));
});
