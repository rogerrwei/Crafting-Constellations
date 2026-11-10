/*
 * One-off: records the name each saved pen name passes for (penNameShapes), for names saved
 * before saveProfile kept them. Until then, a lookalike of an older name can still be had by
 * spelling it the plain way ("O'Neil" after "OʼNeil", "Joy" after Cyrillic "Јоу"). penNames
 * keys are left as they are. Safe to run again: it only adds what is missing.
 *
 * Retired names go first, so a name a moderator retired stays blocked in every spelling. Then
 * each profile's name, the earliest profile first where two pass for the same name; the others
 * keep their names and are listed for a moderator to look at. A retired name kept only its
 * lowercase key, so its shape is read from that.
 *
 * Emulator by default; --dry-run counts and changes nothing.
 *   npx tsx scripts/backfill-pen-name-shapes.ts --dry-run
 * For a real project: set GOOGLE_APPLICATION_CREDENTIALS, then add --prod --project <id>.
 */
import { initializeApp } from 'firebase-admin/app'
import { getFirestore, type DocumentData } from 'firebase-admin/firestore'
import { shapeOf } from '../functions/src/profilePolicy.js'

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const prod = args.includes('--prod')
const dryRun = args.includes('--dry-run')
const projectId = flag('project') ?? 'demo-crafting-constellations'

if (!prod) process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080'
if (prod && projectId.startsWith('demo-')) throw new Error('Pass --project <real-project-id> with --prod.')

initializeApp({ projectId })
const db = getFirestore()

// gRPC status for a create() that finds the document there (a save made it meanwhile)
const ALREADY_EXISTS = 6

interface Claim {
  shape: string
  record: { uid: string } | { retired: true }
  // Who or what wants it, for the list of names two people pass for
  label: string
}

const sameRecord = (a: DocumentData | undefined, b: Claim['record']) =>
  a !== undefined && ('retired' in b ? a.retired === true : a.uid === b.uid)

const main = async () => {
  const [retired, profiles, existing] = await Promise.all([
    db.collection('penNames').where('retired', '==', true).get(),
    db.collection('users').get(),
    db.collection('penNameShapes').get(),
  ])
  const millis = (d: { get: (field: string) => unknown }) => (d.get('createdAt') as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0
  const wanted: Claim[] = [
    ...retired.docs.flatMap((d) => {
      const shape = shapeOf(d.id)
      return shape ? [{ shape, record: { retired: true as const }, label: `retired "${d.id}"` }] : []
    }),
    ...[...profiles.docs]
      .sort((a, b) => millis(a) - millis(b))
      .flatMap((d) => {
        const shape = shapeOf(d.get('penName'))
        return shape ? [{ shape, record: { uid: d.id }, label: `${d.id} ("${d.get('penName')}")` }] : []
      }),
  ]

  // First come, by the order above; whatever is there already stays
  const held = new Map<string, DocumentData>(existing.docs.map((d) => [d.id, d.data()]))
  const holder = new Map<string, string>(existing.docs.map((d) => [d.id, d.get('uid') ?? 'retired']))
  const toAdd: Claim[] = []
  const clashes: string[] = []
  for (const claim of wanted) {
    const there = held.get(claim.shape)
    if (there === undefined) {
      held.set(claim.shape, claim.record)
      holder.set(claim.shape, claim.label)
      toAdd.push(claim)
    } else if (!sameRecord(there, claim.record)) {
      clashes.push(`"${claim.shape}": ${claim.label} passes for the same name as ${holder.get(claim.shape)}`)
    }
  }

  console.log(`${projectId}: ${toAdd.length} names to record (${retired.size} retired names, ${profiles.size} profiles, ${existing.size} recorded already).`)
  clashes.forEach((line) => console.log(`  kept as they are: ${line}`))
  if (dryRun) return

  const writer = db.bulkWriter()
  const results = toAdd.map((claim) =>
    writer.create(db.doc(`penNameShapes/${claim.shape}`), claim.record).then(
      () => undefined,
      (error: { code?: number }) => {
        if (error.code !== ALREADY_EXISTS) throw error
        console.log(`  kept as they are: "${claim.shape}" was recorded meanwhile, before ${claim.label}`)
      },
    ),
  )
  await writer.close()
  await Promise.all(results)
  console.log('Recorded.')
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
