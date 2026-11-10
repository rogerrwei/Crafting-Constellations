/*
 * Seeds the local emulators with clearly synthetic data so every surface has
 * something to show. Refuses to run against anything but a demo- project.
 *
 *   npm run emulators        (in one terminal)
 *   npm run seed             (in another; SEED_ME_UID=<your uid> to join your account in)
 *
 * Every seeded person is flagged `synthetic: true` and shown with a "sample" tag.
 * All seeded accounts share the password below (emulator only). Manual sign-up tests use
 * newcomer@example.test with the same password.
 * Re-running wipes emulator Firestore first; real (non-sample) profiles are kept.
 */
import { initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { FieldValue, getFirestore, Timestamp } from 'firebase-admin/firestore'
import { getStorage } from 'firebase-admin/storage'
import { shapeOf } from '../functions/src/profilePolicy.js'

const PROJECT_ID = 'demo-crafting-constellations'
const SAMPLE_PASSWORD = 'sample-password-only-for-emulator'

process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080'
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= '127.0.0.1:9099'
process.env.FIREBASE_STORAGE_EMULATOR_HOST ??= '127.0.0.1:9199'

if (!PROJECT_ID.startsWith('demo-') || !process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error('Seed only runs against the local demo emulators.')
}

initializeApp({ projectId: PROJECT_ID, storageBucket: `${PROJECT_ID}.appspot.com` })
const db = getFirestore()
const auth = getAuth()
const bucket = getStorage().bucket()

type Pigment = 'paynesBlue' | 'graphite' | 'fresco' | 'paynes' | 'titanium' | 'caliente' | 'neutral' | 'cool' | 'warm'

interface Person {
  uid: string
  penName: string
  pigment: Pigment
  note: string
  verified?: boolean
  admin?: boolean
  pro?: boolean
}

const PEOPLE: Person[] = [
  { uid: 'synth01', penName: 'Steady Lantern', pigment: 'graphite', note: 'Keeps the review queue. (sample)', admin: true },
  { uid: 'synth02', penName: 'Patient Cedar', pigment: 'paynesBlue', note: 'Family therapist. Here on Tuesday evenings. (sample)', pro: true },
  { uid: 'synth03', penName: 'Quiet Heron', pigment: 'fresco', note: 'Dad, two kids, one long year. (sample)' },
  { uid: 'synth04', penName: 'Slow River', pigment: 'caliente', note: 'My mum’s second round. (sample)' },
  { uid: 'synth05', penName: 'Grey Wren', pigment: 'warm', note: 'Far away from home, on the phone a lot. (sample)' },
  { uid: 'synth06', penName: 'Late Harbor', pigment: 'cool', note: 'Partner of someone very brave and very tired. (sample)' },
  { uid: 'synth07', penName: 'Soft Fern', pigment: 'neutral', note: 'Younger sister. (sample)' },
  { uid: 'synth08', penName: 'Still Pebble', pigment: 'titanium', note: 'Night shifts and hospital parking. (sample)' },
  { uid: 'synth09', penName: 'Low Moth', pigment: 'paynes', note: 'Learning to ask for help. (sample)' },
  { uid: 'synth10', penName: 'Pale Willow', pigment: 'fresco', note: 'Grandmother, raising two. (sample)' },
  { uid: 'synth11', penName: 'Even Tide', pigment: 'graphite', note: 'Brother, logistics person. (sample)' },
  { uid: 'synth12', penName: 'Mild Sparrow', pigment: 'caliente', note: 'Here mostly to read. (sample)' },
  { uid: 'synth13', penName: 'Faint Meadow', pigment: 'warm', note: '(sample)', verified: false },
  { uid: 'synth14', penName: 'Dusk Kettle', pigment: 'cool', note: 'Making a lot of soup. (sample)' },
  { uid: 'synth15', penName: 'Small Thistle', pigment: 'neutral', note: '(sample)', verified: false },
  { uid: 'synth16', penName: 'Warm Ember', pigment: 'paynesBlue', note: 'Partner, part-time nurse at home. (sample)' },
]

const CONSTELLATIONS = [
  {
    id: 'parents',
    name: 'Caring for a parent',
    description: 'For adult children looking after a mum, dad, or step-parent.',
    groups: [
      { id: 'late-night-caregivers', name: 'Late-night caregivers', description: 'For the hours after everyone else is asleep.', members: ['synth02', 'synth03', 'synth04', 'synth08', 'synth09', 'synth14'] },
      { id: 'far-away', name: 'Far away from home', description: 'Caring across distance: calls, flights, guilt.', members: ['synth04', 'synth05', 'synth11', 'synth12'] },
      { id: 'after-appointments', name: 'After the appointment', description: 'Making sense of what the doctor said.', members: ['synth02', 'synth03', 'synth05', 'synth10', 'synth13'] },
    ],
  },
  {
    id: 'siblings',
    name: 'Brothers, sisters, young adults',
    description: 'For siblings and young adults (18+) with someone ill at home.',
    groups: [
      { id: 'siblings', name: 'Brothers & sisters', description: 'When it is your sibling who is ill.', members: ['synth07', 'synth11', 'synth12', 'synth15'] },
      { id: 'young-adults', name: 'Young adults (18+)', description: 'Studying, working, and caring at the same time.', members: ['synth07', 'synth09', 'synth05'] },
    ],
  },
  {
    id: 'partners',
    name: 'Partners & households',
    description: 'For partners, spouses, and whoever keeps the house running.',
    groups: [
      { id: 'waiting-rooms', name: 'Partners in waiting rooms', description: 'Holding the coats and the questions.', members: ['synth02', 'synth06', 'synth16', 'synth14'] },
      { id: 'kitchen-table', name: 'Kitchen-table logistics', description: 'Meals, rides, school runs, insurance calls.', members: ['synth06', 'synth10', 'synth14', 'synth16', 'synth08'] },
      { id: 'grief-slowly', name: 'Grief, slowly', description: 'For after. No timeline.', members: ['synth02', 'synth10', 'synth06'] },
    ],
  },
  {
    id: 'personal',
    name: 'Personal',
    description: 'A shared room for a note of your own.',
    groups: [
      {
        id: 'daily-check-in',
        name: 'Daily check-in',
        description: 'One note a day: how you are, what is on your mind, and a step you might take.',
        members: PEOPLE.map((p) => p.uid),
      },
    ],
  },
]

const CONNECTIONS: [string, string, 'accepted' | 'pending'][] = [
  ['synth03', 'synth04', 'accepted'],
  ['synth03', 'synth08', 'accepted'],
  ['synth04', 'synth05', 'accepted'],
  ['synth05', 'synth11', 'accepted'],
  ['synth06', 'synth16', 'accepted'],
  ['synth06', 'synth14', 'accepted'],
  ['synth07', 'synth11', 'accepted'],
  ['synth07', 'synth09', 'accepted'],
  ['synth08', 'synth14', 'accepted'],
  ['synth10', 'synth14', 'accepted'],
  ['synth02', 'synth03', 'accepted'],
  ['synth09', 'synth03', 'pending'],
  ['synth12', 'synth05', 'pending'],
]

const POSTS = [
  { group: 'late-night-caregivers', author: 'synth03', title: 'The 2am shift', body: 'Anyone else find the house is loudest at 2am? I’ve started writing the next day’s list then, so I’m not carrying it to bed. (sample)', comments: [['synth08', 'Same. I keep a notebook by the kettle now. (sample)'], ['synth02', 'Writing it down is a good way to set it down for a few hours. (sample)']] },
  { group: 'late-night-caregivers', author: 'synth09', body: 'Small win: I asked my neighbour to take the bins out on Thursdays and she said yes straight away. (sample)', comments: [['synth14', 'That is not small. (sample)']] },
  { group: 'far-away', author: 'synth05', title: 'Calls that go nowhere', body: 'How do you all handle calls where Mum just wants to talk about the weather? I want to help and I don’t know what to ask. (sample)', comments: [['synth11', 'I let the weather be the visit. Sometimes that is the point. (sample)']] },
  { group: 'after-appointments', author: 'synth10', body: 'Bring a second person if you can, or put your phone on speaker for someone at home. I never remember the second half. (sample)', comments: [] },
  { group: 'siblings', author: 'synth07', body: 'Nobody asks how the siblings are doing. So: how are you doing? (sample)', comments: [['synth11', 'Tired, honestly. Thanks for asking. (sample)']] },
  { group: 'kitchen-table', author: 'synth14', title: 'Soup rota', body: 'We made a shared list of who brings dinner which night. Tuesday is still empty if anyone local reads this. (sample)', comments: [['synth16', 'I can take a Tuesday next month. (sample)']] },
  { group: 'waiting-rooms', author: 'synth16', body: 'Things in my waiting-room bag: charger, crackers, a jumper, a printed list of meds. What’s in yours? (sample)', comments: [['synth06', 'Earplugs and a pen that works. (sample)']] },
  // Held by automod: an outside link, to give the review queue something to show
  { group: 'kitchen-table', author: 'synth12', body: 'Great deals on supplements at cheap-pills-direct.xyz (sample)', comments: [] },
]

const GROUP_MESSAGES = [
  ['late-night-caregivers', 'synth04', 'Still up. Chemo day tomorrow. (sample)'],
  ['late-night-caregivers', 'synth08', 'Here too. Want company for a bit? (sample)'],
  ['late-night-caregivers', 'synth03', 'Pulling up a chair. (sample)'],
  ['kitchen-table', 'synth06', 'Does anyone have a good way to track medication times? (sample)'],
  ['kitchen-table', 'synth10', 'A whiteboard on the fridge, honestly. (sample)'],
  ['siblings', 'synth11', 'Checking in on everyone this week. (sample)'],
] as const

const DMS = [
  ['synth03', 'synth04', 'Thinking of you tomorrow. Text me after if you want. (sample)'],
  ['synth04', 'synth03', 'Thank you. I will. (sample)'],
  ['synth06', 'synth16', 'Coffee on Saturday? Just us, no hospital talk. (sample)'],
] as const

const minutesAgo = (m: number) => Timestamp.fromMillis(Date.now() - m * 60_000)
const pairId = (a: string, b: string) => [a, b].sort().join('_')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const waitFor = async (check: () => Promise<boolean>, label: string, tries = 40) => {
  for (let i = 0; i < tries; i++) {
    if (await check()) return
    await sleep(500)
  }
  console.warn(`  … gave up waiting for ${label} (are the functions emulator and triggers running?)`)
}

// Real (non-sample) profiles survive a reseed so testers keep their pen name
const keepRealProfiles = async () => {
  const real = (await db.collection('users').get()).docs.filter((d) => d.data().synthetic !== true)
  return async () => {
    for (const d of real) {
      await d.ref.set(d.data())
      const lower = d.data().penNameLower
      if (typeof lower === 'string') await db.doc(`penNames/${lower}`).set({ uid: d.id })
      const shape = shapeOf(d.data().penName)
      if (shape) await db.doc(`penNameShapes/${shape}`).set({ uid: d.id })
    }
    if (real.length > 0) console.log(`  kept ${real.length} real profile(s)`)
  }
}

// Re-runnable: wipe emulator Firestore first (auth users are replaced one by one below)
const clearFirestore = async () => {
  const url = `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`
  const response = await fetch(url, { method: 'DELETE' })
  if (!response.ok) throw new Error(`Could not clear the Firestore emulator (${response.status})`)
}

const seedPeople = async () => {
  for (const p of PEOPLE) {
    await auth.deleteUser(p.uid).catch(() => undefined)
    await auth.createUser({
      uid: p.uid,
      email: `${p.uid}@example.test`,
      emailVerified: p.verified !== false,
      password: SAMPLE_PASSWORD,
    })
    const claims = { ...(p.admin ? { admin: true } : {}), ...(p.pro ? { pro: true } : {}) }
    if (Object.keys(claims).length > 0) await auth.setCustomUserClaims(p.uid, claims)

    const lower = p.penName.toLowerCase()
    await db.doc(`penNames/${lower}`).set({ uid: p.uid })
    await db.doc(`penNameShapes/${shapeOf(p.penName) ?? lower}`).set({ uid: p.uid })
    await db.doc(`users/${p.uid}`).set({
      penName: p.penName,
      penNameLower: lower,
      note: p.note,
      avatarSeed: p.uid,
      pigment: p.pigment,
      pro: p.pro === true,
      ...(p.pro ? { proSince: minutesAgo(60 * 24 * 30) } : {}),
      banned: false,
      synthetic: true,
      createdAt: minutesAgo(60 * 24 * 40),
      updatedAt: minutesAgo(60 * 24 * 40),
    })
  }
  console.log(`  ${PEOPLE.length} synthetic people`)
}

const seedGroups = async (meUid?: string) => {
  for (const [order, c] of CONSTELLATIONS.entries()) {
    await db.doc(`constellations/${c.id}`).set({ name: c.name, description: c.description, order, synthetic: true })
    for (const g of c.groups) {
      await db.doc(`groups/${g.id}`).set({
        name: g.name,
        description: g.description,
        constellationId: c.id,
        constellationName: c.name,
        createdBy: 'synth01',
        createdAt: minutesAgo(60 * 24 * 60),
        synthetic: true,
      })
      const withMe = meUid && (g.id === 'daily-check-in' || ['late-night-caregivers', 'kitchen-table'].includes(g.id))
      const members = withMe ? [...g.members, meUid] : g.members
      for (const uid of members) {
        await db.doc(`groups/${g.id}/members/${uid}`).set({ uid, joinedAt: minutesAgo(60 * 24 * 20) })
      }
    }
  }
  console.log(`  ${CONSTELLATIONS.length} constellations, ${CONSTELLATIONS.flatMap((c) => c.groups).length} groups`)
}

const seedConnections = async (meUid?: string) => {
  const all: [string, string, 'accepted' | 'pending'][] = [
    ...CONNECTIONS,
    ...(meUid ? ([['synth08', meUid, 'pending'], ['synth14', meUid, 'pending']] as [string, string, 'pending'][]) : []),
  ]
  for (const [requester, recipient, status] of all) {
    const uids = [requester, recipient].sort()
    await db.doc(`connections/${pairId(requester, recipient)}`).set({
      uids,
      requester,
      recipient,
      status,
      createdAt: minutesAgo(60 * 24 * 10),
      updatedAt: minutesAgo(60 * 24 * 9),
    })
  }
  console.log(`  ${all.length} connections`)
}

// Writing goes in pending, exactly like the app, so the moderation triggers publish it
const seedWriting = async () => {
  let age = 60 * 24 * 6
  const commentRefs: FirebaseFirestore.DocumentReference[] = []
  for (const post of POSTS) {
    age -= 180
    const postRef = db.collection(`groups/${post.group}/posts`).doc()
    await postRef.set({
      authorUid: post.author,
      ...(post.title ? { title: post.title } : {}),
      body: post.body,
      status: 'pending',
      createdAt: minutesAgo(age),
    })
    await waitFor(async () => (await postRef.get()).data()?.status !== 'pending', `post ${postRef.id}`)
    if ((await postRef.get()).data()?.status !== 'published') continue
    for (const [i, [author, text]] of post.comments.entries()) {
      const ref = postRef.collection('comments').doc()
      await ref.set({ authorUid: author, text, status: 'pending', createdAt: minutesAgo(age - 20 * (i + 1)) })
      commentRefs.push(ref)
    }
    const group = CONSTELLATIONS.flatMap((c) => c.groups).find((g) => g.id === post.group)
    for (const uid of (group?.members ?? []).filter((u) => u !== post.author).slice(0, 3)) {
      await postRef.collection('likes').doc(uid).set({ uid, createdAt: minutesAgo(age - 5) })
    }
  }

  for (const [i, [group, author, text]] of GROUP_MESSAGES.entries()) {
    await db.collection(`groups/${group}/messages`).add({ authorUid: author, text, status: 'pending', createdAt: minutesAgo(90 - i * 6) })
  }

  for (const [i, [from, to, text]] of DMS.entries()) {
    await db.collection(`dms/${pairId(from, to)}/messages`).add({ authorUid: from, text, status: 'pending', createdAt: minutesAgo(300 - i * 30) })
  }

  console.log(`  ${POSTS.length} posts, ${commentRefs.length} comments, ${GROUP_MESSAGES.length} group messages, ${DMS.length} private messages`)
  return commentRefs
}

const seedReport = async (comment: FirebaseFirestore.DocumentReference) => {
  await waitFor(async () => (await comment.get()).data()?.status === 'published', 'a published comment')
  await db.collection('reports').add({
    reporterUid: 'synth09', // must be a member who could see it, or the report is dropped
    contentPath: comment.path,
    reason: 'other',
    details: 'Sample report so the review queue shows how reports look. (sample)',
    createdAt: FieldValue.serverTimestamp(),
  })
  console.log('  1 report')
}

const seedProApplication = async () => {
  const pdf = Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 400 120]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n' +
      '4 0 obj<</Length 66>>stream\nBT /F1 14 Tf 20 60 Td (SAMPLE DOCUMENT - NOT A REAL LICENSE) Tj ET\nendstream endobj\n' +
      '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
  )
  await bucket.file('proDocs/synth03/doc-1').save(pdf, { contentType: 'application/pdf' })
  await db.doc('proApplications/synth03').set({
    uid: 'synth03',
    status: 'submitted',
    legalName: 'Sample Applicant',
    licenseType: 'counselor',
    licenseRegion: 'Sample State',
    licenseNumber: 'SAMPLE-0000',
    files: ['doc-1'],
    statement: 'Sample application so the admin review screen has something to show. (sample)',
    submittedAt: minutesAgo(60 * 5),
  })
  console.log('  1 professional application (sample PDF)')
}

