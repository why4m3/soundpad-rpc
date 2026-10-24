# soundpad-rpc

Discord Rich Presence для Soundpad в стиле Spotify. Пока в Soundpad играет звук, в профиле Discord видно:

```
Слушает Soundpad
Оу май                          <- название звука (details)
Русские мемы                    <- категория Soundpad или "Soundpad" (state)
0:02 ━━━━━━━●────────── 0:07    <- полоса прогресса по timestamps
```

- Тип активности Listening (`type: 2`, «Слушает»).
- Полоса прогресса: `timestamps.start = сейчас - позиция`, `timestamps.end = start + длительность`, позиция и длительность берутся из Soundpad.
- Пауза: активность остаётся, полоса прогресса пропадает, вторая строка «На паузе» (можно отключить: `show_when_paused: false`).
- Смена звука, перемотка, продолжение после паузы: активность обновляется.
- Звук остановлен, Soundpad закрыт: активность убирается полностью.
- Эмодзи в текстах нет.

## Почему Node.js 20 без зависимостей

- Node уже стоит на ПК ради claude-rpc, ставить Python не нужно.
- В Node встроены именованные каналы Windows (`net.connect('\\.\pipe\...')`), этого хватает и для Soundpad, и для Discord IPC. Протокол Discord IPC простой (8 байт заголовка плюс JSON), и он реализован прямо здесь, в `src/discord-ipc.js`. Старая библиотека `discord-rpc` давно не обновляется и не передаёт `type`, поэтому «Слушает» через неё не сделать.
- Тестам хватает встроенного `node:test`, поэтому `npm install` не нужен: нет `node_modules` и нет пакетов, которые могут сломаться при обновлении.
- Цикл раз в секунду ждёт на `setTimeout`, за один опрос уходят три короткие команды в pipe, так что нагрузки на CPU практически нет.

## Установка

