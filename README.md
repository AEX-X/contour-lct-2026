# Backend — сервис прогнозирования инцидентов Москоллектора

Бэкенд-часть хакатонного MVP: REST API по контракту фронтенда, схема БД, RBAC, потоковый ETL, эмуляция внешних источников (СМВУ/ОДС/реестр оборудования/система заявок), ML Prediction Port + Stub Predictor, локальный жизненный цикл заявок на ремонт, журнал аудита и TLS. Подробнее о границах и терминологии — `CONTEXT.md`; о принятых архитектурных решениях — `docs/adr/`; о доменной архитектуре и способах обработки данных — `docs/ARCHITECTURE.md` и `docs/DATA_PROCESSING.md`; о безопасности (сверка с ТЗ по пунктам) — `docs/SECURITY.md`; о честных MVP-ограничениях — `docs/LIMITATIONS.md`.

## Запуск (с нуля)

```
docker compose up --build
```

Поднимутся три контейнера: `db` (PostgreSQL 16), `app` (FastAPI) и `proxy` (nginx с TLS). При старте `app` автоматически применяет миграции Alembic (`alembic upgrade head`), засеивает справочники и реальный датасет (объекты, каналы датчиков, операционное окно журнала событий), поднимает эмуляцию внешних источников (ОДС/реестр/заявки/replay СМВУ) и материализует события/прогнозы. `proxy` при первом запуске сам создаёт самоподписанный сертификат.

API доступен только по HTTPS: **https://localhost:8443**. Порт 8080 отвечает перенаправлением на HTTPS. Приложение и база наружу напрямую не публикуются.

Проверка, что всё поднялось (`-k` — потому что сертификат самоподписанный):

```
curl -k https://localhost:8443/health
```

Ожидаемый ответ: `{"status":"ok"}`.

Остановка:

```
docker compose down
```

### Самоподписанный сертификат

- Браузер при первом заходе покажет предупреждение о недоверенном сертификате — это ожидаемо, его можно принять для демо.
- Для `curl` используйте ключ `-k`, для клиентов на Python/Node — отключение проверки сертификата только в демо-окружении.
- Сертификат хранится в томе `proxy_certs` и переиспользуется при перезапусках. Чтобы поставить свой (например, выпущенный УЦ заказчика), положите `server.crt` и `server.key` в этот том; чтобы пересоздать самоподписанный — удалите том `proxy_certs`.
- Если порты 8443/8080 заняты, задайте другие: `HTTPS_PORT=443 HTTP_PORT=80 docker compose up --build`.

## API-контракт

Swagger UI (интерактивная документация, тот же контракт, что видит фронтенд-команда): **https://localhost:8443/docs**
Машиночитаемая спецификация: `https://localhost:8443/openapi.json` (актуальный снимок для пакета сдачи — `docs/openapi.json`).

Основные группы эндпоинтов (`/api/v1/*`):

| Группа | Эндпоинты |
|---|---|
| Auth | `POST /auth/login`, `POST /auth/logout`, `GET /me` |
| Справочники | `GET /config` |
| Объекты | `GET /facilities`, `/facilities/{id}`, `/facilities/{id}/hierarchy`, `/facilities/{id}/layout` |
| Датчики | `GET /sensors`, `/sensors/{id}`, `/sensors/{id}/series` |
| События | `GET /events` |
| Риски/прогнозы | `GET /risks`, `/risks/{id}`, `POST /risks/{id}/acknowledge\|reject\|defer` |
| Заявки | `POST /work-orders`, `GET /work-orders` |
| Статус источников | `GET /system/source-health`, `GET /system/scenarios`, `POST /system/scenarios/{id}/activate`, `POST`/`DELETE /system/source-health/{source}/degrade` |
| Журнал аудита | `GET /audit` |

Каждый ответ несёт заголовок `X-Trace-Id`; по нему запрос находится в журнале аудита.

## Демо-пользователи

Сеятся автоматически при старте (см. `src/services/demo_seed.py`):

