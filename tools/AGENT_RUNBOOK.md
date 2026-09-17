# Команды проекта

Все команды выполнять из корня, содержащего AGENTS.md. Перед сборкой перечитать его.

| Действие | Команда |
| --- | --- |
| Установить зависимости | pnpm install --frozen-lockfile |
| Запустить | pnpm start |
| Синтаксис трёх точек входа | pnpm check |
| Unit-тесты | pnpm test |
| Скрытый UI smoke без реального API | pnpm exec electron test/ui-smoke.cjs |
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

Обновление каталога — node scripts/import-kie.js и node scripts/import-special.js; это сетевые операции, не часть обычного запуска/исследования. Файлы overrides сохранять.

Для работы с GI: tools/agent-start.ps1, tools/check-instruction-kit-updates.ps1. Источник инструкций указан в tools/project-memory/instruction-kit.json, внешняя рабочая папка не нужна.
