# Смяна на секрет

Кога: секрет е изтекъл, изложен е или има плановата му смяна. Всички записи са на човека, който пуска
съответната среда, с нейния token; на production — само той. Тайните никога не влизат в комит, в лог или
в чат.

Кой секрет къде живее (подробно — [deploy.md](../deploy.md), §3 и таблицата с env променливите):

| секрет | къде е източникът | кой го чете |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | GitHub Environment secret на средата | деплоят; копие като секрет на etl worker-а (контейнерът на декларациите) |
| `SUPPRESSION_SALT` + `SUPPRESSION_KEY_VERSION` | Environment secret + Environment variable | копие като секрети на etl worker-а; списъците за спиране и корекции |
| `LOG_IP_KEY` | само секрет на web worker-а | дневникът на заявките (HMAC на IP адреса) |

## Deploy token (`CLOUDFLARE_API_TOKEN`)

1. В Cloudflare създайте нов token с правата от [deploy.md](../deploy.md) („Минимални scope-ове“) за
   акаунта на средата. Старият остава жив до стъпка 4.
2. GitHub → Settings → Environments → `<среда>` → `CLOUDFLARE_API_TOKEN` → Update.
3. Пуснете деплой на средата (staging: `gh workflow run deploy.yml -f environment=staging`; production:
   следващият tag или ръчно стартиране за `production`). Стъпката „ETL Worker secrets for the
   declarations container“ записва новия token и в etl worker-а — без нея контейнерът продължава със
   стария и спира, щом той бъде отнет.
4. Проверка: деплоят е зелен; следващият ход на обновяването завършва (`wrangler workflows instances
   list <refresh поток>`). Чак тогава отнемете стария token в Cloudflare.

Не в ±30 минути около обновяването на средата (production — 00/06/12/18 UTC, Stage — половин час
по-късно) и не докато върви ход на декларациите: ходът носи token-а, с който
е тръгнал.

## Солта за отпечатъците (`SUPPRESSION_SALT`)

Нова сол обезсилва всеки отпечатък в `scripts/cacbg/link-suppressions.jsonl` и
`link-corrections.jsonl`, затова е координирана смяна: преизчисляване на всеки запис, нова
`key_version` и смяна на двете настройки на средата в едно и също пускане. Процедурата е в
[related-persons-suppression.md](related-persons-suppression.md) („Rotating the salt“). Половин смяна
спира изграждането шумно, вместо тихо да върне свалена връзка — не я заобикаляйте с изпразване на
списъка. Ако списъците са празни, смяната е само двете настройки и деплой.

## Ключът на дневника (`LOG_IP_KEY`)

Деплоят създава ключа само ако го няма и никога не го презаписва, за да остават хешираните IP адреси
съпоставими във времето. Смяната е ръчна:

```bash
openssl rand -hex 32 | pnpm --filter @sigma/web exec wrangler secret put LOG_IP_KEY --name <web worker>
```

Последица: записите преди и след смяната не могат да се съпоставят по клиент. Нищо друго не зависи от
ключа. Проверка: `wrangler secret list --name <web worker>` показва `LOG_IP_KEY`; новите редове в
дневника на заявките носят `ipHash`, различен от този преди смяната.
