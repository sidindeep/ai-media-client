# Технологический стек

Проверено: 2026-09-19. Канонический файл, связан из AGENTS.md и README.

| Слой | Технология | Доказательство |
| --- | --- | --- |
| Язык | JavaScript CommonJS для backend/legacy UI; TypeScript для нового web UI | package.json, src/, web/ |
| Runtime/UI | Vue 3.5 + Pinia 3 + Vue Router 4 для `/app`; legacy web DOM остаётся на `/` до завершения миграции; Electron 44.3.0 — архивный прототип | package.json, web/src/, src/server/http.js, desktop/package.json |
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
| Сборка | Vite 8 для web `/app`; electron-builder 26.15.3, Windows NSIS/x64 dir для архивного прототипа | web/vite.config.mts, package.json, desktop/package.json |
| Проверка web UI | vue-tsc 3.3.11, `pnpm check:web:vue` | web/tsconfig.json, package.json |
| Секреты | Electron safeStorage | desktop/src/main.js |
| Секреты web/bot | Server environment, .env вне Git | .env.example, src/server/config.js |

Команды: pnpm install --frozen-lockfile, pnpm start, pnpm check, pnpm test, pnpm build:web, pnpm check:web:vue, pnpm --dir desktop exec electron test/ui-smoke.cjs, pnpm pack:desktop, pnpm dist:desktop. Подробности и ограничения — в tools/AGENT_RUNBOOK.md.

Веб-команды: pnpm start:web, pnpm dev:web, pnpm build:web, pnpm check:web, pnpm check:web:vue. Версия внешнего Node и pnpm не закреплена в package.json; web требует Node >=22.9 из-за --env-file-if-exists. Electron включает собственный Node. Линтер и vector store не настроены; TypeScript включён только для нового web UI. PostgreSQL продуктовых аккаунтов добавлен 2026-09-18; конфигурация живой БД требуется отдельно. Python-инструмент GI code_intelligence не является зависимостью приложения; интеграция выключена.
