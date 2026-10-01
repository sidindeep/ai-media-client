# Команды проекта

Все команды выполняются из корня репозитория, если не указано иное. Веб/Telegram — корень; Windows — desktop/.

| Действие | Команда |
| --- | --- |
| Зависимости веба | pnpm install --frozen-lockfile |
| Запуск веба и настроенного бота | pnpm start |
| Проверка веба | pnpm check |
| Проверка опасных async-паттернов backend | pnpm check:async-safety |
| Тесты веба | pnpm test |
| Полные контейнерные тесты с PostgreSQL и Vue | docker compose --profile test run --build --rm tests |
| Браузерный smoke в изолированной PostgreSQL | docker compose --profile test run --build --rm browser-tests |
| Зависимости Windows | pnpm --dir desktop install --frozen-lockfile |
| Запуск Windows | pnpm start:desktop |
| Проверка Windows | pnpm check:desktop |
| Тесты Windows | pnpm test:desktop |
| Скрытый UI smoke | pnpm --dir desktop exec electron test/ui-smoke.cjs --disable-gpu |
| Веб UI аккаунтов (скрытый, изолированная БД) | pnpm --dir desktop exec electron ../test/web-ui-smoke.cjs --disable-gpu |
| Папка Windows x64 | pnpm pack:desktop |
| Установщик NSIS | pnpm dist:desktop |
| Docker сборка и запуск | docker compose up -d --build |
| Общий словарь всех параметров Kie/APIMart | node scripts/sync-parameter-correspondence.cjs |
| Подготовить новую заливку | pnpm release:bump |
| Docker состояние | docker compose ps |
| Миграции БД отдельной ролью | docker compose run --rm media node scripts/migrate-schema.cjs |
| Синхронизировать единую таблицу и Markdown | node scripts/sync-model-routes.cjs |
| Импортировать единую таблицу моделей в БД | docker compose exec -T media node scripts/import-service-model-config.cjs |
| Read-only проверка данных перед DDL | docker compose exec -T media node scripts/database-preflight.cjs |
| Выдать права ограниченной роли | docker compose run --rm media node scripts/grant-runtime-role.cjs |
| Нагрузка на один отдельный Compose без генераций | [tools/load-test/README.md](load-test/README.md) |
| Обновить архивный снимок Codex для начальных настроек | node scripts/sync-codex-models.cjs |
| Зарегистрировать и перенести legacy-контент в каталог/S3 | pnpm migrate:content |
| Сверить каталог контента с S3 без удаления | pnpm audit:content |
| Проверить эксплуатационные алерты (код выхода 2 при срабатывании) | pnpm check:operations |
| Пилот exec/app-server (реальный расход, только с бюджетом 6 текстов + 6 PNG) | node scripts/benchmark-codex-transports.cjs --docker --live |
| Ступени генераций Codex (реальный расход, до 127 запросов при потолке 64) | node scripts/benchmark-codex-capacity.cjs --docker --live --kind=image --transport=app-server --max-concurrency=64 |
| Docker остановка | docker compose down |
| Проверка diff | git diff --check |

Обязательный порядок после каждой правки: завершить целостный пакет изменений → `docker compose up -d --build` → дождаться готовности сервисов → проверить `docker compose ps` и `Invoke-RestMethod -Uri http://127.0.0.1:3000/api/health` → только затем выполнять и засчитывать итоговые проверки изменённого поведения. Проверки, выполненные до Docker-пересборки или только на host runtime, являются предварительными и должны быть повторены в нужном объёме на свежем контейнере. Если Docker-сборка, сервисы или health не подтверждены, задача остаётся незавершённой с явным blocker.

Команды desktop выше относятся к архивному клиенту: исходного `desktop/` в текущем checkout нет. Если владелец решит вернуть клиент, единственным output будет desktop/dist/queue-header; нельзя обходить desktop/scripts/single-distribution.cjs.

