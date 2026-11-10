/*
 * A moderator's Reset profile (removeContent on a reported profile), on the Auth and Firestore
 * emulators. The handlers run in this process, as the local backend runs them, so a failure can be
 * made to land part way. Covers: the generated name it gives is one it found free; the new name
 * reaches what they already wrote however the first try ended; the name it retires stays retired
 * in every spelling. npm run functions:build, then inside the emulators
 *   vitest run --config vitest.e2e.config.ts tests/e2e/profileReset.test.ts
 */
import type { Auth } from 'firebase-admin/auth'
import type { BulkWriter, Firestore } from 'firebase-admin/firestore'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

interface Callable {
  run: (request: unknown) => Promise<{ ok: boolean; outcome?: string; penName?: string }>
}

let auth: Auth
let db: Firestore
let removeContent: Callable
let saveProfile: Callable
let finishRefreshes: (leftForMs?: number) => Promise<number>

beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error('Run inside the emulators (Auth and Firestore).')
  process.env.GCLOUD_PROJECT ??= 'demo-crafting-constellations'
  // @ts-expect-error built JS from the functions package (npm run functions:build)
  const app = await import('../../functions/lib/app.js')
  auth = app.auth
  db = app.db
  // @ts-expect-error built JS from the functions package (npm run functions:build)
  const admin = await import('../../functions/lib/admin.js')
  removeContent = admin.removeContent
  finishRefreshes = admin.finishRefreshes
  // @ts-expect-error built JS from the functions package (npm run functions:build)
  saveProfile = (await import('../../functions/lib/profile.js')).saveProfile
})

