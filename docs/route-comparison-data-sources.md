# Источники данных таблицы «Сравнение маршрутов»

Дата разбора: 2 октября 2026 года.

Модель на предоставленном скриншоте: **Veo 3.1 Fast · Начальный / конечный кадр**.
Документ сохраняет данные и объяснения из разбора в чате. Примеры payload ниже
иллюстрируют структуру запросов; фактический запрос, породивший скриншот,
не был перехвачен. Промпты, идентификаторы файлов и секреты заменены заглушками.

## 1. Откуда взялись значения

Таблица собирается из реестра моделей в PostgreSQL, тарифных API провайдеров
и локальных расчётов сервера. Фронтенд получает котировки через
`POST /api/auto/quote`; справочные тарифы могут дополнительно браться
из загруженного реестра моделей.

| Поле на скриншоте | Источник и расчёт |
| --- | --- |
| Модель и соответствие Kie/APIMart | Строка `video.veo3_fast.first_and_last_frames_2_video` в PostgreSQL, таблица `media_model_routes` |
| Kie: 60 кредитов провайдера | Тарифная строка `Google veo 3.1, image-to-video, Fast-720p`: 60 кредитов за видео |
| Kie: цена для пользователя 60 кредитов | Нативные кредиты Kie переводятся в кредиты сервиса 1:1 |
| Kie: $0.005 за кредит | Локальная настройка `kieUsdPerCredit` в `config/cost-routing.json` |
| Kie: итог $0.30 | `60 × $0.005` |
| APIMart: итог $0.14 | Поле `paid_price` в ответе тарифного API для `veo3.1-fast` |
| APIMart: 1.4 кредита провайдера | `$0.14 × 10`; приложение использует соотношение $1 = 10 кредитов APIMart |
| APIMart: цена для пользователя 1.4 кредита | Нативные кредиты APIMart переводятся в кредиты сервиса 1:1 |
| APIMart: $0.10 за кредит | `$0.14 / 1.4` |
| Опубликованный тариф Kie | Сохранённый снимок тарифа в реестре моделей |
| Опубликованный тариф APIMart | Ответ тарифного API: `paid_price: 0.14`, `resolution_paid_prices: {"4K": 0.64}` |
| Статус «Выбран» у APIMart | Минимальная закупочная стоимость среди доступных маршрутов: `$0.14 < $0.30` |

Обычная котировка может использовать кэш: для тарифов Kie — до 24 часов,
для APIMart — до 10 минут. При отправке задачи тарифы запрашиваются повторно
с принудительным обновлением. Поэтому подпись «текущий ответ» не гарантирует
новый HTTP-запрос при каждом открытии окна.

## 2. Реестр моделей в PostgreSQL

Во время разбора прочитана строка реестра версии `2026-10-01-unified-2`:

```json
{
  "id": "video.veo3_fast.first_and_last_frames_2_video",
  "kind": "video",
  "name": "Veo 3.1 Fast · Начальный / конечный кадр",
  "action": "first-last-frame-to-video",
  "providers": {
    "kie": "kie:veo3_fast:FIRST_AND_LAST_FRAMES_2_VIDEO",
    "apimart": "veo3.1-fast"
  },
  "publishedTariffs": {
    "kie": "image-to-video, Fast-4K: 180 кредитов / видео\nimage-to-video, Fast-1080p: 65 кредитов / видео\nimage-to-video, Fast-720p: 60 кредитов / видео",
    "apimart": "4K: $0.64 / запрос"
  }
}
```

Рабочий реестр читается из `media_model_routes`, запись `id = 'model-routes'`.
Начальный снимок этой строки есть в [config/model-routes.json](../config/model-routes.json).
Чтение реестра реализовано в
[src/services/service-model-configs.js](../src/services/service-model-configs.js).

Справочные цены фронтенд получает через `GET /api/service-model-config/current`
или `GET /api/service-model-config?id=model-routes`.
При наличии `offer.publishedTariff` в ответе котировки это значение имеет приоритет.
Именно поэтому у APIMart на скриншоте есть строка `720P: $0.14`,
хотя в сохранённом реестре указана только цена 4K.

## 3. Внутренний запрос браузера

```http
POST /api/auto/quote
Content-Type: application/json
x-media-client: web
```

Пример тела для исходной формы Kie с двумя кадрами и длительностью 8 секунд:

```json
{
  "modelId": "video.veo3_fast.first_and_last_frames_2_video",
  "originModelId": "kie:veo3_fast:FIRST_AND_LAST_FRAMES_2_VIDEO",
  "input": {
    "prompt": "<текст из формы>",
    "firstFrame": "content:<uuid первого кадра>",
    "lastFrame": "content:<uuid последнего кадра>",
    "aspect_ratio": "16:9",
    "enableTranslation": false,
    "resolution": "720p",
    "duration": 8
  },
  "sourceFiles": [
    {
      "ref": "content:<uuid первого кадра>",
      "fieldKey": "firstFrame"
    },
    {
      "ref": "content:<uuid последнего кадра>",
      "fieldKey": "lastFrame"
    }
  ]
}
```

