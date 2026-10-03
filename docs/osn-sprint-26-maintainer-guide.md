# OSN Sprint 26 — Maintainer Guide (Atlas Workforce System)

Checklist for **Senthil** to get listed and run a spam-free sprint. Sprint: **Sept 20 – Oct 17, 2026**.

## 1. One-time repo setup (required by OSN automated script)

- [x] `CONTRIBUTING.md` at repo root — DONE (this PR/commit).
- [ ] `CODE_OF_CONDUCT.md` at root — DONE in this pack.
- [ ] `SECURITY.md` at root — DONE in this pack.
- [ ] Push to `main` on GitHub.
- [ ] Add GitHub **About → Topics**: `osn-sprint-26`
      `Settings → About (gear) → Topics → add osn-sprint-26 → Save`.
      The OSN script only lists repos with this topic + `CONTRIBUTING.md`.
- [ ] Make repo **public**.

## 2. Labels (required)

Create / confirm in `Issues → Labels`:

- `osn-sprint-26` — color `#0E7490`, desc: `OpenSourceNest Sprint 26 task — claimed via comment, mentor-reviewed`
- `good first issue` (exists by default — reuse)
- optional: `osn-mentor-approved` (mentor passed → ready for maintainer merge)

Apply `osn-sprint-26` **only** to scoped, ready issues (bug fix, UI tweak, docs, test gap). See `README.md → Known gaps` for candidates.

## 3. Prepare 5–10 sprint-ready issues

Use `.github/ISSUE_TEMPLATE/sprint-task.yml` titles like `[Sprint]: <service> — <task>`.
Each issue must have: scope (one service), acceptance criteria, repro/test command, and label `osn-sprint-26` (+ `good first issue` if easy).

## 4. Fill the OSN nomination form

`OSN Sprint 26: Project Nomination (Maintainers)`:

- *Does your repo have CONTRIBUTING.md at root?* → **Yes, it's ready to go.**
- *Does your repo have topic osn-sprint-26?* → **Yes** (after step 1).
- *Maintainer Agreements* → check: you agree to label issues `osn-sprint-26`, let mentors review first, and merge mentor-approved PRs promptly during the 4 weeks.

## 5. During the sprint (your shield workflow)

1. Contributor comments to claim → assign them (one at a time).
2. Contributor opens PR → **mentor reviews first** (style/tests). You don't need to jump in yet.
3. Mentor approves (or adds `osn-mentor-approved`) → you do **final review + merge**.
4. Close / unassign stale claims after ~3–4 days of silence so others can pick them up.
5. Never merge PRs with failing CI, secrets, or no linked assigned issue.

Async-first per README footer: GitHub > meetings.

## 6. After the sprint

- Export merged PRs / mentor notes for contributor records.
- Remove or keep `osn-sprint-26` label as archived; keep `CONTRIBUTING.md`/`CODE_OF_CONDUCT.md`/`SECURITY.md` permanently.

Good luck — clear that backlog!
