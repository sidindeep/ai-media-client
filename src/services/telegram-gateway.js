const trace = require('../generation-log');
const path = require('node:path');
const { History } = require('../history');
const { createTelegramBot } = require('./telegram-bot');
const { setTimeout: delay } = require('node:timers/promises');
function createTelegramGateway({ service, config, directory, fetchImpl = fetch, accountMode = false, accounts = null, telegramLinks = null }) {
  let accountServices = { accounts, telegramLinks };
  const state = new History(path.join(directory, 'telegram-polling.json'));
  let running = false, loop, controller, lastError = null, notificationBusy = false;
  const enabled = config.enabled && Boolean(config.token);
  async function call(method, body, signal) {
    try {
      const response = await fetchImpl(`https://api.telegram.org/bot${config.token}/${method}`, {
        method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(35000)]) : AbortSignal.timeout(35000)
      });
      const result = await response.json();
      trace.write('telegram.response',{method,httpStatus:response.status,ok:result.ok,errorCode:result.error_code});
      if (!response.ok || !result.ok) throw new Error();
      return result.result;
    } catch { trace.write('telegram.error',{method});throw new Error('Telegram временно недоступен'); }
  }
  const resolveAccount = async telegramUserId => {
    if (!accountMode) return { service };
    if (!accountServices.accounts || !accountServices.telegramLinks) return null;
    const identity = await accountServices.telegramLinks.accountFor(telegramUserId);
    if (!identity) return null;
    if (accountServices.accounts.starterPack && (await accountServices.accounts.starterPack.status(identity.id, identity.role)).active) return { blocked: true };
    const accountService = await accountServices.accounts.scope(identity, identity.id);
    return { service: { ...accountService, createTelegramTask: (request, token) => accountServices.accounts.createTelegramTask(telegramUserId, request, token) }, accountId: identity.id };
  };
  const bot = createTelegramBot({ service, directory, allowedUsers: config.users, publicAccess: config.publicAccess,
    resolveAccount, completeLink: accountMode ? (token, telegramUserId, username) => {
      if (!accountServices.telegramLinks) throw new Error('Сервис аккаунтов временно недоступен');
      return accountServices.telegramLinks.complete(token, telegramUserId, username);
    } : null,
    downloadFile: async (id, limit) => {
    const file = await call('getFile', { file_id: id });
    if (!file?.file_path || file.file_size > limit || !/^[\w./-]+$/.test(file.file_path) || file.file_path.split('/').includes('..')) throw new Error('Не удалось получить файл Telegram');
    let response;
    try { response = await fetchImpl(`https://api.telegram.org/file/bot${config.token}/${file.file_path}`, { redirect: 'error', signal: AbortSignal.timeout(30000) }); }
    catch { throw new Error('Не удалось скачать файл Telegram'); }
    if (!response.ok || Number(response.headers.get('content-length')) > limit) throw new Error('Файл Telegram недоступен или слишком большой');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > limit) throw new Error('Файл слишком большой'); chunks.push(chunk); }
    return Buffer.concat(chunks);
  } });
  async function notifications() {
    if (notificationBusy) return; notificationBusy = true;
    try {
      if (accountMode) {
        if (!accountServices.telegramLinks || !accountServices.accounts) return;
        for (const item of await accountServices.telegramLinks.pendingNotifications()) {
          if (config.publicAccess === false && !config.users.includes(String(item.telegram_user_id))) continue;
          const record = item.data;
          const accountService = await accountServices.accounts.get(item.account_id);
          const text = record.state === 'success'
            ? `Готово · ${record.modelName}\n${accountService.resultUrls(record).join('\n')}`
            : `${record.modelName}\n${record.state === 'unknown' ? 'Исход отправки неизвестен. Повторная отправка не выполнялась.' : require('../provider-errors').text(record) || 'Генерация не завершена.'}`;
          await call('sendMessage', { chat_id: item.telegram_user_id, text: text.slice(0, 3900) });
          await accountService.history.update(record.id, { telegramNotified: true });
        }
        return;
      }
      for (const record of await service.history.list()) {
        if (!record.telegramChatId || record.telegramNotified || !['success', 'fail', 'unknown', 'blocked'].includes(record.state)) continue;
        if (config.publicAccess === false && !config.users.includes(String(record.telegramChatId))) continue;
        const text = record.state === 'success'
          ? `Готово · ${record.modelName}\n${service.resultUrls(record).join('\n')}`
          : `${record.modelName}\n${record.state === 'unknown' ? 'Исход отправки неизвестен. Проверьте журнал Kie. Повторная отправка не выполнялась.' : require('../provider-errors').text(record)||'Генерация не завершена. Подробности в истории веб-версии.'}`;
        await call('sendMessage', { chat_id: record.telegramChatId, text: text.slice(0, 3900) });
        await service.history.update(record.id, { telegramNotified: true });
      }
    } finally { notificationBusy = false; }
  }
  async function pollOnce() {
    const offset = (await state.list()).find(row => row.id === 'offset')?.value || 0;
    const updates = await call('getUpdates', { offset, timeout: 5, allowed_updates: ['message', 'callback_query'] }, controller?.signal);
    if (!Array.isArray(updates)) throw new Error('Некорректный ответ Telegram');
    for (const update of updates) {
      if (!Number.isSafeInteger(update.update_id) || update.update_id < offset) continue;
      if (bot.accepts(update)) {
        trace.write('telegram.update',{updateId:update.update_id,kind:update.callback_query?'callback':'message'});
        const callback = update.callback_query;
        if (callback?.id) await call('answerCallbackQuery', { callback_query_id: callback.id }).catch(() => {});
        let response;
        try { response = await bot.handle(update); }
        catch (error) { response = { text: error.code?.startsWith('E') ? 'Не удалось сохранить данные. Повторите позже.' : error.message }; }
        // Persist consumption before outgoing message. Replay never repeats a paid create.
        await state.update('offset', { value: update.update_id + 1 });
        if (response) await call('sendMessage', { chat_id: String((callback?.message || update.message).chat.id), ...response });
      } else await state.update('offset', { value: update.update_id + 1 });
    }
    await notifications();
  }
  return {
    status: () => ({ enabled: running, configured: enabled, lastError }),
    bot, pollOnce,
    setAccountServices(nextAccounts, nextTelegramLinks) { accountServices = { accounts: nextAccounts, telegramLinks: nextTelegramLinks }; },
    async createLink(accountId) {
      if (!accountMode || !enabled || !running || lastError || !accountServices.telegramLinks) throw new Error('Telegram-бот сейчас недоступен. Проверьте его состояние и повторите позже.');
      const me = await call('getMe', {});
      if (!/^[A-Za-z0-9_]{5,32}$/.test(me?.username || '')) throw new Error('Не удалось получить имя Telegram-бота');
      const token = await accountServices.telegramLinks.create(accountId);
      return { url: `https://t.me/${me.username}?start=${token}`, expiresInSeconds: 600 };
    },
    async linkStatus(accountId) {
      if (!accountMode || !accountServices.telegramLinks) return { linked: false, available: false };
      return { ...(await accountServices.telegramLinks.get(accountId)), available: enabled && running && !lastError };
    },
    async unlink(accountId) { if (!accountMode || !accountServices.telegramLinks) return false; return accountServices.telegramLinks.unlink(accountId); },
    start() {
      if (!enabled || running) return;
      trace.write('telegram.start');running = true; controller = new AbortController();
      loop = (async () => {
        while (running) {
          try { await pollOnce(); lastError = null; }
          catch { if (running) { lastError = 'Нет связи с Telegram'; await delay(3000, undefined, { signal: controller.signal }).catch(() => {}); } }
        }
      })();
    },
    async stop() { trace.write('telegram.stop');running = false; controller?.abort(); await loop; }
  };
}
module.exports = { createTelegramGateway };