Запрос формируется в [web/src/components/Composer.vue](../web/src/components/Composer.vue)
и отправляется через [web/src/api/client.ts](../web/src/api/client.ts).
Сервер обрабатывает его в
[src/server/routes/generation.js](../src/server/routes/generation.js)
и [src/services/cost-router.js](../src/services/cost-router.js).

`originModelId` зависит от исходной формы: для APIMart он будет
`apimart:veo3.1-fast`, а имена полей входа будут соответствовать форме APIMart.
Параметры браузера также могут быть восстановлены из сохранённого черновика.

## 4. Подготовленные параметры APIMart

Для приведённого примера сервер подготавливает:

```json
{
  "model": "veo3.1-fast",
  "prompt": "<текст из формы>",
  "parameters": {
    "aspect_ratio": "16:9",
    "resolution": "720p",
    "duration": 8,
    "image_urls": [
      "content:<uuid первого кадра>",
      "content:<uuid последнего кадра>"
    ],
    "generation_type": "frame"
  }
}
```

Адаптер преобразует `firstFrame` и `lastFrame` в `image_urls`
и добавляет `generation_type: "frame"` по действию `first-last-frame-to-video`.
Код находится в
[src/providers/apimart/task-adapter.js](../src/providers/apimart/task-adapter.js),
правила — в [config/apimart-schemas.json](../config/apimart-schemas.json).

Эти параметры используются сервером для проверки совместимости и расчёта
котировки. На этапе сравнения в тарифный API APIMart передаётся только ID модели.

## 5. Запросы к тарифным API провайдеров

### Kie.ai

```http
POST https://api.kie.ai/client/v1/model-pricing/page
Content-Type: application/json

{"pageNum": 1, "pageSize": 100}
```

Запрос повторяется для страниц каталога: `pageNum` увеличивается до количества
страниц из ответа. `pageSize: 100` задан в коде клиента тарифов
[src/tariffs.js](../src/tariffs.js).
Этот публичный тарифный запрос выполняется без API-ключа.

Во время разбора прямым чтением API подтверждены строки:

| modelDescription | creditPrice | creditUnit | anchor |
| --- | --- | --- | --- |
| Google veo 3.1, image-to-video, Fast-4K | 180 | per video | https://kie.ai/veo-3-1 |
| Google veo 3.1, image-to-video, Fast-1080p | 65 | per video | https://kie.ai/veo-3-1 |
| Google veo 3.1, image-to-video, Fast-720p | 60 | per video | https://kie.ai/veo-3-1 |

Сервер сопоставляет `veo3_fast` с тарифом `Fast`,
`FIRST_AND_LAST_FRAMES_2_VIDEO` — с `image-to-video`,
затем выбирает строку по разрешению.
Это реализовано в
[src/billing/kie-tariff-resolver.js](../src/billing/kie-tariff-resolver.js)
и [src/billing/kie-pricing.js](../src/billing/kie-pricing.js).

### APIMart

```http
GET https://api.apimart.ai/api/pricing/model?model=veo3.1-fast
Authorization: Bearer <серверный ключ>
```

Query-параметр `model` берётся из соответствия провайдеров в реестре.
Метод реализован в
[src/providers/apimart/client.js](../src/providers/apimart/client.js).

Во время разбора прямой запрос вернул HTTP 200 и следующие тарифные поля:

```json
{
  "paid_price": 0.14,
  "resolution_paid_prices": {
    "4K": 0.64
  }
}
```

Разрешение `720p` по умолчанию берётся из локальной схемы `veo3.1-fast`.
Поэтому `paid_price` отображается с подписью `720P: $0.14 / запрос`,
а отдельная ставка 4K — как `4K: $0.64 / запрос`.
Расчёт и форматирование реализованы в
[src/providers/apimart/pricing.js](../src/providers/apimart/pricing.js).

Промпт и изображения в перечисленные тарифные API не передаются.

## 6. Проверка доступности и выбор маршрута

Помимо котировки сервер проверяет баланс пользователя и остатки провайдеров:

```http
GET https://api.kie.ai/api/v1/chat/credit
Authorization: Bearer <серверный ключ Kie>
```

```http
GET https://api.apimart.ai/v1/user/balance
Authorization: Bearer <серверный ключ APIMart>
```

Маршрут с несовместимыми параметрами, неизвестной ценой или недостаточным
балансом исключается. Доступные маршруты сортируются по `costUsd`;
при равной цене учитывается приоритет маршрута.
На скриншоте APIMart выбран по сравнению `$0.14 < $0.30`.
Правила реализованы в [src/services/cost-router.js](../src/services/cost-router.js).

