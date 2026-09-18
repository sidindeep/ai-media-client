// Refresh the reviewable model catalog from the authorized provider container.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const providerRoot = path.resolve(root, process.argv[2] || '../llm_providers');
const probe = `
import { spawn, execFileSync } from 'node:child_process';
import readline from 'node:readline';
const version = execFileSync('codex', ['--version'], {encoding:'utf8'}).trim();
const child = spawn('codex', ['app-server'], {stdio:['pipe','pipe','ignore']});
const timer = setTimeout(() => { child.kill(); process.exit(1); }, 30000);
let id = 1, models = [], pages = 0;
const send = (method, params, requestId) => child.stdin.write(JSON.stringify({method, params, ...(requestId ? {id:requestId} : {})})+'\\n');
const fail = () => { clearTimeout(timer); child.kill(); process.exitCode=1; };
child.on('error', fail);
child.on('close', () => { clearTimeout(timer); if (!models.length) process.exitCode=1; });
readline.createInterface({input:child.stdout}).on('line', line => {
  let msg; try { msg=JSON.parse(line); } catch { return; }
  if (msg.id !== id) return;
  if (msg.error) return fail();
  if (id === 1) { send('initialized', {}); send('model/list', {limit:100,includeHidden:false}, ++id); return; }
  if (!Array.isArray(msg.result?.data)) return fail();
  models.push(...msg.result.data.filter(m => !m.hidden).map(m => ({
    id:m.model, name:m.displayName || m.model, isDefault:Boolean(m.isDefault),
    efforts:(m.supportedReasoningEfforts || []).map(e=>e.reasoningEffort),
    defaultEffort:m.defaultReasoningEffort,
    inputModalities:m.inputModalities || ['text','image']
  })));
  if (msg.result.nextCursor) {
    if (++pages > 20) return fail();
    send('model/list', {limit:100,includeHidden:false,cursor:msg.result.nextCursor}, ++id); return;
  }
  console.log(JSON.stringify({version,checkedAt:new Date().toISOString(),models}));
  clearTimeout(timer); child.kill();
});
send('initialize', {clientInfo:{name:'media_model_catalog',version:'1.0.0'}}, id);
`;
const result = spawnSync('docker', ['compose', '--project-directory', providerRoot, 'run', '--rm', '-T', '--entrypoint', 'node', 'provider', '--input-type=module', '-'], {
  input: probe, encoding: 'utf8', timeout: 60000, windowsHide: true
});
if (result.error || result.status !== 0) throw new Error('Не удалось получить модели из контейнера Codex. Проверьте Docker и вход провайдера.');
const catalog = JSON.parse(result.stdout.trim());
catalog.uiDefaults = JSON.parse(fs.readFileSync(path.join(root, 'config/codex-models.json'), 'utf8')).uiDefaults;
if (!catalog.models?.length || catalog.models.some(model => typeof model.id !== 'string' || !model.id)) throw new Error('Codex вернул пустой или некорректный каталог');
fs.writeFileSync(path.join(root, 'config/codex-models.json'), JSON.stringify(catalog, null, 2) + '\n');
console.log(`${catalog.version}: ${catalog.models.map(m=>m.id).join(', ')}`);
