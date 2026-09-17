# Веб и Telegram

Самостоятельный модуль перенесён в [web-tg](../web-tg/README.md). Все исходники, настройки, зависимости и тесты веба/бота находятся внутри этой папки.

Из корня репозитория: `pnpm start:web`, `pnpm check:web`, `pnpm test:web`. Из папки модуля: `pnpm start`, `pnpm check`, `pnpm test`. Перед первым запуском: `pnpm --dir web-tg install --ignore-workspace --frozen-lockfile`.

Windows-приложение по-прежнему запускается через `pnpm start` из корня и собирается в `dist/queue-header`. Оно не зависит от web-tg.

[Настройки и команды бота](../web-tg/docs/web-and-telegram.md).
