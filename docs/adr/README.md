# Architecture Decision Records

Архитектурните решения на СИГМА се записват тук като **ADR** — по едно решение на файл, така че
контекстът да не се губи в код-коментари и PR-и. Новите решения се добавят със следващия пореден
номер; приетите не се пренаписват — заменят се с нов ADR със статус „Заменено от ADR-MMMM".

Нов ADR: копирай [`_template.md`](_template.md), вземи следващия номер, добави ред в таблицата долу.

| # | Решение | Статус |
| --- | --- | --- |
| [0001](0001-rendering-and-security.md) | Стратегия за рендиране (React Router v7 на Workers) и модел на сигурност | Прието |
| [0002](0002-d1-as-datastore.md) | Cloudflare D1 като обслужващо хранилище | Прието |
| [0003](0003-value-flag-data-quality.md) | `value_flag`/`date_flag` verdict + единна стойностна база | Прието |
| [0004](0004-style-src-unsafe-inline.md) | `style-src` запазва `'unsafe-inline'` (CSP) | Прието |
| [0005](0005-blue-green-d1-rollback.md) | Blue/green D1 слотове за rollback на refresh | Прието |
| [0006](0006-eop-wins-dedup.md) | Dedup на два източника: EOP печели по `contract_number` | Прието |
