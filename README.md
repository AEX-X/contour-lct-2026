# Contour

Единый локальный дистрибутив системы предиктивного обслуживания инженерной инфраструктуры АО «Москоллектор»

Один репозиторий содержит frontend, backend, модели ML и инфраструктуру запуска. Пользователь открывает один адрес, а внутренние компоненты работают в изолированной Docker-сети

## Навигация по монорепозиторию

| Часть системы | Основные каталоги и файлы | Что внутри |
|---|---|---|
| Frontend | `frontend/` | React 19, TypeScript, роли, карты, аналитика, заявки и PWA |
| Backend | `src/`, `alembic/`, `tests/`, `Dockerfile` | FastAPI, PostgreSQL, RBAC, API, миграции и backend-тесты |
| ML | `ml/`, `deploy/ml.Dockerfile`, `ml-data/` | модели, сервис прогнозирования и точка подключения подготовленного журнала |
| Gateway и Docker | `proxy/`, `docker-compose*.yml`, `deploy/` | единая HTTPS-точка входа, образы и варианты запуска Full, Lite и Preview |
| Команды | `scripts/` | проверка данных, запуск, smoke-тесты, тесты backend, остановка и сброс |
| Документация | `docs/`, `info/`, `VERSIONS.md` | архитектура, безопасность, API, ограничения, требования и версии исходных компонентов |
| Демо-справочники | `data/` | небольшой проверяемый набор объектов, каналов и событий для стенда |

Подготовленные годовые файлы ML намеренно не хранятся в Git. Каталог `ml-data/` содержит только инструкцию, а сами `2019.parquet` ... `2026.parquet` подключаются локально read-only

```text
Браузер
   |
   | https://localhost:8443
   v
Nginx gateway
   |-- /                 -> React frontend
   |-- /api/v1/*         -> FastAPI backend
   |-- /health           -> FastAPI health
   |-- /docs             -> Swagger UI
   `-- /openapi.json     -> OpenAPI
          |
          +-- PostgreSQL
          `-- ML service -> подготовленный журнал 2019-2026
```

Наружу публикуются только порты `8080` и `8443`. PostgreSQL, FastAPI и ML не имеют host ports

## Режимы запуска

| Режим | Команда | Прогнозы | Данные |
|---|---|---|---|
| Full, основной | `.\scripts\start-full.ps1` | обученные ML-модели | нужны `2019.parquet` ... `2026.parquet` |
| Lite, разработка | `.\scripts\start-lite.ps1` | явно обозначенный `StubPredictor` | дополнительные файлы не нужны |

Full и Lite используют разные Docker project names, базы и TLS volumes. Поэтому данные StubPredictor не смешиваются с результатами настоящих моделей

`start-full.ps1` не переключается на заглушку при ошибке. Он останавливается, если нет любого годового Parquet, файл не имеет сигнатуру Parquet, ML не стал healthy или API не вернул прогноз реальной модели

## Требования

- Windows 10 или 11
- Docker Desktop с Linux containers
- Docker Compose v2
- PowerShell 7 рекомендуется, Windows PowerShell 5.1 также поддерживается скриптами
- свободные порты `8080` и `8443`
- для Full режима достаточно места и памяти для загрузки подготовленного журнала

Проверить Docker:

```powershell
docker version
docker compose version
docker info
```

Если `docker info` не отвечает, запусти Docker Desktop и дождись готовности Linux engine

## Быстрый запуск Full

### 1. Подготовь ML-данные

В каталоге `ml-data` должны лежать восемь файлов:

```text
ml-data/
  2019.parquet
  2020.parquet
  2021.parquet
  2022.parquet
  2023.parquet
  2024.parquet
  2025.parquet
  2026.parquet
```

Проверить данные до сборки:

```powershell
.\scripts\check-ml-data.ps1
```

Если файлы находятся в другом месте, копировать их не нужно:

```powershell
.\scripts\check-ml-data.ps1 -MlDataDir "D:\LCT\ml-prepared"
```

Годовые Parquet не добавляются в Git, не копируются в Docker image и подключаются к ML-контейнеру read-only

Если у тебя есть только восемь исходных архивов организаторов `ext-journal-2019.7z` ... `ext-journal-2026.7z`, подготовь файлы одной командой:

```powershell
.\scripts\prepare-ml-data.ps1 -SourceDir "C:\path\to\dataset"
```

Скрипт:

