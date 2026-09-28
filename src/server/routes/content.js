async function handleSourceUpload({ req, url, user, accounts, selected, service, config, send, reserveUpload }) {
  const type = (req.headers['content-type'] || '').split(';')[0];
  if (!/^(image\/(png|jpeg|webp|gif)|video\/(mp4|webm|quicktime)|audio\/[a-z0-9.+-]+)$/.test(type))
    return send(400, { error: 'Этот тип исходника не поддерживается', code: 'UNSUPPORTED_MEDIA_TYPE' });
  const declared = Number(req.headers['content-length']);
  const reservation = Number.isSafeInteger(declared) && declared > 0 ? declared : config.uploadLimit;
  if (reservation > config.uploadLimit) return send(413, { error: 'Файл слишком большой' });
  return reserveUpload(reservation, async () => {
    const binding = accounts ? await accounts.workspaces.assertBinding(selected || user.id,
      url.searchParams.get('projectId') || undefined, url.searchParams.get('chatId') || undefined) : {};
    const saved = await service.saveSource({ name: url.searchParams.get('name') || 'source', type,
      stream: req, limit: config.uploadLimit, ...binding });
    return send(200, { result: saved });
  });
}

async function handleContentRead({ url, user, selected, accounts, service, sendMedia, sendStored, sendFile }) {
  const source = /^\/api\/sources\/([a-f0-9]{64})$/.exec(url.pathname);
  if (source) {
    const file = await service.sourceFile(source[1]);
    return sendMedia(() => file.storageKey ? sendStored(file) : sendFile(file.path, file.type));
  }
  const result = /^\/api\/results\/([a-f0-9-]{36})\/(\d+)$/.exec(url.pathname);
  if (result) {
    const attachment = url.searchParams.has('download');
    let file;
    try { file = await service.resultFile(result[1], Number(result[2])); }
    catch (error) {
      if (!attachment || (error.code !== 'RESULT_NOT_FOUND' && ![404, 409].includes(error.status))) throw error;
      await service.saveResults(result[1]);
      file = await service.resultFile(result[1], Number(result[2]));
    }
    return sendMedia(() => file.storageKey ? sendStored(file, attachment) : sendFile(file.path, null, attachment));
  }
  const content = /^\/api\/content\/([a-f0-9-]{36})$/.exec(url.pathname);
  if (content) {
    if (!accounts?.content) throw Object.assign(new Error('Хранилище контента не подключено'), { status: 503 });
    const file = await accounts.content.file(selected || user.id, content[1]);
    const attachment = url.searchParams.has('download') || file.type === 'image/svg+xml';
    return file.storageKey ? sendStored(file, attachment) : sendFile(file.path, file.type, attachment);
  }
}

module.exports = { handleSourceUpload, handleContentRead };
