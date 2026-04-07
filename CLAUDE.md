# Token Maker 2.0 — CLAUDE.md

## Что это за проект

Локальное десктопное приложение для создания круглых токенов персонажей настольных ролевых игр.
Работает полностью офлайн. Упаковано в окно через `pywebview` (EdgeChromium).

Архитектура: **Flask backend** (Python) + **Vanilla JS frontend** (без фреймворков).

---

## Стек

| Слой | Технология |
|------|-----------|
| Десктоп-оболочка | pywebview 4.x, gui=edgechromium |
| Веб-сервер | Flask (порт 7878, только localhost) |
| AI-инференс | ONNX Runtime (DirectML → CUDA → CPU) |
| Модель | BiRefNet (model.onnx) |
| Изображения | Pillow |
| Frontend | Vanilla JS (ES5/ES6 mix), Canvas 2D API |
| Стили | CSS custom properties, без препроцессоров |

---

## Структура файлов


tokenMaker2.0/
├── app.py                  # Точка входа: запуск Flask + pywebview
├── server.py               # Flask-приложение, все маршруты и AI-логика
├── start.bat               # Запуск для Windows
├── model.onnx              # Нейросеть BiRefNet (не в репо, кладётся рядом)
├── mask.png                # Маска защищённых зон ластика (опционально)
├── example.png             # Пример для наложения при редактировании (опционально)
├── preset1.png             # Пресеты масок для ластика (опционально)
├── preset2.png
├── preset3.png
├── token_rings/            # Папка с кольцами токенов (PNG/WebP)
├── templates/
│   └── index.html          # Единственный HTML-шаблон (Jinja2)
└── static/
    ├── css/
    │   └── style.css       # Все стили, CSS custom properties в :root
    └── js/
        ├── config.js       # Константы CONFIG, MOVE_KEYS, ROTATE_KEYS и т.д.
        ├── state.js        # Глобальный объект state (единственный источник истины)
        ├── utils.js        # $(), debounce(), toast(), formatSize(), clamp()
        ├── urlManager.js   # Управление Object URLs (create/revoke/revokeAll)
        ├── tokenEffects.js # createDropShadow(), applyColorCorrection(), downscaleCanvas()
        ├── tokenHistory.js # TokenHistory: save/restore/undo/redo
        ├── tokenPresets.js # TokenPresets: маски, пресеты, кольца, пример
        ├── tokenCanvas.js  # TokenCanvas: canvas, ластик, рендер, события мыши
        ├── tokenEditor.js  # TokenEditor: UI-логика редактора токенов
        ├── remover.js      # Remover: пакетное удаление фона
        └── main.js         # init(), вкладки, глобальные хоткеи, paste-handler

---

## Flask-маршруты (server.py)

| Маршрут | Метод | Описание |
|---------|-------|----------|
| `/` | GET | Рендер templates/index.html |
| `/device` | GET | JSON `{device: "..."}` — текущее устройство инференса |
| `/process` | POST | Удаление фона. Form: `image` (file), `format` (webp/png/jpg), `quality` (int), `edge_blur` (float). Возвращает файл. |
| `/rings_list` | GET | JSON-список файлов из `token_rings/` |
| `/ring_file/<filename>` | GET | Отдаёт файл кольца из `token_rings/` |
| `/mask` | GET | Отдаёт `mask.png` или прозрачный PNG 1024x1024 |
| `/preset` | GET | `?name=preset1` — отдаёт файл пресета |
| `/example` | GET | Отдаёт `example.png/webp/jpg` |
| `/ring` | GET | Legacy: `?size=512/1024/2048` — старый маршрут для колец |

**Важно:** каждый маршрут должен быть объявлен ОДИН раз с декоратором `@app.route`.
Дублирование функций без декоратора — распространённая ошибка в этом проекте.

---

## Глобальный объект state (state.js)

Все модули читают и пишут в `state` напрямую. Это намеренное архитектурное решение.

Ключевые поля:


state.userImage          // HTMLImageElement — текущее изображение на канвасе
state.userImageOriginal  // оригинал до удаления фона
state.userImageWithoutBg // результат после удаления фона
state.maskCanvas         // HTMLCanvasElement — маска ластика (белое = видимо)
state.ringImages         // { 512: img, 1024: img, 2048: img }
state.currentTool        // 'move' | 'eraser'
state.eraserSize         // px, 1–200
state.imageScale         // множитель (1.0 = 100%)
state.imageX/imageY      // смещение в координатах 1024px-пространства
state.imageRotation      // градусы
state.viewZoom           // масштаб камеры
state.viewPanX/viewPanY  // панорамирование камеры
state.history[]          // массив снимков для undo/redo
state.historyIndex       // текущая позиция

---

## Система координат канваса

Внутренний канвас всегда `CONFIG.INTERNAL_SIZE × CONFIG.INTERNAL_SIZE` = **2048×2048 px**.

