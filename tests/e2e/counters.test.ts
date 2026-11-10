/*
 * The counter triggers (functions/src/counters.ts) against the Firestore emulator, each handler
 * run in this process with events made here, so the same event can come twice, as a retry or a
 * replay brings it. npm run functions:build, then inside `firebase emulators:exec --only firestore`
 * vitest run --config vitest.e2e.config.ts tests/e2e/counters.test.ts. Every test uses fresh ids.
 */
import type { DocumentData, Firestore } from 'firebase-admin/firestore'
import { beforeAll, describe, expect, it } from 'vitest'

interface Snap {
  exists: boolean
  data: () => DocumentData | undefined
}

interface Event {
  id: string
  params: Record<string, string>
  data: { before: Snap; after: Snap }
}

interface Trigger {
  run: (event: Event) => Promise<void>
}

let db: Firestore
let countMembers: Trigger
let countLikes: Trigger
let countComments: Trigger

beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Run inside the emulators (Firestore).')
  process.env.GCLOUD_PROJECT ??= 'demo-crafting-constellations'
  // @ts-expect-error built JS from the functions package (npm run functions:build)
  db = (await import('../../functions/lib/app.js')).db
  // @ts-expect-error built JS from the functions package (npm run functions:build)
  const counters = await import('../../functions/lib/counters.js')
  countMembers = counters.countMembers
  countLikes = counters.countLikes
  countComments = counters.countComments
})

// Ids end in this run's number, so a second run on the same emulators starts clean
const n = Math.floor(Math.random() * 900_000 + 100_000)
let runs = 0
const fresh = (what: string) => `${what}-${n}-${++runs}`

const missing: Snap = { exists: false, data: () => undefined }
const there = (data: DocumentData = {}): Snap => ({ exists: true, data: () => data })
const event = (params: Record<string, string>, before: Snap, after: Snap): Event => ({ id: fresh('event'), params, data: { before, after } })

const count = async (path: string, field: string) => (await db.doc(path).get()).get(field)

// A group with one post, its counters at zero
const seeded = async () => {
  const gid = fresh('group')
  const pid = fresh('post')
  await db.doc(`groups/${gid}`).set({ name: 'Evening sheet', memberCount: 0 })
  await db.doc(`groups/${gid}/posts/${pid}`).set({ status: 'published', likeCount: 0, commentCount: 0 })
  return { gid, pid, group: `groups/${gid}`, post: `groups/${gid}/posts/${pid}` }
}

describe('an event that comes twice', () => {
  it('adds a member once', async () => {
    const { gid, group } = await seeded()
    const joined = event({ gid, uid: fresh('uid') }, missing, there({ uid: 'x' }))
    await countMembers.run(joined)
    await countMembers.run(joined)
    expect(await count(group, 'memberCount')).toBe(1)
  })

  it('adds a like once', async () => {
    const { gid, pid, post } = await seeded()
    const liked = event({ gid, pid, uid: fresh('uid') }, missing, there())
    await countLikes.run(liked)
    await countLikes.run(liked)
    expect(await count(post, 'likeCount')).toBe(1)
  })

  it('counts a published comment once', async () => {
    const { gid, pid, post } = await seeded()
    const published = event({ gid, pid, cid: fresh('comment') }, there({ status: 'pending' }), there({ status: 'published' }))
    await countComments.run(published)
    await countComments.run(published)
    expect(await count(post, 'commentCount')).toBe(1)
  })

  it('moves the counter once each when two at once', async () => {
    const { gid, group } = await seeded()
    const joined = event({ gid, uid: fresh('uid') }, missing, there())
    await Promise.all([countMembers.run(joined), countMembers.run(joined), countMembers.run(joined)])
    expect(await count(group, 'memberCount')).toBe(1)
  })

  it('still counts two different people, each once', async () => {
    const { gid, group } = await seeded()
    const first = event({ gid, uid: fresh('uid') }, missing, there())
    const second = event({ gid, uid: fresh('uid') }, missing, there())
    await countMembers.run(first)
    await countMembers.run(second)
    await countMembers.run(first)
    expect(await count(group, 'memberCount')).toBe(2)
  })
})

// The one real document goes once, so its delete comes once: a replayed create must not outlive it
describe('a create replayed, then the one delete', () => {
  it('leaves no phantom member', async () => {
    const { gid, group } = await seeded()
    const uid = fresh('uid')
    const joined = event({ gid, uid }, missing, there())
    await countMembers.run(joined)
    await countMembers.run(joined)
    await countMembers.run(event({ gid, uid }, there(), missing))
    expect(await count(group, 'memberCount')).toBe(0)
  })

  it('leaves no phantom like when the replay lands after the unlike', async () => {
    const { gid, pid, post } = await seeded()
    const uid = fresh('uid')
    const liked = event({ gid, pid, uid }, missing, there())
    await countLikes.run(liked)
    await countLikes.run(event({ gid, pid, uid }, there(), missing))
    await countLikes.run(liked)
    expect(await count(post, 'likeCount')).toBe(0)
  })

  it('counts nothing for a comment published twice over, then withdrawn', async () => {
    const { gid, pid, post } = await seeded()
    const cid = fresh('comment')
    const published = event({ gid, pid, cid }, there({ status: 'pending' }), there({ status: 'published' }))
    await countComments.run(published)
    await countComments.run(published)
    await countComments.run(event({ gid, pid, cid }, there({ status: 'published' }), there({ status: 'withdrawn' })))
    expect(await count(post, 'commentCount')).toBe(0)
  })
})

describe('a parent that is gone', () => {
  it('stays gone, and a replay brings nothing back', async () => {
    const gid = fresh('group')
    const pid = fresh('post')
    const left = event({ gid, uid: fresh('uid') }, there(), missing)
    const unliked = event({ gid, pid, uid: fresh('uid') }, there(), missing)
    const removed = event({ gid, pid, cid: fresh('comment') }, there({ status: 'published' }), there({ status: 'removed' }))
    for (let i = 0; i < 2; i++) {
      await countMembers.run(left)
      await countLikes.run(unliked)
      await countComments.run(removed)
    }
    expect((await db.doc(`groups/${gid}`).get()).exists).toBe(false)
    expect((await db.doc(`groups/${gid}/posts/${pid}`).get()).exists).toBe(false)
  })

  it('leaves no marker, so nothing is recorded as counted', async () => {
    const gid = fresh('group')
    const joined = event({ gid, uid: fresh('uid') }, missing, there())
    await countMembers.run(joined)
    const markers = await db.collection('counterEvents').where('path', '==', `groups/${gid}`).get()
    expect(markers.size).toBe(0)
  })
})

describe('a write that changes nothing counted', () => {
  it('moves nothing and leaves no marker', async () => {
    const { gid, pid, post } = await seeded()
    const edited = event({ gid, pid, cid: fresh('comment') }, there({ status: 'published', text: 'a' }), there({ status: 'published', text: 'b' }))
    await countComments.run(edited)
    expect(await count(post, 'commentCount')).toBe(0)
    const markers = await db.collection('counterEvents').where('path', '==', post).get()
    expect(markers.size).toBe(0)
  })
})
