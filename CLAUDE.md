# CLAUDE.md

Standing instructions for Claude Code in this project. Read this first every session. Do not skip.

---

## PRODUCTION SAFETY (read before any change)

The portal is LIVE with real paying clients in it: Jason Roth and Kevin Adams (Raised Bar Group), and ZipKit Homes (Sven, Emree). Treat every change as a change to a product people are using right now.

**Never test against production.** No test writes to the prod database or the live portal: no recompose or create POSTs, no admin API mutations (publish, status flips, draft writes), no manual database edits "just to check," no clicking flows that persist. Earlier sessions did exactly this. Stop.

- Work happens **local** (your machine, a throwaway DB; logic checks via `tsx`) or on **staging** (a deployed mirror with its OWN Turso DB on a private URL). Staging does not exist yet, and creating it is Cody's one-time call, not yours: do not stand one up on your own, and never build a second. Until it exists, test locally and behind admin/flag gates. If something genuinely needs staging, flag it to Cody.
- **Production** (codyasmith.com) changes ONLY by merging a PR to main. Never poke it directly.
- **Deploy is not release.** Ship unfinished or risky code to prod whenever, but keep it invisible to clients behind an admin/role gate or a feature flag until it is proven. `if (isAdmin)` is the crude version. Use it.
- Schema only through backward-compatible migrations (expand, migrate, then contract). Never hand-edit prod's schema.
- Know the rollback (DO redeploy the previous deployment) and that prod backups are on (Turso point-in-time recovery).
- Never copy real client data into local or staging. Seed with fakes (the Cody Test client).

Full version lives in memory as `nondestructive-prod-workflow`.

---

## Who I am

I am Cody Smith. I run Cody A Smith LLC. I work across two laptops. I push code and docs to GitHub to stay in sync between machines. I cannot afford drift between laptops, fabricated completion claims, or work that silently goes unpushed.

---

## Start-of-session checklist

Before writing any code or making any changes, complete all six:

0. **Are you operating against the correct project directory?** Every command this session runs must execute against the exact project path I named. If your shell's default cwd between tool calls is a harness default (for example, `C:\WINDOWS\system32` on Windows), that is not itself a failure, but every command must be explicitly scoped to the project path via `cd` or an equivalent. The STOP conditions are: the exact path I named does not exist on disk; the path exists but is a different project than the one I named; or you cannot scope operations to the named path. Do not guess, do not `cd` silently to a sibling, do not search for similarly-named folders, do not pivot, do not auto-clone. Report the state and ask how to proceed.

1. **Where are we?** State the full path of the working directory. If it's not under `C:\Users\codya\projects-clean\`, STOP and flag it. If it's in a Dropbox or OneDrive path, STOP.

2. **Is this a git repo with a remote?** Run `git status`, `git remote -v`, `git branch --show-current`. Report results. If no remote, STOP. I do not work in repos without remotes.

3. **Is it synced?** Run `git fetch && git status`. Tell me if I'm behind, ahead, or clean. If behind, ASK before pulling. I may have work on the other laptop.

4. **What's uncommitted?** Run `git status --short` and `git stash list`. Report everything. If there's uncommitted work from a previous session, ASK whether to commit it, stash it, or investigate before starting anything new.

5. **State the plan.** Before writing code, tell me what you're about to do in 2-3 sentences. Wait for my go-ahead unless the task is trivial and explicit.

Do all six. Do not skip any. Do not assume I know the answers.

---

## End-of-session checklist

Before ending, execute in order. Do not summarize or claim completion until all steps are actually run and verified with tool output.

1. **COMMIT.** Stage and commit everything that belongs in git. Do not silently skip files. If anything is intentionally uncommitted (`.env`, scratch files, etc.), name it explicitly. Commit messages describe what this session accomplished, not "WIP" or "updates".

2. **PUSH.** `git push`. Paste the push output. Do not tell me "pushed" without showing the receipt.

3. **VERIFY REMOTE.** Run `git ls-remote --heads origin` and `git rev-parse HEAD`. Confirm the commit hash on origin matches my local HEAD. If they don't match, the push did not land. STOP and investigate.

4. **CLEAN UP.** Report any files left untracked and not in `.gitignore`. I want to know what was left behind so I can decide next session if it's junk or unfinished work.

