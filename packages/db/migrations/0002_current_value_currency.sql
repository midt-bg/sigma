-- Track the currency of whichever amendment last set contracts.current_value.
-- current_value can be denominated in a DIFFERENT currency than the contract's
-- original signing currency (contracts.currency) when the latest amendment was
-- recorded after ЦАИС ЕОП's 2026 BGN->EUR feed switch. EUR conversions of
-- current_value must use this column, not contracts.currency.
ALTER TABLE contracts ADD COLUMN current_value_currency TEXT;
