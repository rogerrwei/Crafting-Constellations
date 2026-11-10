/*
 * deleteAccount end to end: the real function and triggers on the emulators.
 * Also a moderator's Reset profile, whose retired name has to outlast the account.
 * A tab left open is played by the handlers themselves, run in this process as the
 * local backend runs them (built JS: npm run functions:build).
 * Run with `npm run test:e2e` (stop `npm run emulators` first).
 *
 * Every test seeds its own people, group and thread under fresh ids instead of
 * wiping the emulator: a wipe fires the delete triggers of the previous run late,
 * and those would move this run's counters.
 */
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp } from 'firebase-admin/app'
import { getAuth as getAdminAuth } from 'firebase-admin/auth'
import { getFirestore as getAdminFirestore, type Firestore } from 'firebase-admin/firestore'
import { getStorage as getAdminStorage } from 'firebase-admin/storage'
import { deleteApp, FirebaseError, initializeApp } from 'firebase/app'
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword, signOut } from 'firebase/auth'
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const PROJECT_ID = 'demo-crafting-constellations'
const BUCKET = `${PROJECT_ID}.appspot.com`
const PASSWORD = 'e2e-password-only-for-emulator'

const admin = initializeAdminApp({ projectId: PROJECT_ID, storageBucket: BUCKET }, 'e2e-admin')
const db = getAdminFirestore(admin)
const adminAuth = getAdminAuth(admin)
const bucket = getAdminStorage(admin).bucket()

const client = initializeApp({ apiKey: 'demo-key', projectId: PROJECT_ID, authDomain: `${PROJECT_ID}.firebaseapp.com` }, 'e2e-client')
const auth = getAuth(client)
const functions = getFunctions(client, 'us-central1')
const deleteAccount = httpsCallable<{ confirm?: string }, { ok: true }>(functions, 'deleteAccount')
const saveProfile = httpsCallable<{ penName?: string }, { ok: true }>(functions, 'saveProfile')
const removeContent = httpsCallable<{ queueId: string }, { ok: true }>(functions, 'removeContent')
const approveContent = httpsCallable<{ queueId: string }, { ok: true }>(functions, 'approveContent')
const banUser = httpsCallable<{ uid: string; reason: string }, { ok: true }>(functions, 'banUser')
const unbanUser = httpsCallable<{ uid: string }, { ok: true }>(functions, 'unbanUser')

// The handlers, in this process. Through the emulator a stale tab can't be played: its token
// check asks Auth whether the account is still there, which Cloud Functions' doesn't
interface Handler {
  run: (request: unknown) => Promise<unknown>
}
let handlers: { db: Firestore; saveProfile: Handler; deleteAccount: Handler }

