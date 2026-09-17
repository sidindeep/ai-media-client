# AI Media Client — Windows

Независимый Electron-клиент. Все команды ниже выполняются из desktop/. Веб и Telegram находятся в корне репозитория и не нужны для запуска приложения.

```powershell
pnpm install --frozen-lockfile
pnpm start
pnpm check
pnpm test
pnpm run pack
```

Единственный каталог сборки относительно корня репозитория: `desktop/dist/queue-header`. Запускать `win-unpacked/AI Media Client.exe` из этого каталога. Не переносите EXE отдельно от остальных файлов. Защита единственного output: scripts/single-distribution.cjs.

История, черновики и зашифрованные ключи остаются в прежнем Electron userData; перенос исходников их не меняет. Скрытый UI smoke: `pnpm exec electron test/ui-smoke.cjs --disable-gpu`.
