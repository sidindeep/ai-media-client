# Один экземпляр Compose: веб без платных генераций

`compose.load-test.yaml` запускает отдельный `media` на `127.0.0.1:3001` с
локальными файлами в `data/load-test-service/` и PostgreSQL из игнорируемого
`.env.load-test`. Обычный `compose.yaml` и его БД не изменяются. Kie, RouterAI,
Codex, Telegram и платежи в тестовом контейнере отключены. В рабочей `.env`
не должно быть той же БД: `prepare.cjs` это проверяет перед созданием сессий.

```powershell
docker compose --env-file .env.load-test -f compose.load-test.yaml up -d --build media
Invoke-RestMethod -Uri 'http://127.0.0.1:3001/api/health'
node tools/load-test/prepare.cjs baseline_001 25
docker compose --env-file .env.load-test -f compose.load-test.yaml run --rm -e SESSIONS_FILE=/results/baseline_001/sessions.json -e VUS=5 -e DURATION=30s load run --summary-export=/results/baseline_001/k6-5.json /scripts/web.js
node tools/load-test/sse.cjs baseline_001 25
```

Для других ступеней меняйте `VUS` (не более числа подготовленных сессий),
`DURATION` и имя итогового JSON. Скрипт k6 читает лендинг, студию, аккаунт и
полный/добавочный снимки workspace. SSE проверяется отдельно; он держит
подключения открытыми. Пароли и cookie остаются только в игнорируемых файлах.
Данные прогона хранятся в `artifacts/load-tests/<run-id>/`.
Каждый run-id теперь получает собственные тестовые аккаунты. Не повторяйте
`prepare.cjs` с **тем же** run-id во время прогона: он перевыпустит cookie.

Для сопоставления конфигураций задайте `ARRIVAL_RATE` — число циклов сценария
в секунду. Один цикл делает пять HTTP-запросов. В режиме фиксированного потока
паузы между циклами нет: интервал задаёт `ARRIVAL_RATE`; в режиме постоянных VU
остаётся пауза в одну секунду. `VUS` задаёт верхнюю границу параллельных циклов.
Сравнивайте одинаковые `ARRIVAL_RATE`, `VUS`,
`DURATION` и базу данных. Учитывайте `dropped_iterations`: при ненулевом
значении часть запланированного потока не была отправлена. Например:

Если терминальная сессия k6 прервана, проверьте `docker ps` по Compose-проекту:
контейнер `load-run-*` может продолжить нагрузку. Остановите конкретный
оставшийся контейнер через `docker stop <имя>` до следующего прогона, иначе
два генератора исказят задержки и состояние пула БД.

```powershell
$env:LOAD_TEST_DB_POOL_MAX='15'
docker compose --env-file .env.load-test -f compose.load-test.yaml up -d --build media
docker compose --env-file .env.load-test -f compose.load-test.yaml run --rm -e SESSIONS_FILE=/results/baseline_001/sessions.json -e VUS=25 -e ARRIVAL_RATE=8 -e DURATION=180s load run --summary-export=/results/baseline_001/k6-fixed-rate.json /scripts/web.js
Remove-Item Env:\LOAD_TEST_DB_POOL_MAX
```