// Counters are trigger-maintained; after a bulk seed, set them from the source of truth
const recount = async () => {
  await sleep(3000)
  for (const group of (await db.collection('groups').get()).docs) {
    const members = await group.ref.collection('members').count().get()
    await group.ref.update({ memberCount: members.data().count })
    for (const post of (await group.ref.collection('posts').get()).docs) {
      const likes = await post.ref.collection('likes').count().get()
      const comments = await post.ref.collection('comments').where('status', '==', 'published').count().get()
      await post.ref.update({ likeCount: likes.data().count, commentCount: comments.data().count })
    }
  }
  console.log('  counters recounted')
}

// Your own account, if it has a pen name: one @mention in a group it joined, so Notifications has a ping
const seedMentionForMe = async (meUid: string) => {
  const penName: string | undefined = (await db.doc(`users/${meUid}`).get()).data()?.penName
  if (!penName) return
  const ref = db.collection('groups/kitchen-table/messages').doc()
  await ref.set({
    authorUid: 'synth14',
    text: `@${penName} we saved you a seat for Thursday’s soup rota. (sample)`,
    mentions: [meUid],
    status: 'pending',
    createdAt: minutesAgo(30),
  })
  await waitFor(async () => (await ref.get()).data()?.status !== 'pending', `mention ${ref.id}`)
  console.log(`  1 mention for ${penName}`)
}

const main = async () => {
  const meUid = process.env.SEED_ME_UID?.trim() || undefined
  console.log(`Seeding ${PROJECT_ID}${meUid ? ` (joining ${meUid})` : ''}…`)
  const restore = await keepRealProfiles()
  await clearFirestore()
  await sleep(5000) // let delete-triggers from the old data drain before reusing ids
  await restore()
  await seedPeople()
  await seedGroups(meUid)
  await seedConnections(meUid)
  const comments = await seedWriting()
  if (meUid) await seedMentionForMe(meUid)
  if (comments[0]) await seedReport(comments[0])
  await seedProApplication()
  await recount()
  console.log(`Done. Sample accounts: synth01…synth16 @example.test (synth01 admin, synth02 licensed).`)
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error)
    process.exit(1)
  },
)