// A request from the leaver's tab, signed in just now (deleting needs a recent sign-in)
const fromTab = (uid: string, data: Record<string, unknown>) => ({
  data,
  auth: { uid, token: { uid, email_verified: true, auth_time: Math.floor(Date.now() / 1000) }, rawToken: '' },
  acceptsStreaming: false,
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Triggers run asynchronously; poll until the condition holds
const eventually = async (check: () => Promise<boolean>, what: string) => {
  for (let i = 0; i < 60; i++) {
    if (await check()) return
    await sleep(500)
  }
  throw new Error(`Timed out waiting for ${what}`)
}

const exists = async (path: string) => (await db.doc(path).get()).exists
const field = async (path: string, name: string) => (await db.doc(path).get()).get(name)
const queueId = (path: string) => path.replaceAll('/', '~')
const queueDoc = (path: string) => `modQueue/${queueId(path)}`

// Ports come from emulators:exec (env and the hub), so this also runs beside another emulator set
const connectClient = async () => {
  const listing = (await (await fetch(`http://${process.env.FIREBASE_EMULATOR_HUB}/emulators`)).json()) as Record<string, { host: string; port: number }>
  connectAuthEmulator(auth, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, { disableWarnings: true })
  connectFunctionsEmulator(functions, listing.functions.host, listing.functions.port)
}

const person = async (uid: string, penName: string, claims?: Record<string, unknown>) => {
  await adminAuth.createUser({ uid, email: `${uid}@example.test`, emailVerified: true, password: PASSWORD })
  if (claims) await adminAuth.setCustomUserClaims(uid, claims)
  const lower = penName.toLowerCase()
  await db.doc(`penNames/${lower}`).set({ uid })
  await db.doc(`users/${uid}`).set({ penName, penNameLower: lower, note: '', avatarSeed: uid, pigment: 'graphite', pro: false, banned: false })
}

const published = (authorUid: string, extra: Record<string, unknown>) => ({ authorUid, status: 'published', createdAt: new Date(), ...extra })

let runs = 0

const seed = async () => {
  const n = ++runs
  const leaver = `leaver-${n}`
  const friend = `friend-${n}`
  const mod = `mod-${n}`
  const pair = [friend, leaver].sort().join('_')
  const g = `groups/g-${n}`
  const w = { n, leaver, friend, mod, pair, g, leaverName: `Leaving Lark ${n}`, friendName: `Staying Finch ${n}`, modName: `Night Keeper ${n}` }

  await person(leaver, w.leaverName)
  await person(friend, w.friendName)
  await person(mod, w.modName, { admin: true })

  await db.doc(`users/${leaver}/private/settings`).set({ crisisRegion: 'UK' })
  await db.doc(`users/${leaver}/notices/n1`).set({ type: 'held', seen: false, createdAt: new Date() })

  await db.doc(g).set({ name: 'Evening sheet', memberCount: 0 })
  await db.doc(`${g}/members/${leaver}`).set({ uid: leaver, joinedAt: new Date() })
  await db.doc(`${g}/members/${friend}`).set({ uid: friend, joinedAt: new Date() })

  // The leaver's post, with a friend's reply and like under it
  await db.doc(`${g}/posts/lp`).set(published(leaver, { body: 'Long week.', likeCount: 0, commentCount: 0 }))
  await db.doc(`${g}/posts/lp/comments/fc`).set(published(friend, { text: 'Thinking of you.' }))
  await db.doc(`${g}/posts/lp/likes/${friend}`).set({ uid: friend, createdAt: new Date() })
  // The friend's post, with the leaver's reply and like
  await db.doc(`${g}/posts/fp`).set(published(friend, { body: 'Small win today.', likeCount: 0, commentCount: 0 }))
  await db.doc(`${g}/posts/fp/comments/lc`).set(published(leaver, { text: 'So glad.' }))
  await db.doc(`${g}/posts/fp/likes/${leaver}`).set({ uid: leaver, createdAt: new Date() })
  // Group talk from both
  await db.doc(`${g}/messages/lm`).set(published(leaver, { text: 'Evening all.' }))
  await db.doc(`${g}/messages/fm`).set(published(friend, { text: 'Evening.' }))

  // A connection (mirrored to friendships by trigger) and a private thread with lines from both
  await db.doc(`connections/${pair}`).set({ uids: pair.split('_'), requester: leaver, recipient: friend, status: 'accepted', createdAt: new Date(), updatedAt: new Date() })
  await db.doc(`dms/${pair}`).set({ uids: pair.split('_'), lastMessageAt: new Date(), lastAuthorUid: friend })
  await db.doc(`dms/${pair}/messages/m1`).set(published(leaver, { text: 'Can we talk later?' }))
  await db.doc(`dms/${pair}/messages/m2`).set(published(friend, { text: 'Of course.' }))

  // A private group chat with lines from both
  await db.doc(`chats/c-${n}`).set({ name: 'Soup rota', uids: [leaver, friend], createdBy: leaver, createdAt: new Date(), lastMessageAt: new Date() })
  await db.doc(`chats/c-${n}/messages/lc`).set(published(leaver, { text: 'Tuesday works.' }))
  await db.doc(`chats/c-${n}/messages/fc`).set(published(friend, { text: 'Thursday for me.' }))

  // Review queue: the leaver's own item, a friend's reply under the leaver's post, a friend's private line
  await db.doc(queueDoc(`${g}/messages/lm`)).set({ contentPath: `${g}/messages/lm`, kind: 'groupMessage', authorUid: leaver, state: 'open' })
  await db.doc(queueDoc(`${g}/posts/lp/comments/fc`)).set({ contentPath: `${g}/posts/lp/comments/fc`, kind: 'comment', authorUid: friend, state: 'open' })
  await db.doc(queueDoc(`dms/${pair}/messages/m2`)).set({ contentPath: `dms/${pair}/messages/m2`, kind: 'dm', pairId: pair, authorUid: friend, state: 'open' })

  // A report the leaver filed about the friend's post (the trigger queues it)
  await db.collection('reports').add({ reporterUid: leaver, contentPath: `${g}/posts/fp`, reason: 'other', details: 'test', createdAt: new Date() })

  // The friend's notifications: one the leaver caused (a mention), one from someone else
  await db.doc(`users/${friend}/notices/from-leaver`).set({ type: 'mention', contentPath: `${g}/messages/lm`, actorUid: leaver, seen: false, createdAt: new Date() })
  await db.doc(`users/${friend}/notices/from-mod`).set({ type: 'comment', contentPath: `${g}/posts/fp/comments/x`, actorUid: mod, seen: false, createdAt: new Date() })

  // Posting-rate stamps (written by moderation)
  await db.doc(`rateLimits/${leaver}`).set({ stamps: [Date.now()], updatedAt: new Date() })

  // A licence application with a document
  await db.doc(`proApplications/${leaver}`).set({ uid: leaver, status: 'submitted', legalName: 'Test Person', files: ['doc-1'] })
  await bucket.file(`proDocs/${leaver}/doc-1`).save(Buffer.from('%PDF-1.4\n%%EOF\n'), { contentType: 'application/pdf' })

  // Let the counter, friendship and report triggers settle before deleting anything
  await eventually(async () => (await field(g, 'memberCount')) === 2, 'member count')
  await eventually(async () => (await field(`${g}/posts/fp`, 'likeCount')) === 1 && (await field(`${g}/posts/fp`, 'commentCount')) === 1, 'counts on the friend’s post')
  await eventually(() => exists(`friendships/${pair}`), 'the friendship mirror')
  await eventually(async () => ((await field(queueDoc(`${g}/posts/fp`), 'reports.reporterUids')) ?? []).includes(leaver), 'the report to reach the queue')
  return w
}

const signInAs = async (uid: string) => {
  await signOut(auth)
  await signInWithEmailAndPassword(auth, `${uid}@example.test`, PASSWORD)
}

const problemOf = async (attempt: Promise<unknown>) => {
  const error = await attempt.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(FirebaseError)
  const { code, details } = error as FirebaseError & { details?: { problem?: string } }
  return { code, problem: details?.problem }
}

beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST || !process.env.FIREBASE_EMULATOR_HUB) {
    throw new Error('Run with npm run test:e2e (inside the emulators).')
  }
  await connectClient()
  process.env.GCLOUD_PROJECT ??= PROJECT_ID
  // @ts-expect-error built JS from the functions package (npm run functions:build)
  const { db: handlerDb } = await import('../../functions/lib/app.js')
  // @ts-expect-error built JS from the functions package (npm run functions:build)
  const { saveProfile } = await import('../../functions/lib/profile.js')
  // @ts-expect-error built JS from the functions package (npm run functions:build)
  const { deleteAccount: deleteAccountHandler } = await import('../../functions/lib/account.js')
  handlers = { db: handlerDb, saveProfile, deleteAccount: deleteAccountHandler }
})

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(async () => {
  await signOut(auth)
  await deleteApp(client)
  await deleteAdminApp(admin)
})

