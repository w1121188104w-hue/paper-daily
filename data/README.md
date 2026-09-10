# Local Data Directory

Runtime files in this directory are intentionally ignored by git.

Update 2026-09-10: the approved formal journal history and original source
records are now saved in the public repository. The first manual server run
preserved all existing papers and saved five new records. The public read-only
website is now live following explicit launch approval. The user subsequently
authorized daily collection at 08:17 and 13:17 Asia/Shanghai, with a same-day
completion check and automatic website updates; automatic translation stays off.
See `deploy/github/README.md`. Only explicitly stage the validated list
from `scripts/journal-git-files.js`; never add all of `data/`. Credentials, personal settings, old
arXiv reading data, translation drafts and uncommitted attempts stay excluded.
Historical stage descriptions below describe their original scope.

paper-daily stores user-specific runtime data here, including subscriptions,
refresh history, marks, cached AI outputs, generated daily reports, and local
LLM settings. These files may contain API keys, personal research interests, or
private reading history, so they should not be committed to a public repository.

The public, non-secret journal whitelist `config/journals.json` is explicitly
allowed in git for the business-journal migration. Other files under `config/`
remain ignored. Do not place credentials in the whitelist or example files.

Stage 2 only collects and merges in memory. It does not create a permanent
paper archive, overwrite the old arXiv data, or change local LLM settings.

Stage 3 adds an opt-in local archive under `journal-store/`. Only the separate
`scripts/journal-library.js --collect --save` command writes this archive.
It uses immutable yearly/monthly files, version manifests, and a single
`current.json` pointer. Unchanged files may be referenced from older snapshots:
back up the ENTIRE `journal-store/` directory, not just the latest snapshot.
The archive is still ignored by git at this local-development stage; GitHub
persistence/export is not yet connected. It is not a substitute for a backup.
No automatic cleanup deletes old papers or snapshots.

Stage 4 stores a derived `translation-queue.json` in each new snapshot and keeps
translation import logs separate from collection logs. Exported work packages
live under `journal-store/translations/batches/<batch-id>/` and are also local,
git-ignored data. Keep `request.json` unchanged; write a response separately.
Translation imports are previews unless explicitly invoked with `--save`.
No stage-4 command calls an AI API or schedules a translation job.