| Логин | Пароль | Роль | Scope | Права |
|---|---|---|---|---|
| `manager` | `manager123` | Руководитель | все объекты | все, включая `system.manage` (управление эмуляцией) и `audit.read` (журнал аудита) |
| `dispatcher` | `dispatcher123` | Диспетчер объекта | только `fac_5122`/`fac_5339` | `facility.read.assigned`, `sensor.read`, `risk.read`, `risk.acknowledge`, `work_order.read`, `work_order.create_draft` |

Сессия действует 480 минут (`SESSION_TTL_MINUTES`), `POST /auth/logout` завершает её сразу. После 5 неудачных попыток входа логин блокируется на время окна (ответ 429) — подробности в `docs/SECURITY.md`.

## Локальная разработка без Docker

```
python -m venv .venv
source .venv/Scripts/activate   # Windows Git Bash
# .venv\Scripts\activate.bat    # Windows cmd
pip install -r requirements.txt
cp .env.example .env            # при необходимости поправить DATABASE_URL
alembic upgrade head
uvicorn src.main:app --reload
```

База из `docker compose` наружу не публикуется, поэтому для локального запуска нужен свой PostgreSQL, например:

```
docker run -d --name mkl-dev-db -e POSTGRES_USER=mkl -e POSTGRES_PASSWORD=mkl -e POSTGRES_DB=mkl -p 5432:5432 postgres:16-alpine
```

Локальный `uvicorn` работает по обычному HTTP на `http://localhost:8000` — TLS обеспечивает только прокси в `docker compose`.

## Тесты

Внутри Docker (ничего устанавливать не нужно):

```
docker compose up -d --wait db
docker compose run --rm --no-deps app sh -c "alembic upgrade head && pytest -q"
```

Локально — `pytest` с доступной базой в `DATABASE_URL` (см. раздел выше).

## Конфигурация

Все настройки читаются из переменных окружения (см. `.env.example`):

| Переменная | Назначение | По умолчанию |
|---|---|---|
| `DATABASE_URL` | строка подключения к PostgreSQL (asyncpg) | `postgresql+asyncpg://mkl:mkl@localhost:5432/mkl` |
| `APP_ENV` | имя окружения | `local` |
| `LOG_LEVEL` | уровень логирования | `INFO` |
| `ML_PREDICTOR_URL` | URL внешнего ML-сервиса, реализующего ML Prediction Port (`docs/adr/0006-ml-port-bespoke-not-indastrics-shaped.md`). Если не задан — используется встроенный `StubPredictor` | не задан (используется stub) |
| `REPLAY_SPEED_MULTIPLIER` | сколько виртуальных секунд эмуляции СМВУ проходит за одну реальную секунду | `360.0` |
| `REPLAY_TICK_SECONDS` | интервал между тиками фонового replay-движка | `5.0` |
| `SESSION_TTL_MINUTES` | срок жизни сессии после входа | `480` |
| `LOGIN_MAX_FAILURES_PER_USERNAME` | неудачных входов на один логин в окне до блокировки | `5` |
| `LOGIN_MAX_FAILURES_PER_IP` | неудачных входов с одного IP в окне до блокировки | `20` |
| `LOGIN_FAILURE_WINDOW_SECONDS` | окно подсчёта неудачных входов, секунд | `900` |
| `HTTPS_PORT` | порт хоста для HTTPS (docker compose) | `8443` |
| `HTTP_PORT` | порт хоста для перенаправления с HTTP (docker compose) | `8080` |

## Подключение ML-сервиса

Backend взаимодействует с ML-частью через HTTP-контракт, а не через Python-интерфейс внутри бэкенда (`docs/adr/0001-backend-only-mvp-scope-with-integration-ports.md`, `docs/adr/0006-ml-port-bespoke-not-indastrics-shaped.md`). Вызовы идут только в одну сторону: **backend сам обращается к ML-сервису**, ML-сервису не нужен ни токен, ни доступ к API или базе backend.

Что backend вызывает по адресу `ML_PREDICTOR_URL`:

| Вызов | Когда | Контракт |
|---|---|---|
| `POST /predict` | при старте, один раз на каждый канал с тревогами без прогноза | `PredictionInput` / `PredictionResult` в `src/services/ml_port.py` |
| `POST /risk_map` с `target` = `incident` и `failure` | один раз при старте | ответ со списком `objects`; объект с `alert` становится риском по объекту (`target_type = "facility"`), см. `src/services/object_risk_sync.py` |

