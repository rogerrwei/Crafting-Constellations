/*
 * The backfill-pen-name-shapes script (scripts/backfill-pen-name-shapes.ts) against the Firestore
 * emulator. Run inside `firebase emulators:exec --only firestore` (or with the emulators the local
 * backend tests use), naming this file. Names end in this run's number.
 */
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp } from 'firebase-admin/app'
import { getFirestore as getAdminFirestore } from 'firebase-admin/firestore'
import { afterAll, describe, expect, it } from 'vitest'

const PROJECT_ID = 'demo-crafting-constellations'
const ROOT = fileURLToPath(new URL('../..', import.meta.url))

const admin = initializeAdminApp({ projectId: PROJECT_ID }, 'backfill-shapes-admin')
const db = getAdminFirestore(admin)

afterAll(() => deleteAdminApp(admin))

// As `npx tsx scripts/backfill-pen-name-shapes.ts …` runs it, on the emulator the tests were given
const backfill = async (...args: string[]) =>
  (await promisify(execFile)(`${ROOT}node_modules/.bin/tsx`, ['scripts/backfill-pen-name-shapes.ts', ...args], { cwd: ROOT, env: process.env })).stdout

const shape = async (key: string) => (await db.doc(`penNameShapes/${key}`).get()).data()

const n = Math.floor(Math.random() * 900 + 100)
const APOSTROPHE = 'ʼ'
// Cyrillic letters drawn as J, o and y
const JOY = 'Јоу'

// Someone who saved `penName` before shapes were kept: a profile and its penNames claim only
const savedBefore = async (uid: string, penName: string, createdAt: Date) => {
  await db.doc(`users/${uid}`).set({ penName, penNameLower: penName.toLowerCase(), avatarSeed: uid, pigment: 'graphite', pro: false, banned: false, createdAt })
  await db.doc(`penNames/${penName.toLowerCase()}`).set({ uid })
}

describe('backfill-pen-name-shapes', () => {
  it('records what each older name passes for, retired names first, then the earliest profile', async () => {
    const early = new Date(Date.now() - 60_000)
    const late = new Date()
    await savedBefore(`bf-a-${n}`, `Ona O${APOSTROPHE}Brien ${n}`, early)
    await savedBefore(`bf-b-${n}`, `Ona O'Brien ${n}`, late)
    await savedBefore(`bf-c-${n}`, `${JOY} Finch ${n}`, early)
    await savedBefore(`bf-d-${n}`, `Kit Retired ${n}`, early)
    await db.doc(`penNames/old o${APOSTROPHE}name ${n}`).set({ retired: true })

    const dry = await backfill('--dry-run')
    expect(dry).toContain('kept as they are')
    expect(await shape(`ona o'brien ${n}`)).toBeUndefined()

    const out = await backfill()
    expect(out).toContain('Recorded.')
    // Two people already pass for one name: the earlier keeps it, the later is listed and keeps their own key
    expect(await shape(`ona o'brien ${n}`)).toEqual({ uid: `bf-a-${n}` })
    expect(out).toContain(`bf-b-${n}`)
    expect((await db.doc(`penNames/ona o'brien ${n}`).get()).data()).toEqual({ uid: `bf-b-${n}` })
    expect(await shape(`joy finch ${n}`)).toEqual({ uid: `bf-c-${n}` })
    expect(await shape(`kit retired ${n}`)).toEqual({ uid: `bf-d-${n}` })
    expect(await shape(`old o'name ${n}`)).toEqual({ retired: true })
  })

  it('changes nothing when run again, nor anything a save recorded since', async () => {
    await savedBefore(`bf-e-${n}`, `Ash Wren ${n}`, new Date())
    await db.doc(`penNameShapes/ash wren ${n}`).set({ uid: `bf-other-${n}` })
    await backfill()
    expect(await shape(`ash wren ${n}`)).toEqual({ uid: `bf-other-${n}` })
    const again = await backfill()
    expect(again).toMatch(/: 0 names to record/)
  })
})
