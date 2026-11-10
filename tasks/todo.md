# Crafting Constellations — web app (Firebase)

## Hermes dashboard bugs (2026-11-10)

The Hermes OS dashboard's scan of main (its mirror at 1facbbd, the round-4 merge) listed 7 open bugs: 4 major, 3 minor. All 7 fixed, each with a test that fails without it.

- [x] Major: a save that asked Auth before a deletion finished could commit after it and bring back the profile and pen name. `deleteAccount` now marks `accountDeletions/{uid}` before the purge; `saveProfile`'s transaction reads it, and the rules' `canWrite()` refuses every write from a leaving account. The mark expires after a day (housekeeping removes it). The old "purge again if a profile came back" step is gone: nothing can make one now.
- [x] Major: Reset profile could give a generated name it never checked, overwriting someone else's claim. Every candidate is now read before it's given (`firstFree`); with none free it throws `resource-exhausted` and changes nothing. Generated names are also checked against what names pass for.
- [x] Major: lookalike pen names could be had by claiming the plain spelling second ("O'Neil" after "OʼNeil"). New `penNameShapes/{shape}` index, kept on save, rename, Reset profile (retired in every spelling) and account deletion; `penNames` keys unchanged. `scripts/backfill-pen-name-shapes.ts` fills it in for older names (retired first, then the earliest profile; clashes are listed, nobody loses a name).
- [x] Major: a Reset profile that failed after its decision never put the new name on the person's writing. The decision now commits with its audit row and a `writingRefresh` record on the queue entry; Remove pressed again finishes it, and so does a catch-up every 10 minutes (`finishResets` on Cloud Functions, the local backend's housekeeping). Only writing from before the reset changes.
- [x] Minor: counter triggers double-counted replayed events. Each event writes a `counterEvents` marker in the same batch as its increment (removed by housekeeping after 7 days).
- [x] Minor: a chat's Leave refusal showed on the next chat opened from the rail. The refusal now carries its chat id.
- [x] Minor: a paint worker that failed to load, threw or went silent left its jobs pending forever. Its jobs are now painted on the main thread, the worker is retired, and a failed blot is evicted from the cache.
- Left as they are: Chat's Leave still drops focus (the page swaps to "Leaving the chat…" and back; matching Group needs the header kept through both); `Blot.tsx`/`useBlotUrls.ts` don't catch a blot that fails on the main thread (effectively unreachable).
- Found while testing: `refreshWriting` and the purge's `deleteAll` left a failed bulk update as an unhandled rejection while `close()` flushed, which can end the local backend's process. Both now go through `closeAll` (every operation handled from the start). `banUser`'s bulk writes still don't watch their results; left as it is.
- Checks: unit 1902 → 1924; rules 79 → 81; functions e2e 41 → 42; local-backend e2e 67 → 90; `tsc -b`, functions build and `vite build` clean, with no regex lookbehind in the site. Run on spare emulator ports. Two parallel runs clash: the Functions emulator also takes Cloud Tasks' default port, 9499.
- Deploying showed Firestore TTL policies need billing (403 "billing disabled" on `fields/expireAt`), so they're out of `firestore.indexes.json`. Expired `accountDeletions` and `counterEvents` are removed by `removeExpired`: the local backend's 10-minute housekeeping, and a `housekeeping` scheduled function on Cloud Functions, which also took over `finishResets`.
- For the PR: deploy rules + indexes, then site, then backend/functions. Then `npm run backfill-pen-name-shapes -- --prod --project <id> --dry-run`, check the clashes it lists, and run it again without `--dry-run`.

## Bug sweep, looped until dry (2026-10-10)