Без `ML_PREDICTOR_URL` backend работает на встроенном `StubPredictor`, риски по объектам не создаются.

### Запуск вместе с ML-сервисом (репозиторий LCT-ML)

1. Поднять ML-сервис на хосте. Запускайте его с `--host 0.0.0.0`: на Docker Desktop (Windows/macOS) контейнер видит и сервис на `127.0.0.1`, но на Linux — только слушающий внешний интерфейс:

   ```
   .venv/bin/python outputs/ml-service/service.py --prepared work/ml-prepared \
     --config outputs/ml-dataset/dataset-config.json --decision outputs/ml-baseline-v2/decision.json \
     --directory <справочник_каналов_датчиков.csv> \
     --object-decision outputs/ml-baseline-v2/run-008-incident72/object-decision.json \
     --object-decision outputs/ml-baseline-v2/run-009-neispraven168/object-decision.json \
     --host 0.0.0.0 --port 8090 --demo-anchor 2026-06-20T00:00:00
   ```

   `--demo-anchor` нужен, потому что backend спрашивает прогноз на текущее время, а журнал ML заканчивается 30.06.2026.

2. Поднять backend, указав адрес ML-сервиса. Из контейнера хост-машина доступна как `host.docker.internal`:

   ```
   ML_PREDICTOR_URL=http://host.docker.internal:8090 docker compose up --build
   ```

   В PowerShell: `$env:ML_PREDICTOR_URL="http://host.docker.internal:8090"; docker compose up --build`.

3. Проверить: `GET https://localhost:8443/api/v1/risks` под `manager` — у рисков в поле `model` будет имя модели ML-сервиса, риски по объектам имеют `target.type = "facility"`.

Если backend запущен локально без Docker, адрес — `ML_PREDICTOR_URL=http://127.0.0.1:8090`.

### Поведение при ошибках ML

- Ответ ML с ошибкой (например, `422 insufficient_data` для канала без свежих данных) или недоступный сервис не роняют backend: канал пропускается, в лог пишется предупреждение с числом пропущенных каналов, курсор событий сдвигается, повторных запросов по кругу нет.
- Если `/risk_map` недоступен или ответил некорректно, риски по объектам не создаются (предупреждение в логе), остальной старт продолжается.
- Канал, по которому модель ответила `alert = false`, риска не получает и повторно не запрашивается.

### Уровни риска: по порогу модели

У каждой модели ML свой рабочий порог (около 0,15 у канальной, 0,65 и 0,56 у моделей по объектам), поэтому общая шкала вероятности не подходит. Уровень считается от тревоги самой модели (правило согласовано с ML-командой, отдаётся в `GET /config` как `model_alert_rule`):

| Условие | Уровень |
|---|---|
| модель не подняла тревогу (`alert = false`) | риск не создаётся |
| тревога, вероятность ниже 0,85 | «Средний» |
| тревога, вероятность от 0,85 | «Высокий» |

- «Критический» из прогнозов ML не выдаётся.
- SLA — треть горизонта прогноза: 8 ч для прогноза на 24 ч, 24 ч для 72 ч, 56 ч для 7 суток. Реагировать нужно до начала окна прогноза, а не к его концу.
- В `/risks` поле `threshold` — нижняя граница уровня (0,85 для «Высокого», порог модели для «Среднего»); отдельно отдаются `alert` и `model_threshold`.

**Что должен присылать ML-сервис.** В ответе `/predict` — необязательные поля `alert` (boolean), `model_threshold` (число) и `horizon_hours` (число больше 0). Пока их нет, прогнозы по датчикам считаются по общей шкале 0,3 / 0,6 / 0,85 с SLA по уровню (как у `StubPredictor`), а у рисков `alert = null`. Как только ML начнёт присылать поля, правило включится само — менять backend не нужно. Поля неверного типа считаются ошибкой ответа: канал пропускается. Для `/risk_map` правило действует уже сейчас: там есть и `alert`, и горизонт; порог берётся из `model_threshold`, а если его нет — из текущего поля `threshold` строки.