`LOAD_TEST_DB_POOL_MAX` меняет только тестовый контейнер; рабочий сервис
читает `MEDIA_DB_POOL_MAX` (по умолчанию 5). Перед изменением размера пула на
нескольких репликах считайте общий бюджет соединений с PostgreSQL. Методика
фиксированного входного потока описана в
[документации k6](https://grafana.com/docs/k6/latest/using-k6/scenarios/concepts/open-vs-closed/),
а [node-postgres](https://node-postgres.com/guides/pool-sizing) рекомендует
учитывать пулы всех экземпляров и оставлять запас соединений.

Для краткой диагностики этапов POST задайте `LOAD_TEST_TRACE=1` при `up` и
`run` одного и того же Compose-профиля. Executor выводит только имя этапа,
длительность и ожидание пула в JSON-строках `generation.*`; без этой переменной
дополнительного вывода нет. Не включайте трассу в длинный замер задержек.

Для нагрузки на создание задач и внутренние кредиты есть отдельный тестовый
режим с имитацией Kie внутри того же `media`. Он не вызывает Kie API и
возвращает успех без файла результата. `50000` ниже — 50 внутренних кредитов
на аккаунт в единицах кошелька; начисление сохраняется в тестовом ledger.

```powershell
docker compose --env-file .env.load-test -f compose.load-test.yaml -f compose.load-test-queue.yaml up -d media
node tools/load-test/prepare.cjs queue_001 25 50000
docker compose --env-file .env.load-test -f compose.load-test.yaml -f compose.load-test-queue.yaml run --rm -e SESSIONS_FILE=/results/queue_001/sessions.json -e VUS=5 -e ITERATIONS=10 -e RUN_ID=queue_001 load run --summary-export=/results/queue_001/k6-queue.json /scripts/queue.js
node tools/load-test/verify.cjs queue_001 10
```

Каждый `requestId` и тестовый аккаунт задаются общим номером итерации, поэтому
повтор с тем же `RUN_ID`, `ITERATIONS` и числом подготовленных аккаунтов
проверяет идемпотентность независимо от распределения итераций между VU.
Состояния задач,
резервы, списания и журнал отправки сверяет `verify.cjs` после того,
как фоновый опрос завершит задания. Для проверки подтверждённого `429` можно
задать `FAKE_KIE_REJECT_FIRST_EVERY` в окружении тестового `media` и повторить
прогон с новым `RUN_ID`. Переменная должна присутствовать и при `up`, и при
`run` (Compose сверяет конфигурацию зависимого `media`). Например, задайте её
через `$env:FAKE_KIE_REJECT_FIRST_EVERY='5'` перед обеими командами, затем
удалите через `Remove-Item Env:\FAKE_KIE_REJECT_FIRST_EVERY`.
`journalPeak10s` в отчёте БД считается по времени записи в журнал после
ожидания соединения и не доказывает соблюдение лимита POST; для этого снимайте
время выдачи `LOAD_TEST_KIE_SLOT` из логов тестового контейнера.

Короткие ступени показывают лишь предварительную задержку. Устойчивую мощность
определяет длительный прогон вместе с CPU/RAM, PostgreSQL, ошибками и
восстановлением после нагрузки. Этот стенд не измеряет стоимость и мощность
Kie, RouterAI или Codex. Очистка тестовой БД выполняется отдельным действием
после проверки имени БД.

## Большая история, файлы и владение

Все команды ниже используют подготовленные тестовые аккаунты и mock Kie;
платных вызовов нет. История проходит реальные HTTP-страницы и сверяет
план PostgreSQL. Загрузки отправляют 25 файлов по 16 МиБ и проверяют остатки
staging. Скрипты проверяют имя выделенной тестовой БД перед изменениями.

```powershell
node tools/load-test/prepare.cjs history_001 1
node tools/load-test/history.cjs history_001 10000
node tools/load-test/prepare.cjs upload_001 25
node tools/load-test/upload.cjs upload_001
node tools/load-test/replica-lock.cjs
node tools/load-test/notifications.cjs history_001
```

Для двух процессов добавьте `compose.load-test-replicas.yaml` после остальных
load-test Compose файлов. `media` становится единственным executor, `media-web`
слушает `127.0.0.1:3002` и читает ту же БД и общий каталог. Не добавляйте этот
overlay во время замера одиночного executor: Compose может пересоздать `media`.

```powershell
docker compose --env-file .env.load-test -f compose.load-test.yaml -f compose.load-test-queue.yaml -f compose.load-test-replicas.yaml up -d --build media media-web
Invoke-RestMethod -Uri 'http://127.0.0.1:3001/api/health'
Invoke-RestMethod -Uri 'http://127.0.0.1:3002/api/health'
node tools/load-test/prepare.cjs replica_001 1 50000
node tools/load-test/replica.cjs replica_001
node tools/load-test/verify.cjs replica_001 1
```

Для проверки потоковой загрузки через web-посредник подготовьте отдельный
run-id с одним аккаунтом и запустите `upload.cjs` с
`$env:BASE_URL='http://127.0.0.1:3002'`; после прогона удалите переменную
через `Remove-Item Env:\BASE_URL`.

Чтение при 2, 5 и 10 веб-репликах проверяется при одинаковых восьми циклах
в секунду; скрипт распределяет запросы по IP каждой реплики и сохраняет p95,
p99, ошибки и число пропущенных циклов. `media-web-scale` не публикует порты.

```powershell
docker compose --env-file .env.load-test -f compose.load-test.yaml -f compose.load-test-queue.yaml -f compose.load-test-replicas.yaml --profile replicas up -d --scale media-web-scale=2 media-web-scale
docker compose --env-file .env.load-test -f compose.load-test.yaml -f compose.load-test-queue.yaml -f compose.load-test-replicas.yaml --profile replicas run --rm replica-load /scripts/replicas-read.cjs replica_001 2 60 8
```

Повторите с `--scale media-web-scale=5` и `10`, передав то же число вторым
аргументом скрипта. Размер пула в этих репликах — 5 (одно соединение
занято LISTEN); учитывать их сумму и общий бюджет PostgreSQL.

Отказ executor проверяйте после завершения нагрузочного прогона. Тестовый
`media` использует mock Kie; проверка недоступности не создаёт платной задачи.
После остановки веб-реплика должна продолжить чтение и вернуть 503 на запись.
Затем запустите executor и повторите `replica.cjs` с новым run-id, чтобы
проверить доставку события и ровно одну отправку/проводку.

```powershell
docker compose --env-file .env.load-test -f compose.load-test.yaml -f compose.load-test-queue.yaml -f compose.load-test-replicas.yaml kill media
node tools/load-test/replica-failover.cjs replica_001
docker compose --env-file .env.load-test -f compose.load-test.yaml -f compose.load-test-queue.yaml -f compose.load-test-replicas.yaml up -d media
node tools/load-test/prepare.cjs replica_after_restart 1 50000
node tools/load-test/replica.cjs replica_after_restart
node tools/load-test/verify.cjs replica_after_restart 1
```

Долгий бесплатный тест памяти Codex worker запускается штатным test-образом.
Аргумент — минуты (60–120); отчёт пишется в игнорируемые `artifacts/load-tests`.

```powershell
docker compose --profile test run --build --rm -v ./artifacts/load-tests:/results tests node tools/load-test/codex-memory.cjs 70 /results/memory-codex.json
```
