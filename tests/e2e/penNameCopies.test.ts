/*
 * saveProfile against names drawn the same as someone else's, on the Auth and Firestore
 * emulators. The handler runs in this process, as the local backend runs it. Needs Auth too,
 * since saveProfile asks it whether the caller still exists: npm run functions:build, then
 * inside the emulators vitest run --config vitest.e2e.config.ts tests/e2e/penNameCopies.test.ts
 */
import type { Auth } from 'firebase-admin/auth'
import type { Firestore } from 'firebase-admin/firestore'
import { beforeAll, describe, expect, it } from 'vitest'

interface Callable {
  run: (request: unknown) => Promise<{ ok: boolean; penName?: string }>
}

let auth: Auth
let db: Firestore
let saveProfile: Callable

beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error('Run inside the emulators (Auth and Firestore).')
  process.env.GCLOUD_PROJECT ??= 'demo-crafting-constellations'
  // @ts-expect-error built JS from the functions package (npm run functions:build)
  const app = await import('../../functions/lib/app.js')
  auth = app.auth
  db = app.db
  // @ts-expect-error built JS from the functions package (npm run functions:build)
  saveProfile = (await import('../../functions/lib/profile.js')).saveProfile
})

const claim = async (lower: string) => (await db.doc(`penNames/${lower}`).get()).data()
const passesFor = async (shape: string) => (await db.doc(`penNameShapes/${shape}`).get()).data()

// Names end in this run's number, so a second run on the same emulators starts clean
const n = Math.floor(Math.random() * 900 + 100)
let runs = 0

// Someone signed up, going by `penName` (with its penNames record) or not yet named
const person = async (penName?: string, record?: Record<string, unknown>) => {
  const uid = `copier-${n}-${++runs}`
  await auth.createUser({ uid })
  if (!penName) return uid
  const lower = penName.toLowerCase()
  await db.doc(`users/${uid}`).set({ penName, penNameLower: lower, avatarSeed: uid, pigment: 'graphite', pro: false, banned: false })
  await db.doc(`penNames/${lower}`).set(record ?? { uid })
  return uid
}

const save = (uid: string, data: Record<string, unknown>) => saveProfile.run({ data, auth: { uid, token: { uid } }, acceptsStreaming: false })

// Cyrillic letters drawn as J, o, y, H, p, e, C, c, K, a and s, and the modifier letter apostrophe
const JOY = '\u0408\u043e\u0443'
const HOPE = '\u041d\u043e\u0440\u0435'
const COCO = '\u0421\u043e\u0441\u043e'
const KAY = '\u041a\u0430\u0443'
const APOSTROPHE = '\u02bc'
// Cyrillic letters drawn as J, o and e, all one alphabet as a name must be
const JOE = '\u0408\u043e\u0435'
// "José" with an acute on the Cyrillic e, and "Jöy" with the Cyrillic o that has a diaeresis
const JOSE = '\u0408\u043e\u0455\u0435\u0301'
const JOY_DIAERESIS = '\u0408\u04e7\u0443'

