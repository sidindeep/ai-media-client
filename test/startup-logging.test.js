const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');

test('configuration failure before database startup is delivered to ai_logger before process exits', async t => {
  const records = [];
  const logger = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    records.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(202); res.end('{}');
  });
  await new Promise(resolve => logger.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => logger.close(resolve)));
  const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, MEDIA_PORT: 'invalid-port',
      AI_LOGGER_SERVER_URL: `http://127.0.0.1:${logger.address().port}/ingest`,
      AI_LOGGER_PROJECT: 'ai-media-client', AI_LOGGER_SERVICE: 'startup-test', AI_LOGGER_INSTANCE_ID: 'startup-machine',
    }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill(), 15000); t.after(() => clearTimeout(timer));
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(code, 1, stderr);
  assert.ok(records.some(row => row.message === 'runtime.error' && row.level === 'ERROR'));
  assert.ok(records.some(row => row.message === 'config.error' && row.context.error_code === 'CONFIG_INVALID'));
  assert.ok(records.some(row => row.message === 'startup.error' && row.level === 'ERROR'));
  const configError = records.find(row => row.message === 'config.error');
  assert.match(configError.exception.stack_trace, /src[\\/]server[\\/]config.js/);
  assert.equal(configError.context.entity, 'configuration');
  assert.ok(configError.context.description);
  assert.ok(configError.context.file);
  assert.ok(Number(configError.context.line) > 0);
  assert.ok(records.every(row => row.context.project === 'ai-media-client' && row.context.instance_id === 'startup-machine'));
  assert.ok(!JSON.stringify(records).includes('invalid-port'));
});