Веб: http://127.0.0.1:3000; health: /api/health. Конфиг: .env, образец .env.example. Данные: data/service; технические логи доступны через ai_logger. Docker монтирует тот же каталог. Остановка Node: Ctrl+C. Не запускайте одновременно Node и Docker с одними данными.

Dockerfile и контекст сборки находятся в корне. Образ содержит веб, Telegram и Codex CLI; desktop/ исключён allowlist в .dockerignore. На хостинге worker Codex запускается автоматически на loopback, авторизация сохраняется в /app/data/codex-auth. Compose отключает встроенный worker и использует отдельный codex. На хостинге: MEDIA_HOST=0.0.0.0, MEDIA_PUBLIC_ORIGIN=https://ваш-домен; порт MEDIA_PORT или PORT, по умолчанию 3000. Инструкция Bothost и входа: [Codex](../docs/codex.md).

Переключатель провайдера разделяет Kie.ai (изображения/видео) и Codex CLI
(изображения и текст). Для Codex выбираются тип результата, модель, уровень рассуждения и обычная/Fast
скорость. Все пользователи с кредитным счётом используют серверный аккаунт
Codex и платят внутренними кредитами. Настройка и тарифы:
[Codex в вебе](../docs/codex.md).

Веб получает живой каталог через `GET /api/codex/models` от своего Codex worker;
worker запрашивает `model/list` текущего авторизованного app-server. Архивный
`config/codex-models.json` хранит начальные настройки и имена старых моделей.
Команда `scripts/sync-codex-models.cjs` обновляет только этот снимок через
сервис `codex` текущего Compose-проекта и для появления новых моделей в меню не нужна.
После изменения снимка или тарифов пересобрать оба контейнера.
Сервис `codex` собирается самостоятельно из `Dockerfile.codex`, устанавливая
Codex CLI; внешний проект или образ провайдеров не нужен. Compose создаёт
собственный том `ai-media-codex-auth`. Повторный вход на хосте:
`docker compose exec codex codex login --device-auth` — открыть выданную ссылку
в своём браузере и ввести код из терминала хоста.

Исторический профиль Electron, ключи и черновики не читать без отдельной задачи. Команды импорта из `desktop/` доступны только после восстановления архива.

GI: tools/agent-start.ps1 и tools/check-instruction-kit-updates.ps1. Настройки источника: tools/project-memory/instruction-kit.json.

Продуктовые инструкции: [веб и Telegram](../docs/web-and-telegram.md), [логирование](../docs/generation-logging.md).

Аккаунты: [PostgreSQL/OAuth/кредиты](../docs/accounts-and-credits.md). По умолчанию
MEDIA_AUTH_ENABLED=true; DATABASE_URL обязателен. `.env.example` содержит только
пустые секреты. Для полноценного входа нужны Google/VK приложения и HTTPS origin.
Базовая схема v10 и новые миграции до v21 применяются транзакционно только при необходимости; checksum проверяется при каждом старте. Для отдельного запуска миграций: `docker compose run --rm media node scripts/migrate-schema.cjs`; затем runtime может работать с `MEDIA_DB_MIGRATE=false`. Старая JSON-история не мигрирует.
Перед обновлением общей БД опубликовать совместимый код и все миграции в Git: другие ПК получают только закоммиченные и отправленные файлы. После обновления checkout выполнить `docker compose up -d --build` и проверить health. При `DATABASE_VERSION_NEWER` сверить последнюю миграцию в checkout и контейнере с версией общей БД; повторная пересборка кода без нужной миграции несовместимость не исправляет.
Тарифы config/native-prices.json: опубликованные режимы Codex, включая GPT-6-Sol и GPT-6-Luna, —
10 внутренних кредитов за запрос по решению владельца от 2026-10-01;
остальные цены публикуются отдельно.
Docker копирует этот конфиг. В auth-режиме Telegram работает для пользователей с подтверждённой привязкой при настроенном токене.

Central diagnostic metadata: `docker compose exec -T media node scripts/read-central-errors.cjs 50`.
The reader uses only HTTP; it does not connect to logger PostgreSQL. Legacy media_system_errors is removed by schema v21.
