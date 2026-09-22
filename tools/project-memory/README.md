# Память проекта AI Media Client

Проверено по исходникам 2026-09-17. Это карта текущего поведения, а не обещание проверки всех моделей живыми запросами. Пути доказательств в спецификациях указаны от корня проекта.

## Быстрый вход

- [Аккаунты и кредиты](specs/features/accounts-credits.md) — Google/VK, PostgreSQL,
  изоляция, роли и независимый от провайдера кредитный модуль.
- [Архитектура платежей](specs/features/payments-module.md) — граница продукта и
  платёжных провайдеров, outbox/inbox, возвраты и будущий вынос в сервис;
  [план реализации для Sol Medium](../../docs/payments-implementation-plan.md).

- [Веб и Telegram](specs/features/web-telegram.md) — сервер, общий workspace, бот и проверки.

- [Граница медиа и провайдеров](specs/features/media-provider-boundary.md) — контракт приложения и клиенты провайдеров.

- [Архитектура](architecture.md) — границы процессов и поток данных.
- [Стек](specs/technology-stack.md) — технологии и команды.
- [Очередь](specs/features/generation-queue.md) — отправка, параллельность, пауза, восстановление.
- [Каталог и валидация](specs/features/catalog-validation.md) — декларативные формы, адаптеры и ограничения.
- [Исходники и результаты](specs/features/media-storage.md) — сохранение, повтор, скачивание.
- [План единого модуля контента](specs/features/content-module-plan.md) — UUID-файлы,
  приватный S3, каталог, фоновые задания и переход legacy-данных.
- [План production CDN и Storage](specs/features/cdn-storage-production-plan.md) —
  Versioning, Object Lock, CDN-авторизация, backup 3-2-1 и восстановление.
- [Рабочие вкладки](specs/features/workspaces-templates.md) — черновики, шаблоны и избранное.
- [Локализация](specs/features/localization.md) — RU/EN-словари, ключи, plural rules, выбор языка и границы перевода.
- [Стоимость](specs/business-rules/cost-accounting.md) — оценки, списания и сверка.
- [Исследование ценовой политики](specs/business-rules/pricing-policy-research.md) — рыночные цены Kie, налоговая модель и сценарий патента.
- [Юридические документы](specs/business-rules/legal-documents.md) — публичные страницы, изученный пример ERA2, факты продукта и блокеры перед публикацией.
- [Нагрузочное тестирование Codex](specs/features/codex-load-testing.md) — контракт измерений и ссылка на план; сквозные и длительные прогоны ещё не выполнены.
- [Транспорты Codex](specs/features/codex-transports.md) — exec и app-server, пилот A/B на 12 реальных генерациях; сквозная мощность ещё не измерена.
- [Модель данных](specs/data-model/local-records.md) — сущности и сохранение.
- [Интеграции](specs/integration-contracts/connected-projects.md) — Kie, GI и границы секретов.
- [Решения](decisions.md), [ограничения](known-issues.md), [план изучения](STUDY_PLAN.md).
- [История архитектуры](architecture-migrations.md).

Изменяя поведение, обновлять соответствующий контракт и его проверочные сценарии. Не переносить сюда ключи, пользовательскую историю, файлы медиа или большие логи. Команды запуска находятся в [runbook](../AGENT_RUNBOOK.md).

## Поиск и проверка

Начинать с этой карты и точечного поиска по спецификациям. SQLite рекомендован: исходное дерево содержит более 50 текстовых файлов. Индекс пока не построен; для текущего объёма сведений доступен поиск rg. Векторные и внешние сервисы не включены. Наличие теста в ссылках означает найденное покрытие; результаты фактического запуска фиксировать отдельно.
