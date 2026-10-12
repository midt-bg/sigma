/** `contracts.framework` (scripts/normalize-raw.sql step 5): an order placed under a framework agreement,
 *  and the record of the agreement itself — whose value is the agreement's ceiling, the most its buyers
 *  may order under it, so its amount_eur is NULL and no sum or ranking reads it. */
export const FRAMEWORK_CALLOFF = 1;
export const FRAMEWORK_AGREEMENT = 2;
