# Isolated discovery verification allowance

User authorization (2026-09-24): continue testing to acceptance or exhaustion of 100 further calls. Conservatively treat 100 as the total including the initial follow-up six, not 106.

- Separate immutable-scope branch `codex/discovery-test-20260924`; file `data/discovery-test-budget-20260924.json`.
- The existing 3,536-call production ledger remains unchanged; no production monthly cap increase.
- All reservations count against the lifetime 100 limit, including failed, uncertain and free responses. Restart/key/month changes do not replenish the allowance.
- Persist reservation using GitHub contents SHA compare-and-swap BEFORE every provider call. Missing/corrupt existing ledger or failed writes block calls.
- Only `ZHIPU_DISCOVERY_API_KEY`, Pro, six requests maximum per workflow run. No SerpAPI, translation, abstract repair, formal paper writes or publishing.
- Workflow stays manual. Old workflows disabled and six automatic switches false. Repository external Actions restriction continues.

Acceptance: evaluate live publisher-specific leads against available official evidence and saved catalog baseline; distinguish old/current/new issue and online surfaces; reject generic catalog existence as new-article proof; reject wrong journal and known articles; verify that genuine new evidence produces only the corresponding catalog reminder. If coverage is inadequate, record the gap rather than declaring search comprehensive. Live provider success alone is not acceptance.
