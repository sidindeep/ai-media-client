const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { codexArguments, codexPrompt } = require('./codex-request');
const { collectImage } = require('./codex-images');
const { parseCodexOutput } = require('./codex-usage');
const { codexEnvironment } = require('./codex-runtime');

async function execute(request, { signal } = {}) {
  if (signal?.aborted) throw new Error('Сервис Codex остановлен.');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'media-codex-'));
  try {
    const imagePaths = [];
    for (const [index, image] of (request.images || []).entries()) { const match = /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(image); if (match) { const filename = path.join(directory, `reference-${index}.${match[1] === 'jpeg' ? 'jpg' : match[1]}`); await fs.writeFile(filename, Buffer.from(match[2], 'base64')); imagePaths.push(filename); } }
    const output = await new Promise((resolve, reject) => {
      const child = spawn('codex', codexArguments(request, imagePaths), { cwd: directory, env: codexEnvironment(), detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '', errorText = '', failure;
      const stop = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } };
      const abort = () => { failure = new Error('Сервис Codex остановлен.'); stop(); };
      signal?.addEventListener('abort', abort, { once: true });
      const timeout = request.kind === 'image' ? 300000 : 180000;
      const timer = setTimeout(() => { failure = new Error('Codex не завершил запрос за отведённое время.'); stop(); }, timeout);
      if (signal?.aborted) abort();
      child.on('error', () => { clearTimeout(timer); reject(new Error('Не удалось запустить Codex.')); });
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { output += chunk; if (Buffer.byteLength(output) > 1024 * 1024) { failure = new Error('Ответ Codex слишком большой.'); stop(); } });
      child.stderr.on('data', chunk => { errorText = (errorText + chunk).slice(-16000); });
      child.stdin.on('error', () => {});
      child.on('close', code => {
        signal?.removeEventListener('abort', abort);
        clearTimeout(timer);
        if (failure) return reject(failure);
        if (code !== 0 || !output.trim()) {
          const message = /usage limit|rate limit|quota/i.test(errorText) ? 'Достигнут лимит Codex. Повторите позже.'
            : /log in|login|unauthorized|401/i.test(errorText) ? 'Требуется повторный вход Codex на сервере.'
              : /service.tier|fast mode|unsupported/i.test(errorText) ? 'Модель или выбранный режим недоступны этому аккаунту.'
                : 'Codex не выполнил запрос. Проверьте доступность модели и вход на сервере.';
          return reject(new Error(message));
        }
        resolve(output.trim());
      });
      child.stdin.end(codexPrompt(request));
    });
    const parsed = parseCodexOutput(output);
    if (request.kind !== 'image') {
      if (!parsed.output) throw new Error('Codex не вернул текст ответа.');
      return { output: parsed.output, usage: parsed.usage };
    }
    // CLI JSONL omits binary image content. Only collect this run's generated file,
    // identified by the trusted thread.started event, never a model-provided path.
    const threadId = parsed.threadId;
    const image = await collectImage(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), threadId);
    try { return { output: 'Изображение создано.', imageBase64: image.buffer.toString('base64'), usage: parsed.usage }; }
    finally { await fs.rm(image.directory, { recursive: true, force: true }); }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
module.exports = { execute };