1. Установите **Node.js 20 или новее** (https://nodejs.org, LTS). Проверить версию: `node --version`.
2. Скачайте репозиторий, например в `C:\Tools\soundpad-rpc`:
   ```
   git clone https://github.com/why4m3/soundpad-rpc.git C:\Tools\soundpad-rpc
   ```
3. Создайте приложение в Discord (см. ниже) и скопируйте его **Application ID**.
4. Запустите один раз `windows\run-console.cmd`. Программа создаст `config.json` из `config.example.json` и напишет, что `client_id` не задан. Откройте `config.json` и вставьте ID:
   ```json
   "client_id": "123456789012345678",
   ```
5. Проверьте Discord: **Настройки пользователя → Конфиденциальность активности → «Делиться информацией о моей активности»** должно быть включено. Работает только приложение Discord для ПК, браузерная версия не подойдёт.
6. Soundpad должен быть запущен. Remote Control API работает в полной версии, в демо-версии он может быть недоступен. Проверка: `node index.js --diagnose` (см. «Проверка»).

### Приложение в Discord Developer Portal

Приложение нужно отдельное от claude-rpc: у каждого Application ID своя активность, поэтому статусы Soundpad и Claude видны одновременно и не перезаписывают друг друга.

1. Откройте https://discord.com/developers/applications и нажмите **New Application**.
2. Назовите его **Soundpad**: имя приложения Discord показывает после «Слушает», то есть получится «Слушает Soundpad».
3. На странице **General Information** скопируйте **Application ID** и вставьте его в `config.json` как `client_id`.
4. Картинка для `large_image`: **Rich Presence → Art Assets → Add Image(s)**. Загрузите PNG или JPG (лучше квадрат 1024x1024, минимум 512x512) и задайте ему имя **`soundpad`**: это значение `large_image` в конфиге. Нажмите **Save Changes**. Новая картинка может появиться в Discord только через 5-15 минут.
5. Можно добавить вторую картинку, например `paused`, и вписать её в `"small_image_paused": "paused"`. Тогда на паузе будет виден маленький значок.
6. Вместо ключа в `large_image` можно указать прямую ссылку `https://...png`, тогда загружать картинку в Developer Portal не нужно.

## Запуск

| Что | Как |
| --- | --- |
| С окном и логом (для проверки) | `windows\run-console.cmd` или `node index.js` |
| В фоне без окна | двойной клик по `windows\start-hidden.vbs` |
| Остановить фоновый | `windows\stop.cmd` |
| Посмотреть, что ушло бы в Discord, без Discord | `node index.js --dry-run` |
| Ответы Soundpad API как есть | `node index.js --diagnose` |
| Тестовая активность в Discord на 30 с | `node index.js --test-discord` |
| Подробный лог | добавить `--debug` |

Лог пишется в `soundpad-rpc.log` рядом с программой. При размере больше 1 МБ старый лог переименовывается в `.log.1`. Второй экземпляр программы сразу завершается сам: блокировка держится через named pipe и освобождается, когда процесс завершается.

## Автозапуск без окна консоли

```
windows\install-autostart.cmd
```

Скрипт находит `node.exe`, записывает путь к нему в `windows\node-path.txt` (так автозапуск не зависит от PATH), создаёт ярлык `soundpad-rpc.lnk` в папке «Автозагрузка» (`shell:startup`) и сразу запускает программу в фоне. Ярлык запускает `wscript.exe windows\start-hidden.vbs`, а VBS стартует `node index.js` со скрытым окном.

Вместо ярлыка можно сделать задачу планировщика «при входе в систему»:

```
powershell -ExecutionPolicy Bypass -File windows\install-autostart.ps1 -Task
```

Удалить из автозагрузки и остановить: `windows\uninstall-autostart.cmd`.

После `git pull` переустанавливать автозапуск не нужно, достаточно `windows\stop.cmd` и затем `windows\start-hidden.vbs`.

## Как Discord упорядочивает несколько активностей и как поставить Soundpad первым

Что известно и что видно на практике:

1. **У каждого Application ID своя активность.** claude-rpc и soundpad-rpc подключаются к Discord по отдельности, каждый со своим ID, и Discord держит у пользователя список активностей. В полном профиле (клик по аватару) видны все. В списке участников сервера и в строке под ником видна одна, «главная», и её Discord выбирает сам.
2. **Порядок задаёт клиент Discord, программа на него напрямую не влияет.** Официально алгоритм не описан, поля «приоритет» в Rich Presence нет. На практике Discord сортирует **по типу активности**: Playing (0, «Играет») стоит выше Listening (2, «Слушает»), а Listening выше Watching (3, «Смотрит»). Поэтому Spotify всегда показывается под игрой. Это же вы уже видели в claude-rpc: когда запущена игра, Claude переключается на Watching и уходит вниз.
3. **Внутри одного типа порядок зависит от того, кто подключился или обновился раньше.** Здесь ничего не гарантировано: порядок может поменяться после перезапуска Discord, переподключения IPC или обновления клиента. Полагаться на «запущу Soundpad позже, и он будет выше» нельзя.

Вывод: если claude-rpc показывает Claude как **Playing**, Soundpad с типом **Listening** окажется **ниже** него, как бы ни менялся порядок подключения. Если перевести Soundpad тоже в Playing (`activity_type: 0`), оба будут одного типа и порядок станет случайным. Поэтому так делать не стоит.

**Решение:** пока в Soundpad играет звук, claude-rpc понижает свою активность до **Watching**, ровно как сейчас при запущенной игре. Тогда Listening (Soundpad) будет выше Watching (Claude). Когда звук закончится, claude-rpc вернётся к Playing. Если нужна стопроцентная гарантия, можно убирать активность Claude совсем, пока играет звук (вариант Б ниже).

Чтобы claude-rpc узнал, что Soundpad сейчас показан, soundpad-rpc при каждом изменении пишет маленький файл:

```
%LOCALAPPDATA%\soundpad-rpc\state.json
{ "active": true, "status": "PLAYING", "title": "Оу май", "ends_at": 1761300000000, "pid": 1234, "updated_at": ... }
```

`active: true` означает, что активность Soundpad сейчас видна (идёт воспроизведение или пауза). Файл перезаписывается атомарно и только при изменениях. Если soundpad-rpc упадёт, читатель это заметит: процесс `pid` уже не живой или время `ends_at` прошло.

### Правка на стороне claude-rpc (делается в claude-rpc отдельно, здесь его код не меняется)

1. Скопируйте `integrations/claude-rpc/soundpad-state.cjs` в папку claude-rpc, например в `src/soundpad-state.cjs`. Файл без зависимостей и работает и из CommonJS, и из ESM.
2. Подключите его:
   ```js
   // CommonJS
   const { isSoundpadActive } = require('./soundpad-state.cjs');
   // ESM ("type": "module")
   import soundpadState from './soundpad-state.cjs';
   const { isSoundpadActive } = soundpadState;
   ```
3. **Вариант А (рекомендуется).** Найдите место, где claude-rpc решает «запущена игра, значит Watching», и добавьте туда Soundpad:
   ```js
   // было:
   const demote = isGameRunning();
   // стало:
   const demote = isGameRunning() || isSoundpadActive();
   // дальше как раньше: demote ? ActivityType.Watching (3) : ActivityType.Playing (0)
   ```
   **Вариант Б (всегда ниже Soundpad).** Пока играет звук, активность Claude не показывается совсем:
   ```js
   if (isSoundpadActive()) { await client.clearActivity(); return; }
   ```
4. Проверка должна выполняться периодически, а не только при событиях Claude. Если в claude-rpc уже есть таймер проверки игры, хватит той же правки. Если таймера нет, добавьте `setInterval(updatePresence, 2000)`. `isSoundpadActive()` читает один маленький файл и стоит дёшево.
5. Учтите лимит Discord: примерно 5 обновлений активности за 20 секунд на приложение. claude-rpc должен отправлять `SET_ACTIVITY` только когда тип или текст действительно поменялся, а не на каждом тике.

## Как программа понимает, какой звук играет

В Soundpad Remote Control API есть `GetPlayStatus()` (`PLAYING` / `PAUSED` / `STOPPED` / `SEEKING`), `GetPlaybackPositionInMs()` и `GetPlaybackDurationInMs()`, но **команды «какой звук сейчас играет» нет**. Поэтому звук определяется по косвенным признакам, в таком порядке:

1. **Счётчики.** Программа запоминает список `GetSoundlist()` (`playCount`, `lastPlayedOn` каждого звука). Когда начинается новое воспроизведение, она снова читает список и ищет звук, у которого изменился счётчик и совпадает длительность.
2. **Текст окна.** Если `GetTitleText()` или `GetStatusBarText()` содержат имя звука, используется оно.
3. **Тот же звук** (повтор, перемотка в начало), если длительность совпадает.
4. **Длительность и время.** Ищется звук с такой же длительностью, при нескольких совпадениях берётся последний проигранный (`lastPlayedOn`).

Если способ ненадёжный (п. 3-4), через 2,5 с проверка повторяется: на случай, если Soundpad обновляет счётчик с задержкой. Каким способом найден звук, видно в логе: `Звук: Оу май [Русские мемы] (способ: counter)`.

Название звука берётся из поля «Название» (title) в Soundpad, а если оно пустое, из имени файла без расширения. Категория определяется через `GetCategories(true, false)`, служебная «Все звуки» пропускается (`ignored_categories`). Если категории нет, во второй строке пишется `Soundpad`.

Если `GetPlaybackPositionInMs()` не отвечает, позиция считается самостоятельно от момента начала воспроизведения, с учётом пауз.

## Проверка

Автотесты (Soundpad и Discord не нужны, имитируются фейковыми pipe-серверами):

```
npm test
```

Что покрыто тестами: разбор `GetPlayStatus`, чисел и кодов `R-xxx`, XML `GetSoundlist` и `GetCategories` (сущности, кириллица, пустой список, длительности `m:ss` и `h:mm:ss`, даты), склейка XML, пришедшего несколькими кусками; определение звука всеми способами; построение активности (воспроизведение, пауза, стоп, длинные и короткие строки); кадры Discord IPC, handshake, отказ по неверному client_id, PING/PONG, переподключение; полный цикл «играет → пауза → перемотка → другой звук → стоп → Soundpad закрыт», лимит 5 обновлений за 20 с, файл состояния и хелпер для claude-rpc.

### Чек-лист ручной проверки на ПК

Проверить вживую в облаке было нельзя, поэтому пройдите по шагам. Если пункт не сработал, пришлите вывод `node index.js --diagnose` и кусок `soundpad-rpc.log`.

1. [ ] `node --version` показывает v20 или новее, `npm test` проходит без ошибок.
2. [ ] Soundpad запущен. `node index.js --diagnose` печатает `IsAlive() -> R-200`, `GetPlayStatus() -> STOPPED` и список последних звуков.
3. [ ] Включите звук и сразу повторите `--diagnose`: `GetPlayStatus() -> PLAYING`, позиция и длительность (мс) не нулевые. Посмотрите, что показывают `GetTitleText()` и `GetStatusBarText()` во время воспроизведения.
4. [ ] Discord для ПК запущен. `node index.js --test-discord`: в профиле появилось «Слушает Soundpad», «Тестовый звук», полоса прогресса на 30 с и картинка. Если картинки нет, проверьте ключ `soundpad` в Art Assets или подождите 15 минут.
5. [ ] `windows\run-console.cmd`: включите звук. Через 1-2 с в профиле видны название звука и категория, полоса прогресса совпадает с Soundpad. В логе строка `Звук: ... (способ: ...)` с правильным звуком.
6. [ ] Пауза в Soundpad: полоса прогресса пропала, вторая строка «На паузе». Продолжение: полоса вернулась с правильной позиции.
7. [ ] Перемотка внутри звука: полоса прогресса сдвинулась (в пределах 1-2 с).
8. [ ] Быстро включите другой звук, потом ещё раз тот же: название меняется на правильное. Если звук определяется неверно, пришлите лог с `--debug`.
9. [ ] Stop в Soundpad или звук доиграл до конца: активность Soundpad исчезла из профиля полностью.
10. [ ] Закройте Soundpad во время воспроизведения: активность исчезла. Запустите Soundpad снова: всё работает без перезапуска soundpad-rpc.
11. [ ] Перезапустите Discord: после запуска активность вернулась (переподключение раз в 15 с).
12. [ ] Пока звук играет, откройте `%LOCALAPPDATA%\soundpad-rpc\state.json`: там `"active": true`. После стопа должно стать `false`.
13. [ ] После правки claude-rpc: запустите Claude Code, чтобы появился его статус, и включите звук. В профиле Soundpad («Слушает») выше Claude, Claude переключился на «Смотрит». Через несколько секунд после конца звука Claude снова «Играет».
14. [ ] `windows\install-autostart.cmd`, затем перезагрузка или выход из системы и вход: окна консоли нет, в диспетчере задач есть `node.exe`, статус работает. `windows\stop.cmd` останавливает программу.
15. [ ] Двойной запуск `start-hidden.vbs` не создаёт второй процесс `node.exe`.

## Настройки (`config.json`)

`config.json` не хранится в git, его создаёт программа из `config.example.json`. В файле можно писать комментарии `//`.

| Ключ | По умолчанию | Что делает |
| --- | --- | --- |
| `client_id` | `""` | Application ID приложения Soundpad из Developer Portal |
| `poll_interval_ms` | `1000` | Интервал опроса Soundpad, мс (250-60000) |
| `activity_type` | `2` | 2 Listening, 0 Playing, 3 Watching, 5 Competing |
| `status_display_type` | `2` | Что видно в строке под ником: 0 имя приложения («Слушает Soundpad»), 1 state, 2 details (название звука). `null` значит не передавать поле |
| `details` / `state` | `{title}` / `{category}` | Шаблоны строк, подстановки `{title}` `{file}` `{artist}` `{category}` |
| `default_category` | `Soundpad` | Вторая строка, если у звука нет категории |
| `unknown_title` | `Soundpad` | Первая строка, если звук не удалось определить |
| `show_when_paused` | `true` | `false`: на паузе активность убирается |
| `paused_state` | `На паузе` | Вторая строка на паузе |
| `large_image` / `large_text` | `soundpad` / `Soundpad` | Ключ картинки из Art Assets (или https-ссылка) и подсказка к ней |
| `small_image_paused` | `""` | Ключ маленькой картинки на паузе |
| `ignored_categories` | `All sounds`, `Все звуки`, ... | Категории, которые не показывать |
| `state_file` | `""` | Путь к файлу состояния для claude-rpc, по умолчанию `%LOCALAPPDATA%\soundpad-rpc\state.json` |
| `log_file` | `soundpad-rpc.log` | Лог, пустая строка отключает его |
| `soundpad_pipe` | `\\.\pipe\sp_remote_control` | Pipe Soundpad |
| `discord_pipe` | `""` | Конкретный pipe Discord, по умолчанию перебираются `discord-ipc-0..9` |
| `discord_retry_ms` | `15000` | Как часто пытаться переподключиться к Discord |

## Устройство

```
index.js                     запуск, режимы --dry-run / --diagnose / --test-discord, один экземпляр
src/soundpad-protocol.js     разбор ответов Soundpad API (чистые функции)
src/soundpad-client.js       named pipe Soundpad: очередь команд, склейка ответа, таймауты
src/discord-ipc.js           Discord IPC: кадры, handshake, SET_ACTIVITY, PING/PONG
src/presence.js              какой звук играет, какую активность показать, когда обновлять
src/app.js                   цикл опроса, лимит обновлений, файл состояния
src/state-file.js            state.json для claude-rpc
integrations/claude-rpc/     хелпер isSoundpadActive() для claude-rpc
windows/                     start-hidden.vbs, автозапуск, остановка, запуск с консолью
test/                        node:test, фейковые Soundpad и Discord
```

Команды Soundpad Remote Control взяты из официального референса Leppsoft (`SoundpadRemoteControl.java`) и библиотеки soundpad.js: `GetPlayStatus()`, `GetPlaybackPositionInMs()`, `GetPlaybackDurationInMs()`, `GetSoundlist()`, `GetCategories(withSounds, withIcons)`, `GetTitleText()`, `GetStatusBarText()`, `IsAlive()`. Ответы приходят текстом, ошибки приходят как `R-<код>`.
