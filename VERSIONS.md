# Зафиксированные источники

Монорепозиторий собран из трёх частей. Этот файл фиксирует исходные версии, чтобы сборку можно было воспроизвести и сопоставить с репозиториями команд

| Компонент | Репозиторий | Исходный commit | Способ включения |
|---|---|---|---|
| Backend | [Runoi/LCT-backend](https://github.com/Runoi/LCT-backend) | `f4ed545489eef0f6d8fe441eacd6a880701a21b7` | основа монорепозитория |
| Frontend | локальный репозиторий Contour | `d7f233c7e6a0300d6dc501a9e3a5a96214f1f610` | `git subtree`, каталог `frontend/` |
| ML | [lex4ssss/LCT-ML](https://github.com/lex4ssss/LCT-ML) | `8d58eb370e8502eae6aa16b2347e9b96b96f1542` | `git subtree`, каталог `ml/` |

Интеграционные изменения поверх этих версий включают единый gateway, сборку frontend в API-режиме, разделённые full/lite окружения, проверки ML-данных и PowerShell-команды запуска

## Обновление subtree

Обновлять источник нужно осознанно и только после чистого статуса Git

```powershell
git subtree pull --prefix=ml https://github.com/lex4ssss/LCT-ML.git main --squash
```

После обновления обязательно выполнить тесты компонента, `docker compose config` для обоих режимов и полный smoke-test
