const { AccountRecords } = require('../database/records');
const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const limits = require('../../config/movie-editor.json');
function createMovieDrafts({ pool, workspaces, content, sourceFile, resultFile, generatedFile }) {
  async function key(owner, projectId) {
    if (!projectId) return 'account';
    if (!UUID.test(projectId)) throw bad('Проект не найден', 404);
    await workspaces.assertBinding(owner, projectId);
    return `project:${projectId}`;
  }
  async function source(owner, value) {
    const generated = /^\/api\/(codex|routerai)\/jobs\/([a-f0-9-]{36})\/image$/.exec(value || '');
    if (generated && generatedFile) return generatedFile(owner, generated[1], generated[2]);
    const match = /^\/api\/(content\/([a-f0-9-]{36})|sources\/([a-f0-9]{64})|results\/([a-f0-9-]{36})\/(\d+))$/.exec(value || '');
    if (!match) throw bad('Материал черновика должен быть сохранён в аккаунте');
    const file = match[2] ? await content?.file(owner, match[2]) : match[3]
      ? await sourceFile(owner, match[3]) : await resultFile(owner, match[4], Number(match[5]));
    if (!file) throw bad('Материал недоступен', 404);
    return file;
  }
  async function validate(owner, value) {
    if (!value || !Array.isArray(value.scenes) || value.scenes.length > limits.maxScenes || JSON.stringify(value).length > 100000) throw bad('Некорректный черновик');
    if (!['portrait', 'landscape', 'square'].includes(value.format) || !/^#[a-f0-9]{6}$/i.test(value.background)
      || typeof value.muteClips !== 'boolean') throw bad('Некорректные параметры ролика');
    const ids = new Set();
    const scenes = [];
    for (const scene of value.scenes) {
      if (!UUID.test(scene.id) || ids.has(scene.id) || !['title', 'image', 'video'].includes(scene.kind)
        || typeof scene.title !== 'string' || scene.title.length > 300 || !Number.isFinite(scene.seconds)
        || scene.seconds < (scene.kind === 'video' ? 1 / limits.fps : 1)
        || scene.seconds > (scene.kind === 'video' ? limits.maxSeconds : limits.maxStillSeconds)) throw bad('Некорректная сцена');
      ids.add(scene.id);
      if (scene.kind !== 'title') {
        const file = await source(owner, scene.src);
        if (!file.type.startsWith(scene.kind === 'image' ? 'image/' : 'video/')) throw bad('Неверный тип материала сцены');
      }
      scenes.push({ id: scene.id, kind: scene.kind, title: scene.title, seconds: scene.seconds,
        ...(scene.kind !== 'title' ? { src: scene.src } : {}), name: String(scene.name || '').slice(0, 255) });
    }
    if (value.music && !(await source(owner, value.music)).type.startsWith('audio/')) throw bad('Неверный тип музыки');
    const script = String(value.script || '');
    if (script.length > 8000) throw bad('Сценарий слишком длинный');
    const state = value.scenarioState || { modelId: '' };
    if (typeof state.modelId !== 'string' || !/^[a-zA-Z0-9._-]{0,100}$/.test(state.modelId)) throw bad('Некорректная модель сценария');
    const scenarioState = { modelId: state.modelId };
    if (state.pending) {
      if (!UUID.test(state.pending.id)) throw bad('Некорректное задание сценария');
      const pending = await validate(owner, { ...value, scenes: state.pending.sources, scenarioState: undefined });
      scenarioState.pending = { id: state.pending.id, sources: pending.scenes };
    }
    return { scenes, format: value.format, background: value.background, muteClips: value.muteClips,
      music: value.music || '', musicName: String(value.musicName || '').slice(0, 255), script,
      sourceLink: String(value.sourceLink || '').slice(0, 2048), scenarioState };
  }
  return {
    async read(owner, projectId) { return new AccountRecords(pool, owner, 'movie-drafts').get(await key(owner, projectId)); },
    async save(owner, projectId, input) {
      const id = await key(owner, projectId);
      if (!Number.isSafeInteger(input.revision) || input.revision < 0) throw bad('Некорректная версия черновика');
      const value = await validate(owner, input.draft);
      const draft = { ...value, revision: input.revision + 1, updatedAt: new Date().toISOString() };
      const result = input.revision === 0
        ? await pool.query("INSERT INTO media_records(account_id,namespace,id,data) VALUES($1,'movie-drafts',$2,$3) ON CONFLICT DO NOTHING RETURNING id", [owner, id, JSON.stringify(draft)])
        : await pool.query("UPDATE media_records SET data=$3,updated_at=now() WHERE account_id=$1 AND namespace='movie-drafts' AND id=$2 AND (data->>'revision')::int=$4 RETURNING id", [owner, id, JSON.stringify(draft), input.revision]);
      if (!result.rowCount) throw bad('Черновик изменён в другой вкладке. Обновите страницу перед продолжением.', 409);
      if (content) {
        const refs = [...value.scenes.map(scene => scene.src), value.music].filter(Boolean);
        for (let position = 0; position < refs.length; position++) {
          const asset = /^\/api\/content\/([a-f0-9-]{36})$/.exec(refs[position]);
          if (asset) {
            try { await content.link(owner, 'movie-drafts', id, asset[1], 'source', position); }
            catch (error) { require('../system-errors').record('remotion', 'movie.draft.link.error', error); }
          }
        }
      }
      return draft;
    },
  };
}
module.exports = { createMovieDrafts };
