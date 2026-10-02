const { codexPrompt } = require('./codex-request');
const { readPublicPage, pageUrl } = require('./codex-page-reader');
const systemErrors = require('../system-errors');

function requestedPages(request) {
  if (request.kind === 'image' || /(?:не\s+(?:ищи|открывай|изучай|используй\s+(?:интернет|поиск|браузер))|без\s+(?:интернета|поиска|браузера)|do\s+not\s+(?:browse|search|open)|don['’]t\s+(?:browse|search|open)|no\s+(?:browsing|web\s+search))/iu.test(request.prompt)) return [];
  if (!/(?:изучи|изучить|исследуй|открой|прочитай|проанализируй|проверь|посмотри|study|inspect|research|open|read|review|analy[sz]e|check|look\s+at)/iu.test(request.prompt)) return [];
  const candidates = request.prompt.match(/https:\/\/[^\s<>"'`]+/gu) || [];
  return [...new Set(candidates.map(value => value.replace(/[.,;!?)\]}]+$/u, '')).filter(value => { try { pageUrl(value); return true; } catch { return false; } }))].slice(0, 2);
}

async function prepareCodexPrompt(request, { signal, readPage = readPublicPage } = {}) {
  const pages = [];
  for (const url of requestedPages(request)) {
    if (signal?.aborted) throw new Error('Сервис Codex остановлен.');
    try { pages.push({ requestedUrl: url, ...await readPage(url, { signal }) }); }
    catch {
      if (signal?.aborted) throw new Error('Сервис Codex остановлен.');
      systemErrors.record('provider', 'codex-web-page.read.error', new Error('Public page rendering failed or exceeded service limits'),
        { diagnostic: { entity: 'public-page-reader' } });
      pages.push({ requestedUrl: url, error: 'The service could not render this public page within its network, resource or time limits. Try the built-in web tool; report only verified observations.' });
    }
  }
  return codexPrompt(request, pages);
}
module.exports = { prepareCodexPrompt, requestedPages };