## 7. Источник каждого входного параметра

| Параметр | Откуда берётся |
| --- | --- |
| `modelId` | ID выбранной строки реестра `media_model_routes` |
| `originModelId` | ID модели исходной формы Kie либо APIMart |
| `prompt` | Введённый пользователем текст или сохранённый черновик |
| `resolution` | Текущее состояние формы; начальное значение — из схемы модели и правил выбора минимального размера |
| `duration` | Текущее состояние формы; начальное значение — из правил выбора минимальной положительной длительности либо default схемы |
| `aspect_ratio` | Текущее состояние формы либо default схемы |
| `enableTranslation` | Настройка формы Kie; локальный default для этой модели — `false` |
| `firstFrame`, `lastFrame` | Ссылки на выбранные пользователем исходники; последний кадр необязателен |
| `sourceFiles` | Метаданные загруженных исходников и их привязка к полям формы |
| `image_urls` | Результат преобразования исходных кадров адаптером APIMart |
| `generation_type: "frame"` | Добавляется адаптером из действия строки реестра |
| `pageNum`, `pageSize` | Пагинация загрузчика тарифов Kie; размер страницы задан в коде |
| `model` в тарифном API APIMart | ID APIMart из реестра маршрутов |

Правила начальных значений описаны кодом
[web/src/domain/media-fields.ts](../web/src/domain/media-fields.ts).
Для формы Kie выбор минимального значения из `4, 6, 8` даёт `4`,
хотя default схемы — `8`; для APIMart схема содержит единственный вариант `8`.
Поэтому `duration: 8` в примере выше не доказывает фактическую длительность
на скриншоте. Доступность APIMart предполагает совместимые параметры,
но полный исходный запрос всё равно требует отдельного свидетельства.

Схема Kie хранится в [src/kie-special.json](../src/kie-special.json)
с источником `https://docs.kie.ai/veo3-api/generate-veo-3-video.md`.
Схема APIMart хранится в [config/apimart-schemas.json](../config/apimart-schemas.json)
с источником `https://docs.apimart.ai/en/api-reference/videos/veo3/generation`.
Это записанные в проекте ссылки происхождения схем; актуальность внешней
документации в ходе данного разбора отдельно не проверялась.

## 8. Что происходит при отправке генерации

`POST /api/auto/quote` выполняет предварительное сравнение.
При нажатии кнопки генерации браузер отправляет `POST /api/auto/jobs`
с параметрами задачи, `requestId` и контекстом проекта/чата.
Сервер повторно проверяет тарифы и сохраняет решение в `media_records`
с `namespace = 'auto-route'`.

Если выбран APIMart, ссылки `content:<uuid>` разрешаются с проверкой доступа,
изображения загружаются через `POST /v1/uploads/images`,
и возвращённые URL используются в `POST /v1/videos/generations`.
Тело генерации содержит `model`, `prompt` и подготовленные параметры.
Код: [src/services/apimart-jobs.js](../src/services/apimart-jobs.js).

Если выбран Kie, исходники разрешаются и загружаются для Kie,
а адаптер формирует тело `POST /api/v1/veo/generate`:
`model: "veo3_fast"`, `generationType: "FIRST_AND_LAST_FRAMES_2_VIDEO"`,
`imageUrls` и остальные параметры задачи.
Код: [src/adapters.js](../src/adapters.js)
и [src/services/kie-generation.js](../src/services/kie-generation.js).

Само открытие окна сравнения не создаёт платную генерацию.
Скриншот не подтверждает последующее нажатие кнопки и отправку генерации.

## 9. Границы достоверности разбора

- Скриншот подтверждает показанные ID моделей, суммы, тарифные подписи и выбор APIMart.
- Прочитанная строка PostgreSQL подтверждает рабочее соответствие моделей и сохранённый тариф Kie на момент разбора.
- Прямые чтения тарифных API подтвердили приведённые ставки на момент разбора; цены провайдеров могут измениться.
- Значения на скриншоте согласуются с котировкой для эффективного разрешения `720p`; фактический request body не перехвачен.
- Точный промпт, UUID исходников, aspect ratio, длительность и наличие второго кадра по скриншоту не восстанавливаются.
- `POST /api/auto/quote` не сохраняет полный запрос в БД. При последующей отправке `/api/auto/jobs` решение и подготовленные параметры сохраняются.
- Статус «Доступен» отражает проверки приложения; окончательное принятие генерации внешним провайдером устанавливается после отправки задачи.

Документ создан по уже выполненному разбору. Сборка и проверка проекта
при сохранении документа пропущены по прямому указанию пользователя.