- сверяет размер и SHA-256 каждого архива с `ml/docs/sources.json`
- создаёт отдельное Python 3.12 окружение в gitignored `.cache`
- распаковывает и обрабатывает по одному году, не удерживая весь архив на диске одновременно
- вызывает официальную функцию `ml/outputs/ml-dataset/prepare.py`
- включает подтверждённую точную дедупликацию только для 2019 и 2023 годов
- записывает результат атомарно и при повторном запуске пропускает готовые корректные годы
- не изменяет исходные архивы и не добавляет данные в Git

Для первого запуска нужен доступ в интернет, чтобы установить зафиксированные `duckdb` и `py7zr`. Кэш можно вынести на другой диск:

```powershell
.\scripts\prepare-ml-data.ps1 `
  -SourceDir "D:\LCT\dataset" `
  -OutputDir "D:\LCT\ml-prepared" `
  -CacheDir "E:\Contour-prepare-cache"
```

Если архивы защищены паролем, перед запуском задай его только в текущем процессе, не записывая в `.env` или Git:

```powershell
$env:CONTOUR_DATASET_PASSWORD="пароль"
.\scripts\prepare-ml-data.ps1 -SourceDir "D:\LCT\dataset"
Remove-Item Env:CONTOUR_DATASET_PASSWORD
```

### 2. Запусти продукт

```powershell
.\scripts\start-full.ps1
```

Или укажи внешний каталог:

```powershell
.\scripts\start-full.ps1 -MlDataDir "D:\LCT\ml-prepared"
```

Скрипт выполняет проверку данных, валидацию Compose, сборку четырёх сервисов, ожидание healthchecks и сквозной smoke-test

### 3. Открой приложение

- приложение: [https://localhost:8443](https://localhost:8443)
- Swagger: [https://localhost:8443/docs](https://localhost:8443/docs)
- healthcheck: [https://localhost:8443/health](https://localhost:8443/health)

### Временная ссылка для командной проверки

После запуска Full можно открыть production-сборку команде через временный SSH-туннель localhost.run:

```powershell
.\scripts\start-preview.ps1
```

Скрипт собирает контейнер туннеля и печатает случайный HTTPS-адрес `*.lhr.life`. Ссылка работает только пока включены этот компьютер, Docker и сервисы `preview` и `preview-gateway`. Она предназначена только для командного тестирования демо-данных и не заменяет постоянный сервер

Если анонимный маршрут localhost.run истёк, повторный запуск команды проверит старый адрес и автоматически пересоздаст только контейнер туннеля. Backend, база, ML и frontend при этом не перезапускаются. Новый адрес нужно заново отправить участникам команды

Остановить внешний доступ:

```powershell
.\scripts\stop-preview.ps1
```

На внешней preview-ссылке используется доверенный TLS-сертификат localhost.run. Самоподписанный сертификат и предупреждение браузера относятся только к локальному адресу `https://localhost:8443`

## Lite режим

Lite нужен для разработки frontend и проверки API без тяжёлого журнала ML

```powershell
.\scripts\start-lite.ps1
```

При запуске скрипт явно предупреждает, что используется StubPredictor. Lite имеет отдельную базу `contour-lite`, поэтому после него Full не наследует тестовые прогнозы

## Демо-вход

| Логин | Пароль | Назначение |
|---|---|---|
| `manager` | `manager123` | руководитель, доступ ко всем объектам |
| `senior_dispatcher` | `senior123` | старший диспетчер нескольких закреплённых объектов |
| `dispatcher` | `dispatcher123` | технический диспетчер одного объекта |
| `coordinator` | `coordinator123` | координатор ремонтных работ и назначений |
| `engineer` | `engineer123` | инженер выездной бригады с доступом по заявке |

Пароли предназначены только для локального хакатонного стенда

Быстрый выбор аккаунтов на экране входа включён только для demo build через `VITE_SHOW_DEMO_CREDENTIALS=true`. Для любого другого развёртывания установи `false`

## Основной сквозной сценарий

1. Диспетчер объекта создаёт заявку на конкретный датчик, оборудование, участок или объект и отправляет её координатору
2. Координатор выполняет триаж, при необходимости запрашивает уточнение, фиксирует приоритет и SLA, затем назначает инженера
3. Инженер принимает работу, отмечает выезд и начало ремонта, при необходимости готовит офлайн-пакет, заполняет структурированный отчёт и синхронизирует его
4. Диспетчер проверяет результат, возвращает работу на доработку или закрывает заявку
5. Руководитель видит все объекты, аналитику, SLA, аудит и может отменить заявку либо зарегистрировать управленческий override