describe('a name drawn the same as someone else’s', () => {
  it('is refused as taken, and claims nothing', async () => {
    await person(`Joy ${n}`)
    await person(`O'Neil ${n}`)
    await person(`Jos\u00e9 ${n}`)
    await person(`J\u00f6y ${n}`)
    const copier = await person()

    for (const copy of [`${JOY} ${n}`, `O${APOSTROPHE}Neil ${n}`, `${JOSE} ${n}`, `${JOY_DIAERESIS} ${n}`]) {
      await expect(save(copier, { penName: copy })).rejects.toMatchObject({ code: 'already-exists', details: { problem: 'taken' } })
      expect(await claim(copy.toLowerCase())).toBeUndefined()
    }
    expect((await db.doc(`users/${copier}`).get()).exists).toBe(false)
  })

  it('can be taken once the name it copies is free', async () => {
    const owner = await person(`Kay Joy ${n}`)
    const copier = await person(`Plain Fern ${n}`)

    // Refused while the name it copies is someone else’s
    await expect(save(copier, { penName: `${KAY} ${JOY} ${n}` })).rejects.toMatchObject({ details: { problem: 'taken' } })
    await save(owner, { penName: `Quiet Wren ${n}` })

    await expect(save(copier, { penName: `${KAY} ${JOY} ${n}` })).resolves.toMatchObject({ ok: true })
    expect(await claim(`${KAY} ${JOY} ${n}`.toLowerCase())).toEqual({ uid: copier })
  })

  it('is refused when the name it copies was retired', async () => {
    await person(`Hope ${n}`, { retired: true })
    const copier = await person()
    await expect(save(copier, { penName: `${HOPE} ${n}` })).rejects.toMatchObject({ code: 'invalid-argument', details: { problem: 'unkind' } })
  })

  it('stays with someone who went by it before copies were read', async () => {
    await person(`Coco ${n}`)
    const earlier = await person(`${COCO} ${n}`)
    await expect(save(earlier, { penName: `${COCO} ${n}`, note: 'Still here' })).resolves.toMatchObject({ ok: true })
    expect(await claim(`${COCO} ${n}`.toLowerCase())).toEqual({ uid: earlier })
    // The name it passes for stays with nobody: the plain spelling is someone else's
    expect(await passesFor(`coco ${n}`)).toBeUndefined()
  })

  it('is the person’s own when the name it copies is theirs', async () => {
    const owner = await person(`Kay ${n}`)
    await expect(save(owner, { penName: `${KAY} ${n}` })).resolves.toMatchObject({ ok: true })
    expect(await claim(`${KAY} ${n}`.toLowerCase())).toEqual({ uid: owner })
    expect(await claim(`kay ${n}`)).toBeUndefined()
  })

  it('leaves names in another alphabet alone', async () => {
    await person(`Anna ${n}`)
    const anna = await person()
    // Cyrillic н is drawn as a small capital, not an n
    await expect(save(anna, { penName: `\u0410\u043d\u043d\u0430 ${n}` })).resolves.toMatchObject({ ok: true })
  })
})

describe('the plain spelling of a name someone already has in lookalike letters', () => {
  it('is refused as taken, and claims nothing', async () => {
    const first = await person()
    await expect(save(first, { penName: `Meg O${APOSTROPHE}Neil ${n}` })).resolves.toMatchObject({ ok: true })
    const second = await person()
    await expect(save(second, { penName: `${JOE} ${n}` })).resolves.toMatchObject({ ok: true })
    expect(await passesFor(`meg o'neil ${n}`)).toEqual({ uid: first })
    expect(await passesFor(`joe ${n}`)).toEqual({ uid: second })

    const copier = await person()
    await expect(save(copier, { penName: `Meg O'Neil ${n}` })).rejects.toMatchObject({ code: 'already-exists', details: { problem: 'taken' } })
    await expect(save(copier, { penName: `JOE ${n}` })).rejects.toMatchObject({ code: 'already-exists', details: { problem: 'taken' } })
    expect(await claim(`meg o'neil ${n}`)).toBeUndefined()
    expect(await claim(`joe ${n}`)).toBeUndefined()
    expect((await db.doc(`users/${copier}`).get()).exists).toBe(false)
  })

  it('goes to only one of two people claiming the two spellings at once', async () => {
    const [a, b] = [await person(), await person()]
    const results = await Promise.allSettled([save(a, { penName: `Ida O${APOSTROPHE}Hara ${n}` }), save(b, { penName: `Ida O'Hara ${n}` })])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const winner = results[0].status === 'fulfilled' ? a : b
    expect(await passesFor(`ida o'hara ${n}`)).toEqual({ uid: winner })
  })

  it('can be had once the first renames', async () => {
    const first = await person()
    await save(first, { penName: `Ned O${APOSTROPHE}Day ${n}` })
    await save(first, { penName: `Plain Moth ${n}` })
    expect(await passesFor(`ned o'day ${n}`)).toBeUndefined()
    expect(await passesFor(`plain moth ${n}`)).toEqual({ uid: first })

    const second = await person()
    await expect(save(second, { penName: `Ned O'Day ${n}` })).resolves.toMatchObject({ ok: true })
    expect(await passesFor(`ned o'day ${n}`)).toEqual({ uid: second })
  })

  it('stays with its owner when they save it again, or change only its spelling', async () => {
    const owner = await person()
    await save(owner, { penName: `Eve O${APOSTROPHE}Shea ${n}` })
    await expect(save(owner, { penName: `Eve O${APOSTROPHE}Shea ${n}`, note: 'Hello' })).resolves.toMatchObject({ ok: true })
    await expect(save(owner, { penName: `Eve O'Shea ${n}` })).resolves.toMatchObject({ ok: true })
    expect(await passesFor(`eve o'shea ${n}`)).toEqual({ uid: owner })
    expect(await claim(`eve o'shea ${n}`)).toEqual({ uid: owner })
    expect(await claim(`eve o${APOSTROPHE}shea ${n}`)).toBeUndefined()
  })
})
