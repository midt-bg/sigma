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
| [0007](0007-scope-and-certainty-bar.md) | Свързани лица: обхват и праг на сигурност (само 100% детерминистични съвпадения) | Прието |
| [0008](0008-deterministic-name-to-eik-resolution.md) | Детерминистично разрешаване име→ЕИК (авто-публикуване; ръчна опашка само при двусмислие) | Прието |
| [0009](0009-name-uniqueness-guard-and-publish-tiers.md) | Пазач за уникалност на името + нива на публикуване (A_seat / B_distinctive / C_hold) | Прието |
| [0010](0010-pii-posture.md) | Позиция за лични данни: без ЕГН/адреси; третите лица — само за вътрешна проверка | Прието |
| [0011](0011-host-scoped-tls-pinning.md) | TLS pinning само за хоста (счупена верига на register.cacbg.bg), не глобален байпас | Прието |
| [0012](0012-crawler-and-persistence-architecture.md) | Архитектура на обхождането и съхранението (resumable; кеш по xml_file + ControlHash) | Прието |
| [0013](0013-two-declaration-templates.md) | Два шаблона декларации (имущество + интереси) в един парсер | Прието |
| [0014](0014-match-output-layers-and-interpretation.md) | Слоеве на съвпадението и тълкуване (собственост/контрол, времеви, собствена институция) | Прието |
| [0015](0015-tr-name-uniqueness-census.md) | Преброяване за уникалност на имена от ТР — промотира глобално уникални tier-C връзки | Прието |
| [0016](0016-free-text-entity-resolution.md) | Разрешаване на субекти от свободен текст (деклариран ЕИК + извличане от проза) | Прието |
| [0017](0017-name-collision-tier-gate.md) | Гейт срещу колизия на имена извън отличаващото ниво | Прието |
| [0018](0018-folder-discovery-and-republication-dedup.md) | Откриване на папки от индекса + dedup на препубликувани декларации (ControlHash) | Прието |
| [0019](0019-private-interest-vs-ex-officio-classification.md) | Разделяне на частен финансов интерес от служебни борд-роли (multi-declarant tell) | Прието |
| [0020](0020-conflict-explorer-surface-posture.md) | Повърхност на експлорера — само interest_links, noindex до одобрение, произход на всеки ред | Прието |
| [0021](0021-methodology-page-and-temporal-freshness.md) | Публична страница методология/поправки (E10) + времево датиране и изтичане при освобождаване (E11) | Прието |
| [0022](0022-public-surface-private-ownership-only.md) | Публичната повърхност показва само деклариран частен дял (маха служебния списък; „длъжностно лице") | Прието |
| [0023](0023-anonymized-family-ownership-surface.md) | Анонимизирана повърхност за дял на свързано лице: свързаното лице неназовано, материалност = затворена форма, подредба по силата на връзката | Прието |
| [0024](0024-contemporaneous-contract-split.md) | Договори в момент на конфликт: времеви подсбор и списък, изведени при четене (без миграция/ETL) | Прието |
| [0025](0025-xml-parser-supply-chain.md) | Верига на доставки за XML парсера (fast-xml-parser): одит на транзитивното дърво + заключен lockfile | Прието |
| [0026](0026-person-grain-name-institution.md) | Идентичност на лицето: (име, ведомство), не голо име — без сливане на съименници, стабилно за E11 divestment | Прието |
| [0027](0027-overmerge-gate-is-telemetry-not-a-gate.md) | Load-time гейтът за over-merge е телеметрия, не порта (strictKey беше структурна фалшива нула); доказателството е етикетираният тест | Прието |
| [0028](0028-declared-eik-is-a-determining-identifier.md) | Деклариран ЕИК е определящ идентификатор — ниво `A_eik`, освободено от ТР-преброяването (ЕИК-ът е самоличността, не името) | Прието |

Свързан проектен документ: [spec/related-persons-foundation.md](../spec/related-persons-foundation.md).
