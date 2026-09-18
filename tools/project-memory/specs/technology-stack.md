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
| Хранилище аккаунтов | PostgreSQL через pg 8.22.0; транзакции, ledger, tenant JSONB records | src/database/, src/billing/ |
| Legacy/desktop и файлы | JSON, файловые SHA-256 объекты; медиа аккаунтов в отдельных каталогах | src/history.js, assets.js |
| Вход в веб | OAuth Google, VK ID Code + PKCE; HttpOnly sessions | src/auth/ |
| SQL-тесты | PGlite ^0.5.8, только devDependency | test/helpers/pg-pool.js |
| Очередь | Собственный TaskQueue в main-процессе | src/task-queue.js |
| Интеграция | Kie HTTP API, fetch | src/catalog.js, main.js |
| Тесты | node:test; скрытый Electron smoke | test/, desktop/test/, package.json, desktop/package.json |
| Сборка | electron-builder 26.15.3, Windows NSIS/x64 dir | desktop/package.json |
| Секреты | Electron safeStorage | desktop/src/main.js |
| Секреты web/bot | Server environment, .env вне Git | .env.example, src/server/config.js |

Команды: pnpm install --frozen-lockfile, pnpm start, pnpm check, pnpm test, pnpm --dir desktop exec electron test/ui-smoke.cjs, pnpm pack:desktop, pnpm dist:desktop. Подробности и ограничения — в tools/AGENT_RUNBOOK.md.

Веб-команды: pnpm start:web, pnpm dev:web, pnpm check:web. Версия внешнего Node и pnpm не закреплена в package.json; web требует Node >=22.9 из-за --env-file-if-exists. Electron включает собственный Node. Нет настроенного линтера, TypeScript или vector store. PostgreSQL продуктовых аккаунтов добавлен 2026-09-18; конфигурация живой БД требуется отдельно. Python-инструмент GI code_intelligence не является зависимостью приложения; интеграция выключена.
