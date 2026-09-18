# Команды проекта

Все команды выполняются из корня репозитория, если не указано иное. Веб/Telegram — корень; Windows — desktop/.

| Действие | Команда |
| --- | --- |
| Зависимости веба | pnpm install --frozen-lockfile |
| Запуск веба и настроенного бота | pnpm start |
| Проверка веба | pnpm check |
| Тесты веба | pnpm test |
| Зависимости Windows | pnpm --dir desktop install --frozen-lockfile |
| Запуск Windows | pnpm start:desktop |
| Проверка Windows | pnpm check:desktop |
| Тесты Windows | pnpm test:desktop |
| Скрытый UI smoke | pnpm --dir desktop exec electron test/ui-smoke.cjs --disable-gpu |
| Веб UI аккаунтов (скрытый, изолированная БД) | pnpm --dir desktop exec electron ../test/web-ui-smoke.cjs --disable-gpu |
| Папка Windows x64 | pnpm pack:desktop |
| Установщик NSIS | pnpm dist:desktop |
| Docker сборка и запуск | docker compose up -d --build |
| Docker состояние | docker compose ps |
| Docker остановка | docker compose down |
| Проверка diff | git diff --check |

Единственный output: desktop/dist/queue-header. EXE: desktop/dist/queue-header/win-unpacked/AI Media Client.exe. Не обходить desktop/scripts/single-distribution.cjs. Если EXE занят, закрыть приложение штатно с сохранением черновиков. Для smoke пакета задайте AI_CLIENT_PACKAGED_PATH абсолютным путём к desktop/dist/queue-header/win-unpacked/resources/app.asar и добавьте --packaged к smoke-команде.

Веб: http://127.0.0.1:3000; health: /api/health. Конфиг: .env, образец .env.example. Данные: data/service, включая logs/generation.jsonl. Docker монтирует тот же каталог. Остановка Node: Ctrl+C. Не запускайте одновременно Node и Docker с одними данными.

Dockerfile и контекст сборки находятся в корне. Образ содержит только веб и Telegram; desktop/ исключён allowlist в .dockerignore. На хостинге: порт 3000, MEDIA_HOST=0.0.0.0, MEDIA_PUBLIC_ORIGIN=https://ваш-домен.

Профиль Electron, история, ключи и черновики остаются в прежнем userData. Не читать его без отдельной задачи. Каталог обновляется командами node scripts/import-kie.js и node scripts/import-special.js из desktop/ (сетевые операции).

GI: tools/agent-start.ps1 и tools/check-instruction-kit-updates.ps1. Настройки источника: tools/project-memory/instruction-kit.json.

Продуктовые инструкции: [веб и Telegram](../docs/web-and-telegram.md), [логирование](../docs/generation-logging.md).

Аккаунты: [PostgreSQL/OAuth/кредиты](../docs/accounts-and-credits.md). По умолчанию
MEDIA_AUTH_ENABLED=true; DATABASE_URL обязателен. `.env.example` содержит только
пустые секреты. Для полноценного входа нужны Google/VK приложения и HTTPS origin.
Схема v1 применяется на старте транзакционно, старая JSON-история не мигрирует.
Тарифы config/native-prices.json пусты до принятия коммерческих цен.
Docker копирует этот конфиг. В auth-режиме Telegram отключён до привязки аккаунтов.