Статусы не меняются автоматически по времени. Каждое действие проходит RBAC и scope-проверку, optimistic locking по `version`, idempotency и append-only аудит

## Управление

Проверить уже запущенный стенд:

```powershell
.\scripts\smoke-test.ps1 -Mode Full
.\scripts\smoke-test.ps1 -Mode Lite
```

Остановить контейнеры без удаления БД:

```powershell
.\scripts\stop.ps1 -Mode Full
.\scripts\stop.ps1 -Mode Lite
.\scripts\stop.ps1 -Mode All
```

Полностью удалить БД и локальный TLS-сертификат выбранного режима:

```powershell
.\scripts\reset.ps1 -Mode Full -Force
.\scripts\reset.ps1 -Mode Lite -Force
.\scripts\reset.ps1 -Mode All -Force
```

Reset не удаляет и не изменяет файлы в `ml-data`

## Что проверяет smoke-test

- `/health` отвечает `status: ok`
- gateway отдаёт настоящий frontend, а не API-ответ
- авторизация `manager` проходит через FastAPI
- `/api/v1/me` и `/api/v1/risks` доступны с bearer token
- Full backend действительно настроен на `http://ml:8090`
- backend видит внутренний ML healthcheck
- внутренний ML `/quality` отдаёт отчёты `incident` и `neispraven`
- Full API содержит прогноз хотя бы одной модели, отличной от `stub-v1`
- Full база не содержит смешанных прогнозов StubPredictor
- Full API явно отдаёт исторический `demo_clock`, а `as_of` и начало окна не подменены текущим временем
- все актуальные real-model прогнозы имеют `demo_clock`, а старые непроверяемые записи помечены неактуальными и исключены из очереди
- Lite backend не имеет `ML_PREDICTOR_URL`
- gateway отдаёт ограничивающий Content Security Policy
- Swagger UI и её JS/CSS загружаются локально с того же origin, без внешнего CDN
- 20 независимых сессий пяти ролей одновременно проходят `/me` и scope-фильтрованный каталог объектов

## Сборка и маршрутизация

`proxy/Dockerfile` является multi-stage образом:

1. Node 22 выполняет `npm ci` и production build frontend
2. сборка получает `VITE_CONTOUR_DATA_MODE=api`
3. API base URL фиксируется как same-origin `/api/v1`
4. в финальный Nginx image копируются `frontend/dist/client` и зафиксированные локальные assets Swagger UI

Nginx обслуживает SPA через `try_files ... /index.html`, но API, healthcheck, Swagger и OpenAPI описаны отдельными location. Ошибка API поэтому никогда не превращается в `index.html`

Кэширование разделено:

- `/assets/*` с content hash кэшируются на год как immutable
- `index.html` и `sw.js` не кэшируются
- API, healthcheck и документация получают `Cache-Control: no-store`

## Сервисы

| Сервис | Назначение | Доступ с хоста |
|---|---|---|
| `proxy` | frontend, TLS и reverse proxy | `8080`, `8443` |
| `app` | FastAPI, миграции, RBAC, риски, заявки, аудит | нет |
| `db` | PostgreSQL 16 | нет |
| `ml` | модели каналов, объектов, насосов и `/quality` | нет, только Full |

Startup order контролируется healthchecks:

```text
db healthy ------> app healthy ------> proxy healthy
ml healthy --^         Full only
```

Backend начинает первичную синхронизацию прогнозов только после готовности ML. Proxy стартует только после готовности backend

В Full режиме первичный реальный расчёт входит в readiness backend и может занимать несколько минут. Healthcheck учитывает это отдельным 15-минутным start period, а скрипт запуска ждёт готовность до 20 минут

## Переменные окружения

При необходимости скопируй `.env.example` в `.env`. PowerShell-скрипты и Compose используют один файл с приоритетом: параметр скрипта, переменная текущего процесса, `.env`, значение по умолчанию

