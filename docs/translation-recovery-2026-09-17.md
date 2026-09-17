# Failed translation recovery

## Observed production issue

The production ledger at code release `6fcfd9cfcc61dd991f59e489106e639a5b7b69df`
contains 98 reservations. There are 57 failed/partial requests labelled
`MECHANICAL_CHECK_FAILED` and one `NETWORK_ERROR`. The published run reports
68 held fields. The old queue excludes every previously attempted task,
including confirmed rejected translations, indefinitely.

## Change

- Read schema 1 and 2; upgrade to schema 2 when making a new reservation.
  Historical entries are retained without rewriting their receipts.
- Only settled `MECHANICAL_CHECK_FAILED`, `INVALID_JSON`, and
  `INVALID_TRANSLATION_SHAPE` requests with a received usage receipt are
  eligible. The particular field must still be missing and must not have
  succeeded previously. The current original-text fingerprint must match.
- At most three total attempts per field/original fingerprint, including
  earlier attempts. Wait at least 30 minutes after the previous settlement.
- Each retry links to the immediately preceding reservation for that field.
  Persist the new reservation remotely before making a paid request.
- Preserve ambiguous network failures and unfinished reservations as held.
  An account pause remains a pause; no auto-unpause or ledger deletion.
- Record only enumerated mechanical error codes per rejected field. Never
  store model drafts, error bodies, or credentials in the public ledger.
- Ask DeepSeek to preserve Arabic numeral notation. Do not weaken the
  mechanical checks or invent missing English abstracts.

The old 57 mechanical-failure records do not contain the detailed reason;
the new field-level diagnostics apply to subsequent attempts. This change
does not prove that all old failures were caused by numeric formatting.

## Verification

Regression tests exercise partial-field recovery, the 30-minute cooldown,
three-attempt cap, immutable historical receipts, version-1 migration,
remote-reservation protection, ambiguous network failures, exact retry
links, invalid diagnostics, and successful-field deduplication. A read-only
validation of the actual production ledger passed before deployment.

Do not publish while another production writer is active. After deployment,
check actual accepted translations and the public site snapshot, not just
the workflow conclusion. Previously unresolved source/translation warnings
can coexist with a successfully deployed website.