Пространство изображения — логические единицы **1024 px**.
Пересчёт: `scale = CONFIG.INTERNAL_SIZE / 1024` = **2**.

`state.imageX/imageY` хранятся в 1024-единицах, умножаются на scale при рендере.

---

## Кольца токенов

Кольца хранятся в папке `token_rings/` (PNG или WebP).
Имена файлов произвольные — отображаются как есть в UI.

Маршрут `/rings_list` возвращает список, `/ring_file/<filename>` отдаёт файл.
При выборе кольца в UI вызывается `TokenPresets.loadSingleRing(filename)`,
который загружает blob и записывает в `state.ringImages = { 2048: img, 1024: img, 512: img }`.

---

## Ластик и маска

`state.maskCanvas` — канвас 2048×2048:
- **белый пиксель** = видимая область
- **прозрачный пиксель** = стёртая область

При рендере: изображение рисуется во временный канвас, затем применяется
`globalCompositeOperation = 'destination-in'` с maskCanvas.

`state.erasableCanvas` — маска защищённых зон из `mask.png`.
Ластик не может стереть защищённые зоны (розовые/пурпурные пиксели в mask.png).

Логика определения защищённых пикселей в `TokenPresets.processMaskImage()`:
пиксели с `a>128 && r>100 && b>100 && g<150` → прозрачные в erasableCanvas.

---

## Удаление фона (AI)

Поток: `handleRemoveBackground()` в `tokenEditor.js`:
1. Рисует `state.userImageOriginal` в tempCanvas → blob PNG
2. POST `/process` с `format=png`
3. Получает blob → создаёт ObjectURL → новый Image
4. Записывает в `state.userImageWithoutBg`, `state.userImage`
5. Вызывает `TokenCanvas.render()`

На сервере (`server.py`):
- Изображение ресайзится до 1024×1024
- Нормализация ImageNet
- Инференс через ONNX Runtime
- Sigmoid + нормализация маски
- `refine_mask()`: пороговая обработка + MinFilter + GaussianBlur
- Результат: RGBA PNG через `send_file`

---

## История (undo/redo)

`TokenHistory` хранит снимки в `state.history[]`.
Каждый снимок: `{ mask: canvas, x, y, scale, rotation }`.

Лимит: `CONFIG.MAX_HISTORY = 75` записей.
Горячие клавиши: `Ctrl+Z` / `Ctrl+Y` / `Ctrl+Shift+Z`.

---

## Правила разработки

### Python (server.py)
- Каждый `@app.route` — строго один раз
- Нет `if __name__ == '__main__'` дублирования
- Валидация всех входных данных перед обработкой
- `app.logger.error()` для логирования ошибок с `exc_info=True`
- `MAX_CONTENT_LENGTH = 50MB`

### JavaScript
- Никаких фреймворков — только Vanilla JS
- Глобальные объекты: `TokenCanvas`, `TokenEditor`, `TokenHistory`, `TokenPresets`, `Remover`, `urlManager`, `state`, `CONFIG`
- Все ObjectURL создаются через `urlManager.create()` и освобождаются через `urlManager.revoke()`
- Хелпер `$(id)` = `document.getElementById(id)`
- `debounce()` для дорогих операций (сохранение истории)
- Файл `config.js` загружается первым — все константы там

### CSS
- Все цвета и размеры — через CSS custom properties из `:root`
- Никакого инлайн-стиля кроме динамического JS (`element.style.display`)
- БЭМ не используется, классы описательные (`.ring-item`, `.tool-card`)

### HTML (templates/index.html)
- Единственный шаблон, рендерится Flask через Jinja2
- JS-файлы подключаются в конце `<body>` в строгом порядке (см. текущий порядок)
- ID элементов используются как основной способ доступа из JS

---

## Частые ошибки

| Ошибка | Причина | Решение |
|--------|---------|---------|
| Кольца не загружаются | Синтаксическая ошибка в `tokenPresets.js` → весь файл не парсится | Проверить `loadRings()` и `loadSingleRing()` |
| `/process` 500 | `model.onnx` не найден рядом с `server.py` | Положить модель в корень проекта |
| Маршрут не найден | Flask зарегистрировал только первый `@app.route`, второй — просто функция | Убрать дублирование в `server.py` |
| Изображение не рендерится | `state.userImage` null или `state.maskCanvas` null | Проверить `loadImage()` и `createMask()` |
| ObjectURL утечка | URL создан без `urlManager` | Использовать только `urlManager.create()` |

---

## Запуск


# Windows
start.bat

# Прямой запуск
python app.py

# Только сервер (без окна)
python server.py

Порт: **7878** (только localhost).
Модель: **model.onnx** должна лежать рядом с `server.py`.
Кольца: папка **token_rings/** рядом с `server.py`.