afterEach(() => {
  vi.restoreAllMocks()
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const data = async (path: string) => (await db.doc(path).get()).data()
const field = async (path: string, name: string) => (await db.doc(path).get()).get(name)

// Names and ids end in this run's number, so a second run on the same emulators starts clean
const n = Math.floor(Math.random() * 900 + 100)
let runs = 0

// The name and mark the triggers put on writing as it goes out
const signed = (penName: string, uid: string) => ({ penName, avatarSeed: uid, pigment: 'graphite', pro: false })

// Someone going by `penName`, reported (their profile queued), with a post, a comment and a notice
// they caused, all signed with the name; and a moderator
const reported = async (penName: string) => {
  const run = ++runs
  const owner = `reset-owner-${n}-${run}`
  const friend = `reset-friend-${n}-${run}`
  const mod = `reset-mod-${n}-${run}`
  await Promise.all([owner, friend, mod].map((uid) => auth.createUser({ uid })))
  await auth.setCustomUserClaims(mod, { admin: true })
  await saveProfile.run({ data: { penName }, auth: { uid: owner, token: { uid: owner } }, acceptsStreaming: false })
  const g = `groups/reset-${n}-${run}`
  const writing = [`${g}/posts/p1`, `${g}/posts/p2`, `${g}/posts/p2/comments/c1`]
  await Promise.all(writing.map((path) => db.doc(path).set({ authorUid: owner, body: 'A long day.', status: 'published', createdAt: new Date(), author: signed(penName, owner) })))
  const notice = `users/${friend}/notices/from-${owner}`
  await db.doc(notice).set({ type: 'comment', actorUid: owner, actor: signed(penName, owner), seen: false, createdAt: new Date() })
  const queueId = `users~${owner}`
  await db.doc(`modQueue/${queueId}`).set({ contentPath: `users/${owner}`, kind: 'profile', authorUid: owner, authorPenName: penName, state: 'open' })
  const remove = () => removeContent.run({ data: { queueId }, auth: { uid: mod, token: { uid: mod, admin: true } }, acceptsStreaming: false })
  const shown = async () => Promise.all([...writing.map((path) => field(path, 'author.penName')), field(notice, 'actor.penName')])
  const removedNotices = async () => (await db.collection(`users/${owner}/notices`).where('type', '==', 'removed').get()).size
  const logged = async () => (await db.collection('adminActions').where('target', '==', queueId).get()).size
  return { owner, mod, g, writing, notice, queueId, remove, shown, removedNotices, logged }
}

// Generated names are shared by every test and run: sets each record for the test (null: none
// there), and gives what puts back what was there before
const holding = async (records: Record<string, Record<string, unknown> | null>) => {
  const before = await Promise.all(Object.keys(records).map(async (path) => [path, await data(path)] as const))
  const put = (path: string, record: Record<string, unknown> | null | undefined) => (record ? db.doc(path).set(record) : db.doc(path).delete())
  await Promise.all(Object.entries(records).map(([path, record]) => put(path, record)))
  return async () => {
    await Promise.all(before.map(([path, was]) => put(path, was)))
  }
}

describe('the name Reset profile gives', () => {
  // Every generated name is then "Dusk Cove" or "Dusk Cove 99"
  const sameNamesEveryTime = () => vi.spyOn(Math, 'random').mockReturnValue(0.999)

  it('is never one it did not find free: with every one taken it changes nothing', async () => {
    const r = await reported(`Loud Gull ${n}`)
    const release = await holding({
      'penNames/dusk cove': { uid: 'someone' },
      'penNames/dusk cove 99': { uid: 'someone-else' },
      'penNameShapes/dusk cove': null,
      'penNameShapes/dusk cove 99': null,
    })
    try {
      sameNamesEveryTime()
      await expect(r.remove()).rejects.toMatchObject({ code: 'resource-exhausted' })
      vi.restoreAllMocks()
      // Nobody's claim was taken over, and the reset never happened
      expect(await data('penNames/dusk cove 99')).toEqual({ uid: 'someone-else' })
      expect(await data('penNames/dusk cove')).toEqual({ uid: 'someone' })
      expect(await field(`users/${r.owner}`, 'penName')).toBe(`Loud Gull ${n}`)
      expect(await data(`penNames/loud gull ${n}`)).toEqual({ uid: r.owner })
      expect(await field(`modQueue/${r.queueId}`, 'state')).toBe('open')
      expect(await r.removedNotices()).toBe(0)
      expect(await r.logged()).toBe(0)
    } finally {
      await release()
    }
  })

  it('moves on to a numbered name when the plain one is taken, by its key or by a lookalike', async () => {
    const r = await reported(`Loud Tern ${n}`)
    // "Dusk Cove" is free by its key, but someone goes by it in lookalike letters ("Dusk Cоvе")
    const release = await holding({
      'penNames/dusk cove': null,
      'penNameShapes/dusk cove': { uid: 'someone' },
      'penNames/dusk cove 99': null,
      'penNameShapes/dusk cove 99': null,
    })
    try {
      sameNamesEveryTime()
      await expect(r.remove()).resolves.toMatchObject({ ok: true, outcome: 'removed' })
      vi.restoreAllMocks()
      expect(await field(`users/${r.owner}`, 'penName')).toBe('Dusk Cove 99')
      expect(await data('penNames/dusk cove 99')).toEqual({ uid: r.owner })
      expect(await data('penNameShapes/dusk cove 99')).toEqual({ uid: r.owner })
      expect(await data('penNameShapes/dusk cove')).toEqual({ uid: 'someone' })
    } finally {
      await release()
    }
  })
})

describe('the new name on what they already wrote', () => {
  it('lands with Remove pressed again, after a failure just after the decision', async () => {
    const r = await reported(`Loud Crow ${n}`)
    vi.spyOn(db, 'bulkWriter').mockImplementationOnce(() => {
      throw new Error('stopped')
    })
    await expect(r.remove()).rejects.toThrow('stopped')
    const fresh = await field(`users/${r.owner}`, 'penName')
    expect(fresh).not.toBe(`Loud Crow ${n}`)
    // Decided, and logged with it, but their writing still shows the old name
    expect(await field(`modQueue/${r.queueId}`, 'state')).toBe('resolved')
    expect(await field(`modQueue/${r.queueId}`, 'writingRefresh')).toMatchObject({ penName: fresh, state: 'pending' })
    expect(await r.logged()).toBe(1)
    expect(await r.shown()).toEqual(Array(4).fill(`Loud Crow ${n}`))

    await expect(r.remove()).resolves.toMatchObject({ ok: true, outcome: 'already-resolved' })
    expect(await r.shown()).toEqual(Array(4).fill(fresh))
    expect(await field(`modQueue/${r.queueId}`, 'writingRefresh.state')).toBe('done')
    // Not reset a second time, nor told twice, nor logged twice
    expect(await field(`users/${r.owner}`, 'penName')).toBe(fresh)
    expect(await r.removedNotices()).toBe(1)
    expect(await r.logged()).toBe(1)
  })

  it('lands by the catch-up after a failure part way through, with nobody pressing anything', async () => {
    const r = await reported(`Loud Rook ${n}`)
    const bulkWriter = db.bulkWriter.bind(db)
    vi.spyOn(db, 'bulkWriter').mockImplementationOnce(() => {
      const writer = bulkWriter()
      const update = writer.update.bind(writer)
      let updates = 0
      writer.update = ((...args: Parameters<BulkWriter['update']>) =>
        ++updates === 2 ? Promise.reject(new Error('dropped')) : update(...args)) as BulkWriter['update']
      return writer
    })
    await expect(r.remove()).rejects.toThrow('dropped')
    const fresh = await field(`users/${r.owner}`, 'penName')
    const part = await r.shown()
    expect(part.filter((name) => name === fresh)).toHaveLength(3)
    expect(part.filter((name) => name === `Loud Rook ${n}`)).toHaveLength(1)

    // A Remove still at it isn't doubled: the catch-up leaves a fresh one alone
    await finishRefreshes()
    expect(await field(`modQueue/${r.queueId}`, 'writingRefresh.state')).toBe('pending')
    expect(await finishRefreshes(0)).toBeGreaterThanOrEqual(1)
    expect(await r.shown()).toEqual(Array(4).fill(fresh))
    expect(await field(`modQueue/${r.queueId}`, 'writingRefresh.state')).toBe('done')
  })

  it('leaves what they wrote after the reset under the name they wrote it with', async () => {
    const r = await reported(`Loud Jay ${n}`)
    vi.spyOn(db, 'bulkWriter').mockImplementationOnce(() => {
      throw new Error('stopped')
    })
    await expect(r.remove()).rejects.toThrow('stopped')
    const fresh = await field(`users/${r.owner}`, 'penName')

    // Before anyone finishes it, they rename and write again
    await sleep(20)
    await saveProfile.run({ data: { penName: `Plain Linnet ${n}` }, auth: { uid: r.owner, token: { uid: r.owner } }, acceptsStreaming: false })
    const later = `${r.g}/posts/later`
    await db.doc(later).set({ authorUid: r.owner, body: 'Better today.', status: 'published', createdAt: new Date(), author: signed(`Plain Linnet ${n}`, r.owner) })

    await finishRefreshes(0)
    expect(await r.shown()).toEqual(Array(4).fill(fresh))
    expect(await field(later, 'author.penName')).toBe(`Plain Linnet ${n}`)
  })
})

describe('the name Reset profile retires', () => {
  it('stays retired in every spelling, for everyone, them included', async () => {
    const r = await reported(`Bea OʼRourke ${n}`)
    await expect(r.remove()).resolves.toMatchObject({ ok: true, outcome: 'removed' })
    expect(await data(`penNames/bea oʼrourke ${n}`)).toEqual({ retired: true })
    expect(await data(`penNameShapes/bea o'rourke ${n}`)).toEqual({ retired: true })

    const someone = `reset-someone-${n}`
    await auth.createUser({ uid: someone })
    for (const uid of [someone, r.owner]) {
      await expect(saveProfile.run({ data: { penName: `Bea O'Rourke ${n}` }, auth: { uid, token: { uid } }, acceptsStreaming: false })).rejects.toMatchObject({
        code: 'invalid-argument',
        details: { problem: 'unkind' },
      })
    }
  })
})
