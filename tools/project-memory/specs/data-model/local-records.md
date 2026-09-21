# Локальные данные

Источник: src/history.js, main.js, assets.js, prompt-templates.js. Все имена ниже относительны к Electron userData, а не к каталогу EXE. Пользовательские данные при исследовании не читались.

| Хранилище | Содержание |
| --- | --- |
| history.json | Задачи: id, providerId/model, input/sourceFiles, workspace, state/taskId, даты, результат, стоимость, localFiles, ошибки |
| preferences.json | Настройки хранения и параллельности, курс, тарифный кэш, контрольные балансы, избранное, аудит цен |
| drafts.json | Запись workspace со снимком version=1, active, tabs |
| prompt-templates.json | id, name, text, deleted, updatedAt |
| credentials.json | Зашифрованные safeStorage значения ключей по провайдеру, в base64 |
| sources/ | Байты исходников по SHA-256 |

## Запись

History хранит JSON-массив. Нет файла => пустой массив; повреждённый JSON или не-массив => ошибка, без молчаливой перезаписи. Изменения сериализуются Promise-очередью одного экземпляра. update объединяет поля, задаёт updatedAt, новую запись ставит в начало. expectedStates обеспечивает условное изменение состояния.

Сначала пишется .tmp, затем rename; для EPERM/EACCES/EBUSY до пяти повторов с растущей задержкой. Это защита в одном экземпляре, не межпроцессная блокировка и не транзакция между несколькими файлами. Ошибка одной операции не блокирует все последующие.

## Контракт задачи

Локальный id существует до taskId. model содержит API-имя; modelName/providerName — снимок отображения. resultJson может быть строкой JSON с resultUrls. `queueHidden` поддерживается только как старое поле совместимости; актуальное удаление item очереди физически исключает запись из JSON/PostgreSQL. downloadError не заменяет итог генерации. estimate и creditsConsumed имеют разный смысл; отсутствие creditsConsumed не равно нулю.

Исторические записи без новых полей поддерживаются точечными fallback и recover, формального общего версионирования history нет. Не изменять формат или удалять записи как часть обычного документационного обновления.

Проверки: test/history.test.js (конкурентные записи, повторное открытие, повреждение), test/queue.test.js, assets.test.js, prompt-templates.test.js.
