# Команды проекта

Все команды выполнять из корня, содержащего AGENTS.md. Перед сборкой перечитать его.

| Действие | Команда |
| --- | --- |
| Установить зависимости | pnpm install --frozen-lockfile |
| Запустить | pnpm start |
| Веб-сервис и настроенный Telegram-бот | pnpm start:web |
| Веб с перезапуском при изменениях | pnpm dev:web |
| Проверка синтаксиса сервера и бота | pnpm check:web |
| Синтаксис трёх точек входа | pnpm check |
| Unit-тесты | pnpm test |
| Скрытый UI smoke без реального API | pnpm exec electron test/ui-smoke.cjs |
| Тот же smoke при пустой WebM-фикстуре на GPU хоста | pnpm exec electron test/ui-smoke.cjs --disable-gpu |
| Папка Windows x64 | pnpm run pack |
| Установщик NSIS | pnpm run dist |
| Проверка документационного diff | git diff --check |

Ожидание: проверки завершаются с кодом 0. Команда pack дана через run, чтобы однозначно вызвать script package.json.

Единственный output: dist/queue-header. EXE: dist/queue-header/win-unpacked/AI Media Client.exe. Не обходить scripts/single-distribution.cjs и не менять output. Если EXE занят, закрыть приложение штатно с сохранением черновиков.

Для smoke уже собранного пакета задать AI_CLIENT_PACKAGED_PATH относительно корня через Resolve-Path:

```powershell
$env:AI_CLIENT_PACKAGED_PATH = (Resolve-Path './dist/queue-header/win-unpacked/resources/app.asar').Path
pnpm exec electron test/ui-smoke.cjs --packaged
```

Сборка перед этой командой должна существовать; сама команда не собирает приложение.

Отдельной команды логов нет: запускать из терминала и анализировать stderr; ошибки задач видны в истории. Не читать профиль пользователя без отдельной задачи. Данные приложения находятся в Electron userData; дистрибутив переносится целой папкой.

Веб по умолчанию слушает http://127.0.0.1:3000, health: /api/health. Конфиг —
web-tg/.env (образец .env.example), данные — web-tg/data/service внутри проекта. Остановка —
Ctrl+C; single-writer lock снимается при штатной остановке. После изменения
кода обычный start:web надо перезапустить. Подробности и Telegram-команды:
[веб и Telegram](../docs/web-and-telegram.md). Без ключей платные запросы и
бот не выполняются; доступ к настройке ключа/входу Kie через UI отсутствует.

Обновление каталога — node scripts/import-kie.js и node scripts/import-special.js; это сетевые операции, не часть обычного запуска/исследования. Файлы overrides сохранять.

Для работы с GI: tools/agent-start.ps1, tools/check-instruction-kit-updates.ps1. Источник инструкций указан в tools/project-memory/instruction-kit.json, внешняя рабочая папка не нужна.

Журнал генерации: docs/generation-logging.md. Desktop — userData/logs/generation.jsonl (кнопка «Открыть журнал»); web/bot — web-tg/data/service/logs/generation.jsonl.