| Переменная | Значение по умолчанию | Назначение |
|---|---|---|
| `HTTP_PORT` | `8080` | HTTP с перенаправлением на HTTPS |
| `HTTPS_PORT` | `8443` | единая HTTPS-точка входа |
| `ML_DATA_DIR` | `./ml-data` | каталог восьми годовых Parquet |
| `ML_DEMO_ANCHOR` | `2026-06-20T00:00:00` | точка времени внутри исторического журнала |
| `POSTGRES_USER` | `mkl` | локальный пользователь БД |
| `POSTGRES_PASSWORD` | `mkl` | локальный пароль БД |
| `POSTGRES_DB` | `mkl` | локальная база |
| `CORS_ALLOWED_ORIGINS` | пусто | нужен только отдельному dev frontend |
| `VITE_SHOW_DEMO_CREDENTIALS` | `true` | быстрый выбор пяти локальных demo-аккаунтов; вне стенда установить `false` |

Встроенный frontend и API имеют общий origin, поэтому CORS для основного запуска не требуется

## Ручные Compose-команды

Основной путь на Windows это скрипты выше. Для диагностики можно запускать Compose напрямую

Full:

```powershell
$env:ML_DATA_DIR="D:\LCT\ml-prepared"
docker compose --project-name contour-full -f docker-compose.yml -f docker-compose.ml.yml config
docker compose --project-name contour-full -f docker-compose.yml -f docker-compose.ml.yml up --build
```

Lite:

```powershell
docker compose --project-name contour-lite -f docker-compose.yml config
docker compose --project-name contour-lite -f docker-compose.yml up --build
```

Не запускай Full и Lite одновременно с одинаковыми `HTTP_PORT` и `HTTPS_PORT`

## Локальная разработка frontend

Backend и база могут работать в Lite, а Vite отдельно на хосте:

```powershell
.\scripts\start-lite.ps1
cd frontend
npm ci
$env:VITE_CONTOUR_DATA_MODE="api"
$env:VITE_CONTOUR_API_BASE_URL="/api/v1"
$env:CONTOUR_API_PROXY_TARGET="https://localhost:8443"
npm run dev
```

Для отдельного Vite origin добавь его в `CORS_ALLOWED_ORIGINS`. Самостоятельная production-сборка frontend:

```powershell
cd frontend
npm run typecheck
npm run lint
npm test -- --run
npm run build
npm run test:sites
npm audit --omit=dev
```

Backend-тесты требуют PostgreSQL и описаны в `docs/COMPOSE.md`

## Частые проблемы

### Docker Engine недоступен

Запусти Docker Desktop. Команда `docker info` должна завершаться без ошибки

### Full не проходит проверку данных

Проверь имена `2019.parquet` ... `2026.parquet`. Скрипт также проверяет сигнатуру `PAR1` в начале и конце каждого файла, поэтому пустой или недописанный файл не будет принят

### ML долго становится healthy

Загрузка полного журнала может занимать несколько минут. Посмотри состояние и логи:

```powershell
docker compose --project-name contour-full -f docker-compose.yml -f docker-compose.ml.yml ps
docker compose --project-name contour-full -f docker-compose.yml -f docker-compose.ml.yml logs ml
```

### Порт занят

Задай другие host ports в текущей PowerShell-сессии:

```powershell
$env:HTTP_PORT="18080"
$env:HTTPS_PORT="18443"
.\scripts\start-full.ps1
```

### Браузер показывает старый frontend

Перезагрузи страницу с очисткой кэша и удали service worker для origin `https://localhost:8443`. `index.html` и `sw.js` на gateway уже отдаются без кэширования

### Full smoke-test нашёл `stub-v1`

Full и Lite должны запускаться только через свои скрипты. Миграция автоматически архивирует старые real-model прогнозы без проверяемого model clock и пересчитывает их, поэтому обычный перезапуск не требует удаления базы. Сброс нужен только если в Full volume действительно смешались данные StubPredictor:

```powershell
.\scripts\reset.ps1 -Mode Full -Force
.\scripts\start-full.ps1
```

## Структура

```text
frontend/                 React/Vite frontend
src/                      FastAPI backend
alembic/                  миграции БД
ml/                       код и артефакты ML subtree
ml-data/                  локальные Parquet, gitignored
proxy/                    gateway Dockerfile и Nginx template
deploy/ml.Dockerfile      ML image
scripts/                  Windows-команды запуска и проверки
docker-compose.yml        общий стек и Lite-конфигурация
docker-compose.ml.yml     Full ML overlay
VERSIONS.md               исходные версии компонентов
```

Архитектурные решения backend находятся в `docs/adr`, контракт API в `docs/openapi.json`, ограничения MVP в `docs/LIMITATIONS.md`, а версии исходных репозиториев в `VERSIONS.md`