describe('deleteAccount', () => {
  it('refuses without a signed-in person', async () => {
    const w = await seed()
    await signOut(auth)
    expect(await problemOf(deleteAccount({ confirm: w.leaverName }))).toMatchObject({ code: 'functions/unauthenticated' })
  })

  it('refuses a confirmation that doesn’t match, and leaves everything in place', async () => {
    const w = await seed()
    await signInAs(w.leaver)
    expect(await problemOf(deleteAccount({ confirm: w.friendName }))).toEqual({ code: 'functions/invalid-argument', problem: 'confirm' })
    expect(await exists(`users/${w.leaver}`)).toBe(true)
    expect(await exists(`${w.g}/posts/lp`)).toBe(true)
    await expect(adminAuth.getUser(w.leaver)).resolves.toBeTruthy()
  })

  it('refuses a moderator', async () => {
    const w = await seed()
    await signInAs(w.mod)
    expect(await problemOf(deleteAccount({ confirm: w.modName }))).toEqual({ code: 'functions/failed-precondition', problem: 'admin' })
    expect(await exists(`users/${w.mod}`)).toBe(true)
  })

  it('removes everything the person left behind, and nothing of anyone else’s', async () => {
    const { leaver, friend, pair, g, n } = await seed()
    await signInAs(leaver)
    await expect(deleteAccount({ confirm: `  leaving   LARK ${n} ` })).resolves.toMatchObject({ data: { ok: true } })

    for (const path of [
      // profile and its subcollections, pen name, membership, connection, friendship
      `users/${leaver}`,
      `users/${leaver}/private/settings`,
      `users/${leaver}/notices/n1`,
      `penNames/leaving lark ${n}`,
      `${g}/members/${leaver}`,
      `connections/${pair}`,
      `friendships/${pair}`,
      // their post with everything under it; their reply, like and group talk elsewhere
      `${g}/posts/lp`,
      `${g}/posts/lp/comments/fc`,
      `${g}/posts/lp/likes/${friend}`,
      `${g}/posts/fp/comments/lc`,
      `${g}/posts/fp/likes/${leaver}`,
      `${g}/messages/lm`,
      // the private thread, both sides
      `dms/${pair}`,
      `dms/${pair}/messages/m1`,
      `dms/${pair}/messages/m2`,
      // their lines in a private group chat
      `chats/c-${n}/messages/lc`,
      // queue items that would point at nothing, the licence application
      queueDoc(`${g}/messages/lm`),
      queueDoc(`${g}/posts/lp/comments/fc`),
      queueDoc(`dms/${pair}/messages/m2`),
      `proApplications/${leaver}`,
      `rateLimits/${leaver}`,
      // what they caused in other people's notifications
      `users/${friend}/notices/from-leaver`,
    ]) {
      expect(await exists(path), path).toBe(false)
    }
    expect((await db.collection('reports').where('reporterUid', '==', leaver).get()).size).toBe(0)
    const [files] = await bucket.getFiles({ prefix: `proDocs/${leaver}/` })
    expect(files).toHaveLength(0)
    await expect(adminAuth.getUser(leaver)).rejects.toMatchObject({ code: 'auth/user-not-found' })

    // Kept: the friend, their post and group talk, the group; the report stays queued without the leaver's uid
    for (const path of [
      `users/${friend}`,
      `users/${friend}/notices/from-mod`,
      `penNames/staying finch ${n}`,
      `${g}/members/${friend}`,
      `${g}/posts/fp`,
      `${g}/messages/fm`,
      g,
    ]) {
      expect(await exists(path), path).toBe(true)
    }
    expect(await field(queueDoc(`${g}/posts/fp`), 'reports.reporterUids')).toEqual([])
    // The private group chat carries on without them
    expect(await exists(`chats/c-${n}/messages/fc`)).toBe(true)
    expect(await field(`chats/c-${n}`, 'uids')).toEqual([friend])

    // Counters follow by trigger
    await eventually(async () => (await field(g, 'memberCount')) === 1, 'member count to drop')
    await eventually(
      async () => (await field(`${g}/posts/fp`, 'likeCount')) === 0 && (await field(`${g}/posts/fp`, 'commentCount')) === 0,
      'counts on the friend’s post to drop',
    )

    // An audit row, ids only
    const audit = await db.collection('adminActions').where('target', '==', leaver).get()
    expect(audit.docs.map((d) => d.data())).toEqual([
      expect.objectContaining({ actorUid: leaver, action: 'deleteAccount', details: { posts: 1, threads: 1, items: expect.any(Number) } }),
    ])
  })

  // The other person's notes are all there is in the thread, and none went out: one held for review,
  // one that came after the two disconnected. No connection, no thread doc, nothing from the leaver
  it('removes a private thread where only the other person wrote and nothing was delivered', async () => {
    const w = await seed()
    const other = `other-${w.n}`
    await person(other, `Other Wren ${w.n}`)
    const pair = [other, w.leaver].sort().join('_')
    const held = `dms/${pair}/messages/h`
    const undelivered = `dms/${pair}/messages/u`
    await db.doc(held).set({ authorUid: other, text: 'Are you there?', status: 'held', heldReason: 'review', createdAt: new Date() })
    await db.doc(undelivered).set({ authorUid: other, text: 'Thinking of you.', status: 'held', undelivered: true, createdAt: new Date() })
    await db.doc(queueDoc(held)).set({ contentPath: held, kind: 'dm', pairId: pair, authorUid: other, state: 'open' })

    await signInAs(w.leaver)
    await expect(deleteAccount({ confirm: w.leaverName })).resolves.toMatchObject({ data: { ok: true } })
    for (const path of [held, undelivered, queueDoc(held)]) expect(await exists(path), path).toBe(false)
    expect(await exists(`users/${other}`)).toBe(true)
  })

  it('turns away a pen name from a tab still signed in once the account is gone', async () => {
    const w = await seed()
    await signInAs(w.leaver)
    await expect(deleteAccount({ confirm: w.leaverName })).resolves.toMatchObject({ data: { ok: true } })

    // The tab's token is still good for up to an hour, and its page asks for a pen name
    await expect(handlers.saveProfile.run(fromTab(w.leaver, { penName: `Quiet Fern ${w.n}` }))).rejects.toMatchObject({ code: 'unauthenticated' })
    expect(await exists(`users/${w.leaver}`)).toBe(false)
    expect(await exists(`penNames/quiet fern ${w.n}`)).toBe(false)
  })

  it('turns away a profile a tab left open tries to make while the purge runs', async () => {
    const w = await seed()
    const recursiveDelete = handlers.db.recursiveDelete.bind(handlers.db)
    let saved: unknown
    // The purge's first tree is the profile. Once it's gone, the other tab is sent to choose a pen
    // name, and saves the one it was given while the account is still there
    vi.spyOn(handlers.db, 'recursiveDelete').mockImplementationOnce(async (ref, writer) => {
      await recursiveDelete(ref, writer)
      saved = await handlers.saveProfile.run(fromTab(w.leaver, { penName: `Quiet Fern ${w.n}` })).catch((error: unknown) => error)
    })

    await expect(handlers.deleteAccount.run(fromTab(w.leaver, { confirm: w.leaverName }))).resolves.toMatchObject({ ok: true })
    expect(saved).toMatchObject({ code: 'unauthenticated' })
    expect(await exists(`users/${w.leaver}`)).toBe(false)
    expect(await exists(`penNames/quiet fern ${w.n}`)).toBe(false)
    expect(await exists(`penNameShapes/quiet fern ${w.n}`)).toBe(false)
    await expect(adminAuth.getUser(w.leaver)).rejects.toMatchObject({ code: 'auth/user-not-found' })
  })

  it('turns away a rename that asked Auth before the deletion and lands after it finished', async () => {
    const w = await seed()
    const runTransaction = handlers.db.runTransaction.bind(handlers.db)
    // The rename has passed its checks (Auth still knew them) and waits; the whole deletion
    // happens, its last look finds no profile, and then the rename's transaction runs
    vi.spyOn(handlers.db, 'runTransaction').mockImplementationOnce((async (update: Parameters<Firestore['runTransaction']>[0]) => {
      await expect(handlers.deleteAccount.run(fromTab(w.leaver, { confirm: w.leaverName }))).resolves.toMatchObject({ ok: true })
      expect(await exists(`users/${w.leaver}`)).toBe(false)
      return runTransaction(update)
    }) as Firestore['runTransaction'])

    await expect(handlers.saveProfile.run(fromTab(w.leaver, { penName: `Quiet Fern ${w.n}`, note: 'Back again' }))).rejects.toMatchObject({ code: 'unauthenticated' })
    expect(await exists(`users/${w.leaver}`)).toBe(false)
    expect(await exists(`penNames/quiet fern ${w.n}`)).toBe(false)
    expect(await exists(`penNameShapes/quiet fern ${w.n}`)).toBe(false)
    expect(await exists(`penNames/leaving lark ${w.n}`)).toBe(false)
  })

  // Between the purge's first step and its last a moderator may still act on them
  it('leaves no profile behind when a moderator bans and unbans someone whose profile is gone', async () => {
    const w = await seed()
    await db.doc(`users/${w.leaver}`).delete()
    await signInAs(w.mod)
    await expect(banUser({ uid: w.leaver, reason: 'test' })).resolves.toMatchObject({ data: { ok: true } })
    expect(await exists(`users/${w.leaver}`)).toBe(false)
    await expect(unbanUser({ uid: w.leaver })).resolves.toMatchObject({ data: { ok: true } })
    expect(await exists(`users/${w.leaver}`)).toBe(false)
  })

  it('accepts the word "delete" from someone who never chose a pen name', async () => {
    const w = await seed()
    await db.doc(`users/${w.leaver}`).delete()
    await signInAs(w.leaver)
    expect(await problemOf(deleteAccount({ confirm: w.leaverName }))).toMatchObject({ problem: 'confirm' })
    await expect(deleteAccount({ confirm: 'delete' })).resolves.toMatchObject({ data: { ok: true } })
    await expect(adminAuth.getUser(w.leaver)).rejects.toMatchObject({ code: 'auth/user-not-found' })
    expect(await exists(`penNames/leaving lark ${w.n}`)).toBe(false)
  })
})

