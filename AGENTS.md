## Git commits

**Never commit without explicit approval.** Before every commit, in this order:

1. **What changed** — list the files and the substance of each change.
2. **Impact** — what behaviour, workflow, or downstream file it affects; anything a reviewer could not predict from the summary.
3. **Proposed commit message** — the exact message, not a topic.

Then stop and wait. Run `git commit` only after the user approves that report. This covers `--amend` too.

Nothing is exempt: not a one-line fix, not a docs-only change, not "the change the user just watched me make". Never fold an unreviewed change into a later commit. Staging with `git add` is fine; committing is not.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `XH-note/Task-Layout-Engine`, driven by the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles use their default label strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` plus `docs/adr/` at the repo root. See `docs/agents/domain.md`.
