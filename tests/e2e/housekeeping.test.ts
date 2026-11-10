/*
 * Housekeeping's removal of expired records (functions/src/housekeeping.ts), which stands in for
 * Firestore TTL policies (they need billing), against the Firestore emulator, run in this process.
 * npm run functions:build, then inside `firebase emulators:exec --only firestore`
 * vitest run --config vitest.e2e.config.ts tests/e2e/housekeeping.test.ts. Every test uses fresh ids.
 */
import type { Firestore } from 'firebase-admin/firestore'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

let db: Firestore
let removeExpired: (batch?: number) => Promise<number>

beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Run inside the emulators (Firestore).')
  process.env.GCLOUD_PROJECT ??= 'demo-crafting-constellations'
  // @ts-expect-error built JS from the functions package (npm run functions:build)
  db = (await import('../../functions/lib/app.js')).db
  // @ts-expect-error built JS from the functions package (npm run functions:build)
  removeExpired = (await import('../../functions/lib/housekeeping.js')).removeExpired
})

afterEach(() => {
  vi.restoreAllMocks()
})

const n = Math.floor(Math.random() * 900_000 + 100_000)
let runs = 0
const fresh = (what: string) => `${what}-${n}-${++runs}`

const exists = async (path: string) => (await db.doc(path).get()).exists
const hoursFromNow = (hours: number) => new Date(Date.now() + hours * 3_600_000)

describe('removeExpired', () => {
  it('removes deletion marks and counted-event markers past their expireAt, and nothing else', async () => {
    const paths = {
      leftMark: `accountDeletions/${fresh('left')}`,
      leavingMark: `accountDeletions/${fresh('leaving')}`,
      oldMarker: `counterEvents/${fresh('old')}`,
      newMarker: `counterEvents/${fresh('new')}`,
    }
    await Promise.all([
      db.doc(paths.leftMark).set({ at: hoursFromNow(-25), expireAt: hoursFromNow(-1) }),
      db.doc(paths.leavingMark).set({ at: new Date(), expireAt: hoursFromNow(24) }),
      db.doc(paths.oldMarker).set({ path: 'groups/g', field: 'memberCount', delta: 1, expireAt: hoursFromNow(-1) }),
      db.doc(paths.newMarker).set({ path: 'groups/g', field: 'memberCount', delta: 1, expireAt: hoursFromNow(24 * 7) }),
    ])

    expect(await removeExpired()).toBeGreaterThanOrEqual(2)
    expect(await exists(paths.leftMark)).toBe(false)
    expect(await exists(paths.oldMarker)).toBe(false)
    expect(await exists(paths.leavingMark)).toBe(true)
    expect(await exists(paths.newMarker)).toBe(true)
  })

  it('keeps a mark written again after it was read, as a deletion tried again a day later writes it', async () => {
    const mark = `accountDeletions/${fresh('again')}`
    await db.doc(mark).set({ at: hoursFromNow(-25), expireAt: hoursFromNow(-1) })
    // The deletion is tried again just after the sweep reads the expired mark
    const collection = db.collection.bind(db)
    vi.spyOn(db, 'collection').mockImplementation(((path: string) => {
      const real = collection(path)
      if (path !== 'accountDeletions') return real
      return {
        where: (...args: Parameters<typeof real.where>) => ({
          limit: (count: number) => ({
            get: async () => {
              const read = await real.where(...args).limit(count).get()
              await db.doc(mark).set({ at: new Date(), expireAt: hoursFromNow(24) })
              return read
            },
          }),
        }),
      }
    }) as unknown as Firestore['collection'])

    await removeExpired()
    vi.restoreAllMocks()
    expect(await exists(mark)).toBe(true)
  })
})