describe('Reset profile', () => {
  // The name and mark the triggers put on writing as it goes out, and on the notices it causes
  const signed = (penName: string, uid: string) => ({ penName, avatarSeed: uid, pigment: 'graphite', pro: false })

  // The leaver's writing carries their name, one post of theirs is held, and their profile is reported
  const reported = async () => {
    const w = await seed()
    const { leaver, friend, mod, pair, g, n } = w
    const theirs = [`${g}/posts/lp`, `${g}/posts/fp/comments/lc`, `${g}/messages/lm`, `dms/${pair}/messages/m1`, `chats/c-${n}/messages/lc`]
    const held = `${g}/posts/held`
    await Promise.all(theirs.map((path) => db.doc(path).update({ author: signed(w.leaverName, leaver) })))
    await db.doc(`${g}/posts/fp`).update({ author: signed(w.friendName, friend) })
    await db.doc(held).set({ authorUid: leaver, body: 'Hard day.', status: 'held', heldReason: 'review', createdAt: new Date(), author: signed(w.leaverName, leaver) })
    await db.doc(queueDoc(held)).set({ contentPath: held, kind: 'post', groupId: `g-${n}`, authorUid: leaver, state: 'open' })
    await db.doc(`users/${friend}/notices/from-leaver`).update({ actor: signed(w.leaverName, leaver) })
    await db.doc(`users/${friend}/notices/from-mod`).update({ actor: signed(w.modName, mod) })
    await db.doc(queueDoc(`users/${leaver}`)).set({ contentPath: `users/${leaver}`, kind: 'profile', authorUid: leaver, state: 'open' })
    return { ...w, theirs, held }
  }

  // A moderator presses Reset profile; gives the name it handed out
  const reset = async (w: { mod: string; leaver: string }): Promise<string> => {
    await signInAs(w.mod)
    await expect(removeContent({ queueId: queueId(`users/${w.leaver}`) })).resolves.toMatchObject({ data: { ok: true } })
    return field(`users/${w.leaver}`, 'penName')
  }

  it('takes the reported name off everything they wrote and every notice they caused', async () => {
    const w = await reported()
    const fresh = await reset(w)
    expect(fresh).not.toBe(w.leaverName)

    for (const path of w.theirs) expect(await field(path, 'author'), path).toEqual(signed(fresh, w.leaver))
    expect(await field(w.held, 'author')).toEqual(signed(fresh, w.leaver))
    expect(await field(`users/${w.friend}/notices/from-leaver`, 'actor')).toEqual(signed(fresh, w.leaver))
    // Nobody else's name moves
    expect(await field(`${w.g}/posts/fp`, 'author.penName')).toBe(w.friendName)
    expect(await field(`users/${w.friend}/notices/from-mod`, 'actor.penName')).toBe(w.modName)

    // Writing held before the reset goes out under the new name
    await expect(approveContent({ queueId: queueId(w.held) })).resolves.toMatchObject({ data: { ok: true } })
    expect(await field(w.held, 'status')).toBe('published')
    expect(await field(w.held, 'author.penName')).toBe(fresh)
  })

  it('retires the name: nobody can take it, them included, even once their account is gone', async () => {
    const w = await reported()
    const fresh = await reset(w)
    const refused = { code: 'functions/invalid-argument', problem: 'unkind' }

    await signInAs(w.leaver)
    expect(await problemOf(saveProfile({ penName: w.leaverName }))).toEqual(refused)
    expect(await problemOf(saveProfile({ penName: `leaving  LARK ${w.n}` }))).toEqual(refused)
    expect(await field(`users/${w.leaver}`, 'penName')).toBe(fresh)
    await signInAs(w.friend)
    expect(await problemOf(saveProfile({ penName: w.leaverName }))).toEqual(refused)

    // Leaving frees the name they had at the end. The retired one stays blocked, and nothing in it points back at them.
    await signInAs(w.leaver)
    expect((await db.doc(`penNameShapes/${fresh.toLowerCase()}`).get()).data()).toEqual({ uid: w.leaver })
    await expect(deleteAccount({ confirm: fresh })).resolves.toMatchObject({ data: { ok: true } })
    expect(await exists(`penNames/${fresh.toLowerCase()}`)).toBe(false)
    expect(await exists(`penNameShapes/${fresh.toLowerCase()}`)).toBe(false)
    expect((await db.doc(`penNames/leaving lark ${w.n}`).get()).data()).toEqual({ retired: true })
    expect((await db.doc(`penNameShapes/leaving lark ${w.n}`).get()).data()).toEqual({ retired: true })
    await signInAs(w.friend)
    expect(await problemOf(saveProfile({ penName: w.leaverName }))).toEqual(refused)
  })

  // The friend reports the leaver's profile, and the trigger queues it under the name it has; then
  // the leaver renames before a moderator gets to it, which frees the reported name
  const renamedAfterReport = async () => {
    const w = await seed()
    const profile = `users/${w.leaver}`
    await db.collection('reports').add({ reporterUid: w.friend, contentPath: profile, reason: 'impersonation', createdAt: new Date() })
    await eventually(async () => (await field(queueDoc(profile), 'authorPenName')) === w.leaverName, 'the report to reach the queue')
    const plainName = `Plain Fern ${w.n}`
    await signInAs(w.leaver)
    await expect(saveProfile({ penName: plainName })).resolves.toMatchObject({ data: { ok: true } })
    expect(await exists(`penNames/leaving lark ${w.n}`)).toBe(false)
    return { ...w, plainName }
  }

  it('retires the name the moderator was shown, though they renamed since, and frees the one nobody reported', async () => {
    const w = await renamedAfterReport()
    const fresh = await reset(w)
    expect(fresh).not.toBe(w.plainName)
    const refused = { code: 'functions/invalid-argument', problem: 'unkind' }

    expect((await db.doc(`penNames/leaving lark ${w.n}`).get()).data()).toEqual({ retired: true })
    await signInAs(w.leaver)
    expect(await problemOf(saveProfile({ penName: w.leaverName }))).toEqual(refused)
    await signInAs(w.friend)
    expect(await problemOf(saveProfile({ penName: w.leaverName }))).toEqual(refused)

    expect(await exists(`penNames/plain fern ${w.n}`)).toBe(false)
    await expect(saveProfile({ penName: w.plainName })).resolves.toMatchObject({ data: { ok: true } })
    expect((await db.doc(`penNames/plain fern ${w.n}`).get()).data()).toEqual({ uid: w.friend })
  })

  it('leaves the reported name with someone who took it after they renamed', async () => {
    const w = await renamedAfterReport()
    await signInAs(w.friend)
    await expect(saveProfile({ penName: w.leaverName })).resolves.toMatchObject({ data: { ok: true } })

    await reset(w)
    expect((await db.doc(`penNames/leaving lark ${w.n}`).get()).data()).toEqual({ uid: w.friend })
    expect(await field(`users/${w.friend}`, 'penName')).toBe(w.leaverName)
    expect(await exists(`penNames/plain fern ${w.n}`)).toBe(false)
  })
})
