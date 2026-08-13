-- #306: provenance for value-anchor-linked annexes. The resolver in
-- scripts/resolve-amendment-contracts.sql rewrites a namespace-mismatched annex's contract_number to its
-- target contract; unlike the #286 OCDS bridge (whose OCID survives in tender_ext_id + source), the annex
-- number would otherwise be destroyed with no trace, making the 99.99%-precision claim unauditable in
-- production and any "this annex isn't ours" complaint uninvestigable (review nikimilenkov MEDIUM 4).
-- Keep the original annex-side number and stamp the link method so value-linked rows stay enumerable on the
-- served side. NULL on both columns = the row linked by contract_number directly (or is unlinked).
ALTER TABLE amendments ADD COLUMN contract_number_raw TEXT;
ALTER TABLE amendments ADD COLUMN link_method TEXT;
