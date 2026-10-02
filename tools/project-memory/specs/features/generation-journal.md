# Два журнала генераций

Статус: пользовательский журнал и диагностический JSONL действуют независимо.
Их нельзя смешивать при восстановлении задач или сверке денег.

## Пользовательские события в PostgreSQL

Каждый аккаунт имеет append-only namespace `generation-journal`. Событие
создания Kie входит в ту же атомарную запись, что задача и денежный резерв;
другие переходы Kie, RouterAI, APIMart и Codex пишутся вместе с соответствующим
изменением состояния. Удаление карточки не удаляет события журнала. Счётчик
`created` означает задачи, а `submitting`/`send_start` — попытки отправки;
попытка не доказывает принятие или списание у провайдера. Реальные списания
определяются только ledger.

Чтение ограничено аккаунтом, фильтруется по провайдеру и выдаётся страницами
по 50. Обычному пользователю не показываются внешний ID задачи, себестоимость
провайдера и сырая ошибка; промпты, ответы, ключи и файлы сюда не записываются.

## Техническая диагностика ai_logger — 2026-09-30

Владелец явно запросил исключительную отправку через ai_logger и удаление старой
технической диагностики. `src/system-errors.js` сохраняет record/flush и добавляет
step; запись в application PostgreSQL отсутствует. Миграция v21 удаляет
media_system_errors со всеми строками. Исторические миграции неизменны.
`src/generation-log.js` сохраняет context/run/request/step/tracedFetch/secret/clean,
но отправляет только безопасные метаданные и больше не пишет generation.jsonl,
не копирует и не читает тело ответа ради диагностики. Пользовательские ошибки
в задачах и бизнес-журнал остаются данными продукта.

Единственный технический sink — HTTP ingest из AI_LOGGER_SERVER_URL с проектом
автоматическим project=ai-media-client и ролью процесса. Общий recorder имеет ограниченную очередь,
защиту in-flight, retry, bounded drain и close. Локальный fallback отключён.
Приватные сообщения и details не передаются в открытый API. Центр хранит записи
в ai_logger_records; чтение /api/agent/logs через scripts/read-central-errors.cjs.
Отдельный ai_logger_system_errors не используется.

Критичные границы: загрузка/валидация config, data-directory, providers, storage,
media-service, database/model config, content/accounts, payment recovery,
generation recovery, HTTP listen, Telegram. Ошибки процесса до БД, uncaught
exception, unhandled rejection и shutdown отправляются перед завершением.
Во время работы: БД/LISTEN, очередь/результаты, контент/S3, платежи, Telegram и API.
Нельзя повторять платную генерацию ради диагностического retry.

Доказательства и точные команды: docs/generation-logging.md; test/ai-logger.test.js,
system-errors.test.js, generation-log.test.js, provider-diagnostics.test.js,
routerai.test.js и database-migrations.test.js. Политика удаления явная; прежнее
условие ожидания private HTTP ingest отозвано владельцем. Полные приватные
технические сообщения теперь не хранятся; владелец задачи получает её ошибку
из бизнес-записи. При обновлении общей схемы до21 старые приложения до20 должны
быть обновлены на всех площадках до перезапуска.
## Проверенная очистка — 2026-09-30

Рабочая общая БД обновлена до схемы v21; to_regclass('media_system_errors')
вернул null. Перед очисткой таблица содержала 661 диагностическую строку.
Удалены два существовавших project-owned файла generation.jsonl и его .1.
Новые события запуска прочитаны из размещённого ai_logger через HTTP-reader.
Предварительные 63 контейнерных теста прошли, включая upgrade с удалением только
технической таблицы и доставку startup-error до БД. Итоговые Docker-проверки
после очистки выполняются по runbook; прежний checksum baseline/migrations
не изменялся. Новую схему нельзя запускать приложением с миграциями только до20.

Итоговая проверка: полный контейнерный runbook прошёл — 317 тестов, backend
syntax, async-safety, Vue type-check и build. После уточнения config-stage
повторены 9 целевых тестов на свежем образе. Реальная hosted-проверка:
startup-check-c1d60342-6d22-4fb8-b52c-ecc306714475 — config.error / CONFIG_INVALID
прочитан через /api/agent/logs, приватная строка отсутствует; тестовый процесс
завершился с кодом1, рабочий API остался healthy. Общая схема21 и отсутствие
media_system_errors подтверждены повторно; generation.jsonl и .1 не созданы.

## Подробная диагностика — обновлённый HTTP-контракт 2026-09-30

Исходный Error из перехвата передаётся в recorder без пересоздания. HTTP-sink
выбирает row.exception и row.diagnostic, отправляет очищенные type/message/
stack_trace и description/file/line/function/entity. Код и событие сохраняются;
для бизнес-строки без Error стек не выдумывается. Сущности обозначают тип
компонента без аккаунтных данных. Файл, строка и функция берутся из исходного
стека. Очищаются секреты, cookie, prompt/account/email, URL credentials/query
и JSON payload в текстах. Произвольные details остаются вне HTTP.

