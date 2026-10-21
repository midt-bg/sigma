# Оперативни наръчници

Кратки процедури за случаите, в които нещо трябва да се направи сега. Всеки казва кога се ползва, как
се проверява (само четене) и какво се прави. Записите в production са на човека, който пуска
production, с неговия token.

| наръчник | кога |
|---|---|
| [production-cutover.md](production-cutover.md) | пускане с пълно изграждане на празния слот и превключване |
| [release-rollback.md](release-rollback.md) | връщане назад след пускане |
| [refresh-failure.md](refresh-failure.md) | обновяването на поръчките пада или сумите се разминават |
| [registry-stale.md](registry-stale.md) | `registry_feed_stale` — регистърът не напредва |
| [d1-overload.md](d1-overload.md) | сайтът връща 503, D1 е претоварена |
| [secret-rotation.md](secret-rotation.md) | смяна на deploy token, солта за отпечатъците или ключа на дневника |
| [related-persons-suppression.md](related-persons-suppression.md) | сваляне или корекция на връзка след сигнал |

Как е устроен деплоят — [deploy.md](../deploy.md); обновяването и регистърът — [etl.md](../etl.md).
