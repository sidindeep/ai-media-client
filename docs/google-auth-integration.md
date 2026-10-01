# Перенос входа через Google

В другой Node.js-проект скопируйте вместе три файла из `src/auth/`:
`google-auth.js`, `google.js`, `oauth.js`. Они используют только `node:crypto`
и глобальные fetch/URL/Buffer (Node.js 22+), без npm-зависимостей, PostgreSQL,
таблиц AI Media Client, кошелька и чатов. `google.js` можно использовать отдельно
как authorize/exchange adapter для уже существующей системы сессий.

## Подключение

```js
const { createGoogleAuth } = require('./auth/google-auth');
const auth = createGoogleAuth({
  clientId: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  origin: 'https://example.com',
  cookiePrefix: 'myapp',
  callbackPath: () => '/login/google/return',
  sessionSeconds: 7 * 24 * 60 * 60,
  store: applicationAuthStore,
});

// Пример для существующего Express-приложения.
app.get('/login/google', async (req, res, next) => {
  try {
    const result = await auth.begin('google');
    res.setHeader('Set-Cookie', result.cookie);
    res.redirect(result.location);
  } catch (error) { next(error); }
});
app.get('/login/google/return', async (req, res, next) => {
  try {
    const params = new URL(req.originalUrl, 'https://example.com').searchParams;
    res.setHeader('Set-Cookie', await auth.finish(req, 'google', params));
    res.redirect('/');
  } catch (error) { next(error); }
});
// Защищённый маршрут: const user = await auth.user(req);
// После проверки CSRF/origin приложением:
// res.setHeader('Set-Cookie', await auth.logout(req));
```

Принимающий проект предоставляет applicationAuthStore по контракту ниже,
регистрирует свой callback в Google и задаёт собственные credentials.
Origin не содержит пути; допустим HTTPS и локальный HTTP (localhost/127.0.0.1/::1).
Callback остаётся на этом origin. Cookie: HttpOnly, SameSite=Lax, при HTTPS
Secure и __Host-. req требует только headers.cookie; Express не обязателен.
По умолчанию callback `/auth/google/callback`, cookiePrefix `auth`, срок 7 дней.
fetcher можно передать для тестов. Клиентский секрет остаётся на сервере.

## Контракт applicationAuthStore

Все методы асинхронные, тип БД и роли выбирает принимающий проект.

| Операция | Обязательное поведение |
| --- | --- |
| createFlow({stateHash,browserHash,provider,verifier,expiresAt}) | Сохранить попытку и PKCE verifier до expiresAt; удалять просроченные flows/сессии |
| consumeFlow({stateHash,browserHash,provider}) | Атомарно удалить только непросроченную попытку с совпадением всех полей; вернуть {verifier} либо null. Неверный браузер/провайдер не удаляет чужую попытку |
| completeLogin({provider,profile,session}) | Атомарно найти/создать аккаунт по provider+subject и заменить сессию. Повторные/параллельные входы не создают дубль. Ошибка откатывает создание аккаунта и замену сессии |
| replaceSession(context,{accountId,tokenHash,previousTokenHash,expiresAt}) | Удалить старую сессию при наличии хеша и сохранить новую в транзакции context; используется issueSession для дополнительных способов входа |
| getSession(tokenHash) | Вернуть актуального пользователя/права или null при отсутствии, истечении, отзыве; браузер не задаёт роль |
| deleteSession(tokenHash) | Отозвать сессию; отсутствие записи допустимо |
| identities(accountId) | Вернуть подтверждённые идентификаторы в формате принимающего проекта |

profile: subject, name, verifiedEmail только при подтверждении Google.
session: tokenHash, previousTokenHash (либо null), expiresAt (Date).
Хранилище не получает сырые session/state/browser токены; verifier живёт до
consumeFlow. Google access token не сохраняется. Ошибка обмена или регистрации
не возвращает использованный flow: нужен новый start. Email не разрешает
автоматическое слияние аккаунтов или назначение администратора.

При нескольких процессах нужен общий store с атомарными операциями. Map из
тестов — проверка интерфейса, не рабочее хранилище. В AI Media Client
`postgres-store.js` сохраняет прежние таблицы, блокировки, регистрацию,
правила назначения администраторов и общую транзакцию. Email/MAX остаются
отдельными интеграциями проекта и не входят в эти три переносимых файла.

Проверки: `test/google-auth.test.js` выполняет вход на другом store, проверяет
PKCE, браузер, expiry/replay, ротацию/выход и загрузку копии только трёх файлов.
`test/accounts.test.js` и `test/account-registration.test.js` проверяют сборку
с PostgreSQL-адаптером и откат. Реальный Google-вход требует отдельной проверки
с настройками принимающего проекта.