Проект и instance_id автоматически определяются единым resolver
`src/ai-logger/identity.js`: project=ai-media-client, instance_id=hostname:PID.
Каждая реплика сообщает собственную фактическую идентичность без ручной
конфигурации. Старые AI_LOGGER_PROJECT/AI_LOGGER_INSTANCE_ID игнорируются;
Compose не требует их. AI_LOGGER_SERVICE задан отдельно executor/web.
Reader и проверка доставки используют тот же resolver; при пересоздании
контейнера hostname и instance_id могут измениться.
Новые миграции, удаление таблиц/журналов и подмена DATABASE_URL не требуются.
Существующие bounded drain/retry/in-flight/close и локальные продуктовые записи
сохраняются. Перехваты RouterAI/APIMart/Codex пишут Error до его преобразования
в состояние задачи; startup/config/process/queue используют общий адаптер.

Контейнерная доставка проверяется scripts/verify-central-diagnostics.cjs по
уникальному маркеру через /api/agent/logs; тесты ai-logger/system-errors/
startup-logging защищают исходный стек, фильтрацию и автоматическую идентичность/роли.

## Совместимость других ПК при общей БД

Уточнение 2026-09-30: успешные studio-события page.served/history.loaded/sync.loaded
проходят через `system-errors.info` (INFO), не через error recorder. Строковые
ошибки сохраняют очищенный description; HTTP-ошибки Codex получают
`CODEX_HTTP_<status>`. Telegram API сообщает безопасные method/HTTP/API code,
не raw response; штатная отмена polling не отправляется как ERROR.
Пул освобождает idle соединения через 30 секунд; TCP keepalive начинается через
10 секунд. LISTEN проверяет связь SELECT 1 каждые 30 секунд (timeout 5 секунд),
удаляет обработчики при закрытии, уничтожает потерянное соединение и
переподписывается с bounded backoff. Изменение не повторяет SQL-записи или
платные отправки и не меняет DATABASE_URL. Codex 404 сохраняет unknown и резерв;
отсутствующий результат не восстанавливается повторной платной генерацией.
Worker публикует success/failed в памяти только после атомарной записи итоговой
JSON-записи (и PNG для изображения). Это исключает ранний success с ещё
сохранённым running, который после рестарта превращался в unknown.
Покрытие: `test/database-change-events.test.js`, `test/system-errors.test.js`,
`test/web-service.test.js`, существующие сценарии Codex unknown/restart.

2026-09-30: опубликованный master 5f1b47c содержал миграции только до v20,
а локальный Docker был собран с незакоммиченной миграцией v21 и уже обновил
общую БД. Поэтому pull последнего коммита на другом ПК сохранял
DATABASE_VERSION_NEWER и HTTP 503. Исправление должно включать миграцию v21
и переход runtime на центральную диагностику: прежний runtime обращался
к удалённой media_system_errors. До применения следующих миграций общей
БД совместимый пакет должен быть доступен в Git всем рабочим установкам.

## Контекст ошибок генерации — 2026-10-01

Явное решение владельца: ERROR-диагностика генерации передаёт промпт и ссылки
на исходники в ai_logger. Это исключение из прежнего запрета prompts в HTTP;
бизнес-журнал остаётся без промптов и медиа. Отдельная generation allowlist
в recorder/client выбирает context.prompt (32768 символов), source_urls
(до 100 по 2048), provider/model/job_id/request_id; очищает секреты и
credentials/query/fragment. Произвольные details и INFO не получают эти поля.
Reader открыт: текст промпта доступен читателям ai_logger.

Общий builder src/ai-logger/generation-context.mjs берёт исходный запрос
(prompt/input.prompt/payload.prompt, sourceFiles/input/parameters/payload),
собирает устойчивые ссылки на owner-protected content/sources, не публикует S3,
не пересылает байты и resultUrls. Без исходника список пустой. Внешние URL не
означают архивирования файлов. Контекст передают journal всех четырёх
провайдеров, Kie trace.run и явные перехваты Codex/RouterAI/APIMart. Старые
логи не переписываются. Original Error, код, стек и текущая БД сохраняются.
Проверки: test/generation-error-context.test.js; scripts/verify-central-diagnostics.cjs
проверяет реальный ingest/readback на синтетических данных.

Классификатор src/provider-errors.js узнаёт Content review failed и китайский
эквивалент; код 1501 сам по себе остаётся unknown. publicRecord обновляет
пояснение старых неизвестных ошибок при чтении, без записи истории/миграций.

Codex worker также передаёт контекст исходного запроса для run.error и
persist.error; images/base64 и account ID не включаются. Compose передаёт
MEDIA_PUBLIC_ORIGIN worker для абсолютных ссылок на исходники.