5. **LOG TO CLICKUP.** If this session corresponds to a ClickUp task, post a comment via `clickup_create_task_comment`, first person as me ("I verified... I will... my next move..."), and show the returned comment_id. Full task updates (status, scope, descriptions) via `clickup_update_task` are allowed too. If no ClickUp task was in scope, say so explicitly.

6. **HANDOFF NOTE.** In 3-5 sentences, tell me: what we finished, what's still open, what the next session's first action should be. No aspirational claims. No fabricated commit hashes. If you're not sure something shipped, say so.

Run all six. If any step fails, STOP there and report the failure. Do not fake completion.

---

## Voice and formatting (all written output)

- AP style
- Oxford commas
- No em-dashes, no en-dashes, ever
- Contractions are fine
- First-person as me ("I verified," "I will," "my next move")
- No sign-offs in drafts (no "Best," "Thanks," etc.)
- No warm-up preambles, answer first
- Full brand names in client-facing work
- No invented document format systems, no centered title pages, no "Prepared by/for" metadata

---

## Forbidden patterns

- Do not force-push on `main`
- Do not commit `.env` or any secrets
- Do not create files in `C:\Users\codya\projects\` (deprecated path)
- Do not create files in Dropbox or OneDrive paths for code
- Do not invent commit hashes in handoff notes
- Do not claim ClickUp updates without returning the comment_id or task id for the write
- Do not silently skip uncommitted files during end-of-session commit
- Do not proceed past a failed verification step
- Do not make test writes against the production portal or database (no recompose/create POSTs, admin API mutations, publish toggles, or manual DB edits to "check" something). Test locally or on staging.
- Do not expose unfinished or unverified features to clients on prod; gate behind an admin/role check or feature flag until proven

---

## Project-specific notes

This repo is shared. It holds the portal (admin and client surfaces), the personal-site quiz, and the blog. Portal sessions do not touch quiz or blog files.

**Off-limits in portal sessions without explicit approval:**

- `src/components/Quiz.astro`
- The quiz propagation engine
- `_backup/quiz-bg-*/`
- The blog collection
- Anything under `src/lib/` that the quiz also imports from. Surface before writing and get approval.

**Before debugging any auth, redirect, session, or middleware symptom on the portal:** read `docs/BUGFIX-LOG.md`. Several of these have recurred. If your current symptom matches a logged one, start with the fix in the log before guessing.

**When you fix a non-obvious bug**, append an entry to `docs/BUGFIX-LOG.md` in the format described at the bottom of that file. The point of the log is the pattern, not the patch.

**Portal-side hard rules:**

- No schema changes unless the code forces it. Build with the existing tables (contracts, clients, client_contacts, projects, milestones, users, and the rest) first. Propose a schema change only after showing why it's impossible without one.
- No new theming systems or CSS architectures. Extend the existing `portal-accent-*` utility classes, the `--brand-accent` custom property, `src/layouts/Portal.astro`, and `src/styles/portal.css`.
- No inventing systems that duplicate existing ones. No second health-check loader, no parallel admin queue, no client-facing comments or threading or messaging, no Gantt UI, no new task-management surface when the milestones table already exists.
- Captured fields must drive real behavior. A contract field that exists but changes nothing downstream is fake completeness and gets deleted.
- Do not reopen closed slices without evidence of a failing verification step or a concrete mismatch between the handoff's claims and the repo's reality. "It works but I'd refactor it" is not evidence.

**Slice definition of done** (all seven must hold):

1. The captured truth (contract field, intake answer, etc.) actually drives the behavior it should.
2. The client side communicates the change in plain language, or says nothing if there's nothing honest to say.
3. The admin side either surfaces a new queue item, resolves one, or is intentionally untouched.
4. The full phase-1 test suite is green, including the new slice's test.
5. `npx astro build` is green.
6. `HANDOFF_SLICE_18D.md` reflects the new state: commit hash, what shipped, what's still open.
7. Commits are pushed and `git ls-remote` confirms origin matches local HEAD.

**Handoff file:** `HANDOFF_SLICE_18D.md` at the repo root.

**Authoritative vision document:** `PORTAL-VISION-AND-RULES.md` lives in the Claude Project that hosts the controller, not in this repo. The rules above are the CC-operational subset. Controllers read the full vision doc every session.
