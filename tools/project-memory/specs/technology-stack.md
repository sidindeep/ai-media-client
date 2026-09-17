# Технологический стек

Проверено: 2026-09-17. Канонический файл, связан из AGENTS.md и README.

| Слой | Технология | Доказательство |
| --- | --- | --- |
| Язык | JavaScript CommonJS, HTML, CSS | package.json, src/ |
| Runtime/UI | Electron 44.3.0, обычный DOM | desktop/package.json, desktop/src/index.html |
| Web runtime | Node >=22.9, встроенные HTTP/fetch/SSE; проверено 24.14.1 | server.js, src/server/, public/ |
| Telegram | Bot API long polling, private allowlist | src/services/telegram-*.js |
| Валидация | AJV ^8.20.0 | package.json, desktop/src/main.js |
| Пакеты | pnpm, pnpm-lock.yaml | README.md, lockfile |
| Инструменты импорта | yaml ^2.9.0 | desktop/package.json, desktop/scripts/ |
| Хранилище продукта | JSON и файловые SHA-256 объекты | src/history.js, assets.js |
| Очередь | Собственный TaskQueue в main-процессе | src/task-queue.js |
| Интеграция | Kie HTTP API, fetch | src/catalog.js, main.js |
| Тесты | node:test; скрытый Electron smoke | test/, desktop/test/, package.json, desktop/package.json |
| Сборка | electron-builder 26.15.3, Windows NSIS/x64 dir | desktop/package.json |
| Секреты | Electron safeStorage | desktop/src/main.js |
| Секреты web/bot | Server environment, .env вне Git | .env.example, src/server/config.js |

Команды: pnpm install --frozen-lockfile, pnpm start, pnpm check, pnpm test, pnpm --dir desktop exec electron test/ui-smoke.cjs, pnpm pack:desktop, pnpm dist:desktop. Подробности и ограничения — в tools/AGENT_RUNBOOK.md.

Веб-команды: pnpm start:web, pnpm dev:web, pnpm check:web. Версия внешнего Node и pnpm не закреплена в package.json; web требует Node >=22.9 из-за --env-file-if-exists. Electron включает собственный Node. Нет настроенного линтера, TypeScript, SQL-БД продукта или vector store. Python-инструмент GI code_intelligence не является зависимостью приложения; интеграция выключена.
