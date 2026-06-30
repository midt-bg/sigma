# Архитектура

Преглед на системата на едно място и указател към записаните решения. **Архитектурните решения
живеят като ADR в [`adr/`](adr/README.md)** — този файл е картата, не източникът на истина за
отделните решения.

## Поток на данните

```
ЦАИС ЕОП (storage.eop.bg)  ──bulk/cron──▶  sigma-etl (Worker + Workflow)
                                                │  load → normalize → derive → precompute
                                                ▼
                                          D1 (една база на среда)
                                                ▲
                                                │  read-only
                          граждани / журналисти ──▶  sigma (RR v7 SSR Worker)
```

Данните пристигат като **периодични bulk зареждания**, не като жива емисия. ETL-ът пише в D1; explorer-ът
чете от **същия** D1. В v1 няма публичен write път и няма автентикация.

## Двата Worker-а

| Worker     | Роля                                                              |
| ---------- | ----------------------------------------------------------------- |
| `sigma`    | SSR explorer (`apps/web`) — чете D1 директно, edge-кешира HTML.    |
| `sigma-etl`| cron-задействан refresh Workflow (`apps/etl`) — пише в D1.         |

## Рендиране и сигурност (резюме)

- **Рендиране:** хибридно според повърхността — пре-рендиране за статичните страници, SSR + edge
  кеш за обемните детайлни/explorer страници, клиентски „острови" за интерактивните визуализации.
- **Сигурност:** приоритет интегритет ≈ наличност ≫ конфиденциалност (данните са публични). Read
  пътят остава read-only; строг CSP + security headers; D1 само с bound параметри.

Пълната обосновка и приетите компромиси — [ADR-0001](adr/0001-rendering-and-security.md).

## Решения (ADR)

Виж индекса в [`adr/README.md`](adr/README.md). Ключовите за v1: рендиране/сигурност (0001),
D1 като хранилище (0002), `value_flag` стойностна база (0003), CSP `style-src` (0004), blue/green
rollback (0005), dedup на двата източника (0006).

## Справочни документи

- [`core-scope.md`](core-scope.md) — доменен модел и речник на данните.
- [`etl.md`](etl.md) — ETL pipeline и емисията от ЦАИС ЕОП.
- [`v1-implementation-plan.md`](v1-implementation-plan.md) — precompute слой и пагинация.
- [`integrity-gate.md`](integrity-gate.md) — reconciliation gate (hard asserts върху тоталите).
- [`deploy.md`](deploy.md) — деплой към Cloudflare.
- [`accessibility.md`](accessibility.md) — достъпност (WCAG 2.1 AA).
- [`spec/ai-assistant.md`](spec/ai-assistant.md) — спецификация на AI асистента (планиран).
