const test = require('node:test');
const assert = require('node:assert/strict');
const { codexArguments, codexPrompt } = require('../src/services/codex-request');
const { threadParams } = require('../src/services/codex-app-server');

test('Both Codex transports allow public web research for text without granting server tools', () => {
  for (const kind of [undefined, 'text', 'image']) {
    const request = { kind, model: 'gpt-6-sol', effort: 'low', speed: 'standard',
      prompt: 'Изучи https://ai-media-client.bothost.tech/ используй инструменты' };
    const args = codexArguments(request);
    const thread = threadParams(request, '/tmp/empty');
    const mode = kind === 'image' ? 'disabled' : 'live';
    assert.ok(args.includes(`web_search="${mode}"`));
    assert.equal(thread.config.web_search, mode);
    assert.equal(args[args.indexOf('shell_tool') - 1], '--disable');
    assert.equal(thread.config['features.shell_tool'], false);
    assert.equal(thread.config['features.browser_use'], false);
    assert.equal(thread.sandbox, 'read-only');
    const prompt = codexPrompt(request);
    assert.ok(prompt.endsWith(request.prompt));
    if (kind !== 'image') {
      assert.doesNotMatch(prompt, /Act only as a text model|Do not use tools/);
      assert.match(prompt, /built-in web search tool/);
    }
  }
});