Baseline: typecheck, functions build, unit 133, rules 48, deleteAccount e2e 5, local-backend e2e 11 (emulators on ports +20000, beside the main checkout's suite).

- [ ] Each round: parallel finders by area and by cross-cutting lens → dedupe against everything already judged → 2 skeptics per finding (tiebreaker on a split) → fix confirmed bugs in disjoint file groups, with tests → adversarial review of each fix → all suites
- [ ] Stop when a full round confirms nothing new

### Round 1 (synced with main at 76900df first)

- 15 finders: 133 raw findings → 85 unique → 79 confirmed, 6 refuted.
- Refuted, and left as they are:
  - a block doesn't reach into group chats a mutual friend makes (blocks are one-to-one by design);
  - chat names use the pen-name rules (documented in ae096f1);
  - the client's call timer starts after the write lands (the TTL still does its job);
  - the wide-screen person sheet floats over the chart (deliberate);
  - the chart briefly renders before memberships arrive (no visible harm);
  - a banned person's token can read private notes until it expires (bans stop writing; reads stay one-to-one).
- Fixed in 45 groups with file locks; each fix got an adversarial review (and up to two repairs) before it counted.
  - All 79 confirmed bugs fixed, plus 19 follow-ups (F1–F19) that reviewers verified while reviewing; one was a regression (Report's confirmation stopped being announced in talk).
  - After the last review, a narrower clause split still lost five disguised crisis lines the original code caught; the reviewer's tested fix keeps the old clause lines and adds the tighter split on top (with a regression test).
  - Checks: unit 133 → 826; rules 48 → 69; functions e2e 5 → 22; local-backend e2e 11 → 34; `tsc -b`, functions build and `vite build` clean.
  - For the PR: existing pen names that the tighter reserved-word and lookalike checks now refuse (e.g. "nurse2joy") must be renamed at the next profile save; the form says why.
  - Interruptions: the session dropped several times. Workflow resume only replays an unbroken prefix of finished calls, so each restart rebuilt every group's state from the agent journals and relaunched with explicit starting points (review, repair or finish).
  - Found while fixing: `npm run build` (`tsc -b`) broke once tests under `src/` imported components. They now have their own `tsconfig.test.json` (DOM + Node + Vite types), and `src/lib/blocks.ts` no longer pulls browser code into the Node project.
  - Left as they are: an unreachable "withdraw refused" alert in `Item.tsx` (the item unmounts first; harmless), and the per-pair block race (the first to block owns the pair; a limit of the existing design, and victims are still better off).
- Decisions made:
  - a revoked professional may apply again;
  - the profile note's hint now says everyone signed in can see it (no data move);
  - removing a moderator revokes their sign-in, with no new rules lookup (the delay that remains is documented);
  - Performance Monitoring's addresses are described truthfully.

### Round 2 (after merging main's daily check-in, e1fd46a)

- 17 finders (round 1's areas, main's check-in, and one reading round 1's whole diff for regressions), told everything already judged: 94 raw findings → 57 unique → 51 confirmed, 6 refuted.
- About a quarter are main's new daily check-in (a refused listener on the auto-join, leaving undone at once, answers going to a group nobody is told about, the prompt collapsing conversation pages); the rest are follow-ons to round 1's fixes and smaller things round 1 didn't reach.
- Refuted, and left as they are:
  - the check-in group exists only where the seed makes it (a documented manual step for the live project);
  - "Not now" on the check-in lasts for the visit (designed that way);
  - naming a crisis line counts as crisis language (the documented policy);
  - a spaced "Md" in a pen name reads as a title;
  - catch-up after a restart judges one note per person slightly out of order (not worth the complexity);
  - an unrefreshable token at page open (the SDK keeps the user; no visible harm).
- Fixed in 18 groups, the same way as round 1; all 18 approved, a few with parts left in files the group didn't own.
  - Reviewers' leftovers became follow-ups G1–G11, three of them required:
    - `moderate.ts` must read contact details from the new `digits` view (9 tests red until then);
    - the rules must accept a reapplication's document folder;
    - the site must know the new "paused" approval outcome.
  - Also decided: names that start with dotted initials ("D.R. Patel") are ordinary names; a trailing credential or a "Dr" title is still refused.
- Decisions made:
  - leaving Daily check-in lasts until the next visit;
  - the check-in form says who reads the answers;
  - the prompt stays off pages that fill the shell, or stays out of their way.

### Round 3

- 17 finders (part of the run was cut off by a spend limit and resumed): 56 raw → 51 unique → 44 confirmed, 7 refuted.
- Two are high:
  - this sweep's own moderation fixes added regex lookbehinds to code that ships in the site, so the whole site fails to parse on Safari 15.4–16.3;
  - the flood hold treated ordinary conversations (more than 8 lines in 10 minutes) as spam.
- The rest are mostly focus and announcement polish, edge cases in moderator decisions, and follow-ons to round 2.
- Fixed in 16 groups, then follow-ups H1–H6 and K2–K3 from the reviews:
  - a flood rule that held caregivers' updates and thank-yous;
  - e2e tests the fixes had broken;
  - "Withdrawn" announced;
  - crisis resources for a crisis chat name;
  - re-fetching page chunks after a rollback;
  - two regex leftovers.
- Decided: T10 (stop treating plain fear of dying as crisis language) is dropped. Five reviews in a row found real crisis lines its exemptions let through. Holding an ordinary line, with resources shown, is the safer failure, so those lines are held as before.
- The project folder moved to `~/Desktop/code/Hyphen_hacks` mid-round; the worktree was repaired in place (`git worktree repair`) with nothing lost.

### Round 4 (the last: stopped here by request, on main after PR #9)

- Finders over every area plus round 3's diff: 41 raw → 32 unique → 26 confirmed, 6 refuted. Four of them needed a second verification pass after an interruption.
- Two are high, both crisis lines that went out with no resources:
  - a text-style emoji didn't end a clause;
  - a texting shorthand with its digit glued on read as a distance.
- The rest:
  - incomplete fixes from earlier rounds: lookalike-letter pen names (role words, and exact copies of another member's name), sign-out after deletion, focus and announcements on Join/Leave, Review and the Friends welcome;
  - moderators' uids on documents the people they acted on can read;
  - layout on phones: the send bar, the consent slip, iPhone zoom on small inputs, a long word in the person sheet.
- Refuted, and left as they are:
  - a reported moderator can still read who reported them, through the rules;
  - a report filed just before a decision is dropped;
  - a held comment's pings are lost while its post is hidden;
  - modifier letters count as letters in a pen name;
  - the 'accepted' notice after a block;
  - check-ins count for the day the server got them.
- Fixed in 13 groups, all approved after adversarial review. Then the lead made these follow-ups, each with a test that fails without it, then reviewed independently:
  - U28: disabled link buttons now dim;
  - U30: the Verify copy says group writing needs a confirmed email too;
  - U1's server half: a revoke pressed again now finishes the claim and past-writing clean-up an earlier failure left undone;
  - U21's deletion half: DeleteAccount leaves the page before signing out;
  - Group: what Join or Leave came to is said only in the group open when its answer lands, whatever order the answers come in;
  - two lookalike letters in the role-word check;
  - the crisis treatment exemption tightened to the reviewer's word list, so it only ever adds holds;
  - the two new e2e files are now in `test:local-backend`;
  - README notes on moderators' own cases and the one-off `clear-moderator-ids` script.
- Checks: unit 1681 → 1902; rules 79; functions e2e 38 → 41; local-backend e2e 56 → 67; `tsc -b`, functions build, `vite build` clean, with no regex lookbehinds in the site.
- Left as they are, open for a later round:
  - a pen name in lookalike letters can still be copied in Latin. The reverse direction needs a shape index and a backfill, which "keys stay stable" ruled out.
  - the private-thread send bar at 375×667 is mostly clear of the consent slip, but its lower edge sits under it. The landscape case is unchanged (U26 partial). There isn't room for everything at that size.
  - the local backend: a claim commit that lands followed by every retry failing still leaves the site waiting 5 minutes (as before).
  - Chat's "Leave chat" drops focus, and a refusal there isn't tied to the chat (the Group fix's sibling).
- For the PR: after deploying, run `npm run clear-moderator-ids -- --prod --project <id> --dry-run` once, then again without `--dry-run`. It takes moderators' uids off older documents. Deploy order as before: rules, then site, then backend.

## Notifications, @mentions, seamless paper, draggable chart (2026-10-10)

Plan: `/Users/darren/.claude/plans/i-want-you-to-quiet-stardust.md`

- [x] 0. Synced with main (7099d22: private group chats)
- [x] 1. Paper grain tiles without seams (filter region pinned to the tile). Mottle tile edge step: 32× the inside step before, ordinary noise after (81st–90th percentile of its own rows/columns)
- [x] 2. Notifications + @mentions
  - [x] shared `mentions.ts` (+ tests)
  - [x] server: `notify.ts` in `handleNewContent` and `approveContent`; accepted notices (function + local backend); purge; rules; index
  - [x] client: Composer autocomplete, `MentionText`, Notifications page, rail link, Me cleanup; seed gives `SEED_ME_UID` a mention
  - [x] tests: unit 115, rules 48, local-backend e2e 10, deleteAccount e2e 5
  - [x] browser (own emulators on other ports, two people): @ list by keyboard and pointer, highlight from the server, comment / mention / accepted notices, opening one marks it read, Mark all read, withdrawn → "No longer here", 375px no sideways scroll
  - Found while checking: reading a withdrawn item's document (or a query pinned to its id) is refused, and the refused listen broke the Firestore client. Excerpts now ask for "published at this time" (`contentAt`).
- [x] 3. Draggable Friends chart (spring physics, your dot fixed)
  - `egoPhysics.ts`: line springs at their drawn length, a push between dots (capped up close), you pinned; settled before the first paint; a dropped dot keeps its new angle, not its old place (no pull home, like Obsidian)
  - browser at 393px: a real mouse drag lands under the pointer, neighbours follow, release drifts to rest (~6s at most), the drag doesn't open the sheet, a click still does, your dot can't move; labels kept inside the edges
  - Found while checking: a quick drag can end before the next frame, so the held dot is placed on each move, not only per frame
- [x] 4. Verify: typecheck, functions build, unit 124, rules 48, local-backend e2e 10, deleteAccount e2e 5, build; browser as above. Run on separate emulator ports beside the main checkout's suite.

### Review

- **Delivered:** seamless paper; Notifications page (requests, mentions, comments on your posts, accepted requests, moderator notes) with an unread count in the rail; @mentions in group talk, posts, comments and private group chats; draggable Friends chart.
- **Decisions:** pings are checked and written by functions when writing is published (held writing pings nobody until approved); notices hold no copy of the words; moderator notes moved from You to Notifications; DMs have no @ (both people already see every line); the chart has no pull back home, so a dropped dot keeps its new angle.
- **Fixed before the PR (user: "fix the bugs"):**
  - the local backend now announces acceptances from the last 3 days on start (`acceptedWhileAway`; the notice id makes each one once only), e2e covered;
  - automod read a word-initial `@` as "a", so "love you @Loser" slipped past where "love you Loser" is held. A fourth view drops that `@` (`unmarked`); "@ss"-style leet is still read by the old view. Probed: no real pen name is newly held by it;
  - merged main with `fill-app-panes` (PR #5, full-height panes): no conflicts; the @ list opens inside the pane, on top of the chat, unclipped (checked in the browser).
- Verified after: unit 133, rules 48, local-backend e2e 11, deleteAccount e2e 5, typecheck, both builds.
- [x] NUC bundle `crafting-constellations-backend.tgz` (gitignored, same layout as before: `functions/` source + `.env.local` + the moderator list, built on the NUC). New since the last bundle: notifications, mentions, and private chats (#4). Checked from a clean unpack: `npm ci` + build, then run as its own process on the emulators: a mentioned comment published with `mentioned`, a mention notice and a comment notice.
- [ ] User: deploy rules + indexes, then hosting, then the NUC bundle (PR #6 says why).

## Reach out, Accept, and private group chats (2026-10-10)

Plan: `/Users/darren/.claude/plans/this-site-is-looking-giggly-robin.md`

- [x] Accept: unverified recipients see "Confirm your email to accept" instead of a silent grey button; a confirmation made in another tab is picked up on focus
- [x] Reach out: removed the symmetric "friend's friend" lockout (both people were told the other would connect first)
- [x] Constellation waits for connections before offering Reach out; leftover debug beacons removed
- [x] Private group chats: `createChat` callable (accepted connections only, up to 20), `chats/{id}/messages` rules, moderation, reports, review queue, ban cleanup
- [x] New chat page, chat page with Leave, chats listed under Group Chats in the rail; group Talk extracted and shared
- [x] After merging Go live: `createChat` uses `callable()` (App Check flag); account deletion takes the person off their chats (e2e covered)

### Verification

- [x] `npm test`: 65 passed; `npm run build` and functions build pass
- [x] Rules: 39 passed (new: unverified recipient can't accept; chats read/list, client create, member writes, leave-only-yourself, reportable)
- [x] Browser against an isolated emulator suite:
  - friend's friend reach out → accept
  - unverified Accept hint → verify → Accept appears on focus → accepted
  - create chat → publish → member reads → non-member refused → leave
  - crisis note in a chat is delivered with resources and queued at priority 2
  - 375px: no horizontal scroll

### Review

- **Found in testing:** one Firestore SDK internal assertion (ID ca9: a watch target's pending count went below zero). It appeared once during a sign-in-and-leave sequence. It didn't come back in 30 targeted retries of leave and sign-in/out, so no code was changed for it.
- **Follow-ups:** add people to an existing chat; rename a chat.

---

## Go live: real project, craftingconstellations.com, App Check, Analytics/Perf, account deletion

Plan: `/Users/darren/.claude/plans/can-you-add-full-eager-metcalfe.md`

- [x] 1. Functions foundation: `options.ts` (global options that actually apply), `callable()` with the App Check flag
- [x] 2. Account deletion (server): `accountPolicy` + tests, `account.ts` purge, `likes.uid` index, hardening
- [x] 3. App Check in the client, typed env
- [x] 4. Analytics + Performance, opt-in; Analytics gets route patterns only (Performance sends real addresses, corrected in the 2026-10 bug sweep)
- [x] 5. Account deletion (client): `/delete-account`, links from Me and Onboarding
- [x] 6. Go-live config (prod alias + web.app CORS origin wait for the project id): env files, CORS, hosting cache headers, deploy scripts, env check; remove `CNAME`
- [x] 7. Docs: README, lessons
- [x] 8. Verify: typecheck, unit, rules, e2e (deleteAccount), build, emulator browser pass
- [ ] 9. With the user: console setup, keys, deploy (Spark now; Blaze later)
  - [x] Project `crafting-constellations-bf029`; web config in `.env.local`; `prod` alias; moderator list
  - [x] Firestore `(default)` in nam5; rules + indexes deployed
  - [x] Hosting live at https://crafting-constellations-bf029.web.app. Checked: headers, deep links, no Analytics before consent, route patterns only after (Analytics; Performance sends real addresses).
  - [x] App Check dropped (user's call): site key cleared; code stays, gated off
  - [ ] User: custom domain craftingconstellations.com (Hosting → Add custom domain; Namecheap DNS)
  - [ ] User: upgrade to Blaze, set a budget alert, then Storage → Get started (US-CENTRAL1)
  - [ ] Then: `npm run deploy:storage`, CORS (`gcloud storage buckets update …`), `npm run deploy:functions`, claim admin
  - [ ] Roger: turn off GitHub Pages
  - [ ] Billing blocked: Google closed all three billing accounts ("not in good standing"). User asked support / a teammate.

## Local backend on the NUC (while Cloud Functions are unavailable)

User's choices: a request queue in Firestore (no inbound ports or tunnel); runs on the Intel NUC.

- [x] Rules: `calls/{id}`. The owner creates `{uid, name, data, authTime, state:'new', createdAt}`, with `authTime` == token `auth_time` and `name` on an allow-list; the owner may get and delete. Rules tests.
- [x] Indexes: collection-group `status` on posts / comments / messages (the worker's pending listeners)
- [x] Functions: export the report and friendship handlers; purge skips Storage when no bucket is configured
- [x] `functions/src/local-backend.ts`:
  - answer `calls` by running each callable's own `run()`, with the token rebuilt from Auth (claims, email, verified) plus the rules-checked `authTime`;
  - listeners for pending content, reports, connections→friendships, and counters (recount with `update`, so restarts are safe);
  - clean up stale calls.
- [x] Client: `VITE_LOCAL_BACKEND=true` → `callables.ts` writes a call and waits for the answer, with a timeout. Professional uploads are paused with a note.
- [x] e2e on the emulators (auth + firestore, no functions emulator): pen name via the queue; error details come through; pending post → published; counters
- [x] README: NUC setup (Node 22, key file, env, systemd)
- [x] Deploy: rules + indexes + hosting with the flag
- [x] User: copy `crafting-constellations-backend.tgz` to the NUC, add the service-account key, start the backend (user reports it running)
- [x] Live database was empty: created the starter set (3 constellations, 8 groups, the seed's names without sample people) in one atomic commit with `exists:false` preconditions, using the CLI owner login
- [ ] User: sign up on the live site and choose a pen name. Then check `calls`, `users` and `penNames` from here.
- [ ] Follow-up: there is no admin screen for creating constellations or groups (the `createGroup` callable exists but has no UI)
- [x] Live test: a pen name saved through the NUC (1 profile, matching pen name, no leftover calls)
- [x] Merged main (91616de: landing story, a confirmed email to write, flood hold with `rateLimits`):
  - conflicts resolved: App Check uses Roger's reCAPTCHA v3 provider with my init order and env hygiene; Roger's landing plus the "account removed" line, repositioned for his fixed buttons;
  - `rateLimits/{uid}` is now purged on account deletion;
  - after the merge: unit tests 80, rules 36, deleteAccount e2e 5, local-backend e2e 6, both builds; landing checked at 297px and 1280px.
- Verified:
  - rules tests 34 (3 new for `calls`);
  - local-backend e2e 6 (pen name, error details, admin refusal + bootstrapAdmin, deleteAccount with the rules-checked sign-in time, expired calls never run, moderation + counters);
  - deleteAccount e2e 5, unit tests 76;
  - browser in local-backend mode: a taken pen name shows the right error, then a free one saves (backend ~30ms per call); Professional shows the paused note;
  - the bundle builds from a clean extract.
- Found: the CLI turns list params into JSON for functions; the backend now does the same for `ADMIN_EMAILS` from `.env` files.

### Verification (2026-10-10)

- [x] `npm run typecheck`, `npm run functions:build`; every function's endpoint now has region `us-central1` and `maxInstances: 10`. The old build had neither: global options were silently ignored.
- [x] `npm test`: 76 passed (incl. 10 `accountPolicy`, 4 `routePattern`)
- [x] Rules tests: 31 passed. e2e (`deleteAccount`): 5 passed. Both ran on alternate emulator ports, beside an emulator suite already running on the defaults.
  - Covered: unauthenticated, wrong confirmation, moderator, a full purge (every row checked, friend's data intact, counters drop, audit row), and the "delete" word with no profile.
- [x] `npm run build`: `telemetry-*.js` is its own chunk, never preloaded. A canary debug token and another `VITE_` secret in `.env.production.local` do not appear in `dist/`.
- [x] Browser against the emulators:
  - no Google, Analytics or Performance requests; no consent slip; no visit checkbox on You;
  - sign up → onboarding (shows the "Delete this sign-in" link) → You → Delete my account;
  - the button stays disabled until the pen name matches; a wrong password shows a plain error;
  - the right password deletes the account, lands on the front page with "Your account and your writing have been removed.", and the auth user, pen name and audit row are as expected.
- [x] Consent slip (markup injected for a look): 16px gutters on narrow screens, a 380px slip bottom-left on desktop, no horizontal scroll.

### Review

- **Found while building:**
  - global function options were never applied;
  - `.env.local` never applied under `npm run dev`;
  - `import.meta.env` aliasing would have shipped every `VITE_` value;
  - `auth/wrong-password` / `auth/user-not-found` fell through to "Something went wrong";
  - a filed report left the leaver's uid in the queue aggregate (now scrubbed).
- **Not done:**
  - rate limiting;
  - a sweeper for stuck `pending` items;
  - an `auth.user().onDelete` trigger, or an admin purge script (the seed's `deleteUser` would race a trigger, so `updateUser` it first);
  - App Check enforcement (after metrics).

---

Plan: `/Users/darren/.claude/plans/pasted-content-id-5983-the-value-lively-dahl.md`

- [x] 1. Scaffold: Vite + React + TS, functions package, firebase.json / .firebaserc / emulators, styles, wash renderer ported to TS (worker)
- [x] 2. Moderation module + Vitest suite
- [x] 3. Firestore + Storage rules + rules tests
- [x] 4. Auth, `saveProfile`, onboarding, guards
- [x] 5. Content triggers, counters, live listeners → group talk, posts, comments, likes
- [x] 6. Seed script → Constellation chart + list view
- [x] 7. Connections + private notes (crisis path delivers with resources for both)
- [x] 8. Reports, review queue, admin callables, bootstrap / grant-admin
- [x] 9. Professional applications, licensed mark, ban flow
- [x] 10. README, PRODUCT.md update, review

## Verification

- [x] `npm test`: 55 tests (moderation incl. false-positive traps and evasions, constellation layout, pair ids)
- [x] `npm run test:rules`: 31 tests (forged status/author/badge, pending visibility, non-members, double likes, verification gates, DMs, bans, applications, friendships, Storage owner/type/size/write-once)
- [x] `npm run build`: passes; vendor chunks split, Review page lazy-loaded
- [x] End-to-end in the browser against emulators:
  - sign up, pen-name validation, onboarding
  - join, leave, rejoin a group
  - talk message goes "checking…" then published
  - crisis post held with resources; like; comment; report
  - email confirmation; accept a connection; private note
  - crisis private note delivered with resources on both sides
  - Review queue: crisis item first; remove spam; keep a reported comment
  - open a licence document via the rules; approve a licence
  - ban: account disabled, memberships removed, audit log written
  - professional application with upload
- [x] 375px: no horizontal scroll on any main page
- [x] Console clean in normal use

## Review

- **Found in testing:**
  - The seed's report was correctly dropped, because the reporter couldn't see the group.
  - Wiping the emulator re-fired counter triggers, which resurrected deleted posts. Counters now use `update`, never `set`.
  - Joining a group raced the server, so member-only listeners opened before the membership was confirmed and the SDK asserted. Listeners now wait for the server.
  - Curly apostrophes slipped past the crisis phrases. They are now normalised.
- **Spec gap closed:** "see who is friends with who" needed public friendships. Accepted connections are mirrored to `friendships/` by a function; requests and blocks stay private.
- **Known dev-only issue:** reseeding while the app is open can break the Firestore client until reload (documented in README).
- **Not done:**
  - deploy to a real project (needs the user's Firebase project);
  - rate limiting, App Check, account deletion, a sweeper for stuck `pending` items.

---

## Earlier: Value Study sample boards (done)
Four boards + index in `samples/`. Sampled tokens, granulating wash renderer (worker), contrast / mobile / focus / reduced-motion verified.
