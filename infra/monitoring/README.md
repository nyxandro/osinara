# Пакет наблюдения Osinara

Описание того, за чем следить в Osinara. Сама система наблюдения живёт отдельно:
[nyxandro/observability](https://github.com/nyxandro/observability) — там хаб, сборщик, скрипты
установки и [контракт пакета](https://github.com/nyxandro/observability/blob/main/docs/PROJECT-PACK.md).

Приложение об этих файлах ничего не знает и от них не зависит. Сборщик работает отдельным проектом
контейнеров и читает stdout Osinara снаружи, через read-only прокси к Docker.

## Что здесь лежит

| Файл | Что делает |
| --- | --- |
| `pack.conf` | Имя проекта и список файлов с секретами, которых в пакете нет |
| `collector/compose.override.yaml` | Добавляет к сборщику `sql-exporter` и включает его в сеть Osinara |
| `collector/sql-exporter.yaml` | Запросы к вьюхам `monitoring_*` боевой базы: очередь, память, расписания, доступность модели |
| `collector/alloy/50-osinara-sql.alloy` | Велит сборщику опрашивать этот экспортёр раз в 30 секунд |
| `collector/osinara-metrics.env.example` | Образец доступа к базе. Реальный файл — только на сервере, `0600` |
| `rules/metrics/osinara.yaml` | Тревоги по кодам ошибок в логах и по ответам модели |
| `rules/metrics/osinara-state.yaml` | Тревоги по состоянию: очередь входящих, память, режим обслуживания |
| `rules/logs/osinara.yaml` | Считает строки логов по кодам и превращает их в числовые ряды |

## Половины живут на разных машинах

`collector/` ставится на сервер, где работает Osinara. `rules/` — на сервер хаба. Поэтому цель
указывается явно:

```bash
# на сервере Osinara
sudo install/add-project.sh /path/to/osinara/infra/monitoring --target collector

# на хабе
sudo install/add-project.sh /path/to/osinara/infra/monitoring --target hub
```

Перед первым запуском на сервере Osinara нужно положить `/opt/monitoring-agent/osinara-metrics.env`
с правами `0600` по образцу из `collector/`. Без него экспортёр не поднимется — и это правильнее,
чем стартовать с придуманным паролем и молча не отдавать ни одной метрики.

## Привязка к коду приложения

Эти файлы ломаются от изменений в Osinara, и ломаются молча:

- **`sql-exporter.yaml`** делает `SELECT` из вьюх `monitoring_*`. Переименуете вьюху или колонку —
  метрика исчезнет, а тревога на неё никогда не сработает.
- **`rules/` перечисляют коды ошибок** — `AGENT_MEMORY_UNAVAILABLE`, `AGENT_TELEGRAM_DRAIN_FAILED`
  и другие. Переименуете код в приложении — правило перестанет ловить сбой, который оно ловило.
- **`compose.override.yaml` присоединяется к сети** `osinara-production-app-network`. Переименуете
  сеть в `compose.production.yaml` — экспортёр не поднимется вовсе.

Поэтому пакет лежит здесь, а не в репозитории наблюдения: правка кода и правка наблюдения попадают
в один pull request.

## Чего здесь нет

Семь вьюх `monitoring_*` существуют только в боевой базе и пока не заведены миграцией. На чистой
установке их не будет, и наблюдение поднимется без метрик приложения. Это известный остаток,
см. issue #169.
