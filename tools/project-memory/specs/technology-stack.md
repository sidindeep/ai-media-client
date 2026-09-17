# Технологический стек

Проверено: 2026-09-17. Канонический файл, связан из AGENTS.md и README.

| Слой | Технология | Доказательство |
| --- | --- | --- |
| Язык | JavaScript CommonJS, HTML, CSS | package.json, src/ |
| Runtime/UI | Electron 44.3.0, обычный DOM | package.json, src/index.html |
| Валидация | AJV ^8.20.0 | package.json, src/main.js |
| Пакеты | pnpm, pnpm-lock.yaml | README.md, lockfile |
| Инструменты импорта | yaml ^2.9.0 | package.json, scripts/ |
| Хранилище продукта | JSON и файловые SHA-256 объекты | src/history.js, assets.js |
| Очередь | Собственный TaskQueue в main-процессе | src/task-queue.js |
| Интеграция | Kie HTTP API, fetch | src/catalog.js, main.js |
| Тесты | node:test; скрытый Electron smoke | test/, package.json |
| Сборка | electron-builder 26.15.3, Windows NSIS/x64 dir | package.json |
| Секреты | Electron safeStorage | src/main.js |

Команды: pnpm install --frozen-lockfile, pnpm start, pnpm check, pnpm test, pnpm exec electron test/ui-smoke.cjs, pnpm run pack, pnpm run dist. Подробности и ограничения — в tools/AGENT_RUNBOOK.md.

Версия внешнего Node и pnpm не закреплена в package.json. Electron включает собственный Node; его точная версия не проверялась запуском. Нет настроенного линтера, TypeScript, собственного backend-сервиса, SQL-БД продукта или vector store. Python-инструмент GI code_intelligence не является зависимостью приложения; интеграция выключена.
