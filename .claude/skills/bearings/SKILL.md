---
name: bearings
description: Crew status digest for ForkOver. Shows what is in flight, what's ready for the captain's review, what's waiting on the captain, and what's queued, reconciled against GitHub. Use when the captain asks for status or bearings, at the start of a first-mate session, or before recommending what to do next.
---

# Bearings

1. Run `node .claude/crew/bearings.mjs` from the main checkout. It fetches first; pass `--no-fetch`
   if you fetched moments ago.
2. Reconcile what it reports before you summarize. Follow `.claude/firstmate.md` (Session start,
   Landing, and Resume):
   - A record that disagrees with GitHub (PR merged or closed): update the record.
   - `running` tasks from an earlier session: mark them `stalled`.
   - A worktree with no task record, or an open PR missing from the ledger: work out what it is from
     its branch and commits. Add a record, or ask the captain if it's unclear.
   - A main copy behind `origin/master`: fast-forward it if it's clean and on `master`.
3. Reply to the captain in four short parts, leaving out any part that's empty:
   - **Ready for you**: PRs waiting on review or a merge call, each with its full URL and a
     one-line outcome.
   - **Needs your call**: open decisions and captain-only prerequisites, each with a
     recommendation.
   - **Under way**: running work and what it's doing.
   - **Next**: the queued item you'd start next, and why.

Talk in outcomes. Don't paste the script output or mention ledgers, worktrees, or agent ids unless
the captain asks.
