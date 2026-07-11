# ADR-0007: Scope and certainty bar

- Status: Accepted
- Date: 2026-07-05
- Deciders: lb (Head of AI, ИО), Claude
- Related: spec §1–2, §8

## Context

SIGMA surfaces public-procurement conflicts of interest. A rich but dangerous signal is: public
officials who hold financial interests in companies that win public contracts. Getting this wrong is
not a bug — it is a **public false accusation of corruption** (libel/slander) against a named person.
We must decide how much certainty a claim needs before it is published, and what data is in scope.

## Decision

1. **Public data only.** Sources are the CACBG public declaration register (Сметна палата, чл.75 ЗСП)
   and the ЦАИС ЕОП open contract data we already ingest. No restricted registers (BO register parked
   post-CJEU C-37/20; TR bulk-reuse avoided — per-ЕИК lookup only, later leg).
2. **Certainty bar = 1.0 for publication.** A conflict link is auto-published only when the official↔
   company↔ЕИК resolution is **deterministic**. Anything ambiguous is withheld or routed to a human/
   secondary-confirmation tail — never guessed.
3. **Heuristics are allowed only where methodologically defensible, and only to *withhold* or *triage*,
   never to assert.** A heuristic may downgrade a match to "hold" or flag a "candidate same-region"
   lead, but a *published* claim must rest on deterministic facts. Every heuristic is disclosed on the
   methodology page and labelled in the data.
4. Framed as **declared leads**, not "all conflicts" — a defensible floor with a full provenance chain.

## Consequences

- Recall is deliberately sacrificed for precision: we will miss real conflicts (e.g. name-changed
  companies, ownership via HoldCo) rather than risk one false accusation. Stated up front.
- Every published item carries a provenance receipt (source URL, raw declared strings, matcher version).
- The build is phased behind falsifiable proof-gates (see the implementation plan); the libel-safety
  gate (0 over-merge) is a hard no-go if unmet.
- Third-party personal data (family, declared related persons) is out of scope for publication (ADR-0010).
