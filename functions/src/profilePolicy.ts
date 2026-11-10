import { tidyPenName } from './moderation/index.js'
import { penNameShape } from './moderation/penName.js'

// Firebase-free rules for pen names (saveProfile, and a moderator's Reset profile), kept
// apart so they can be unit tested

// penNames/{lower}: { uid } while someone goes by the name, { retired: true } once a
// moderator retired it (Reset profile). penNameShapes/{shape} is the same for the name a
// pen name passes for (penNameShape), so "OʼNeil" and "O'Neil", or "Јоу" and "Joy", are
// one name whichever is claimed first; penNames keys stay as they were
export interface NameRecord {
  uid?: unknown
  retired?: unknown
}

// A rename frees the name it leaves only while that name is still the person's own:
// never a retired record, the only thing keeping a reported name from being taken
// back, and never a claim someone else holds
export const mayRelease = (record: NameRecord | undefined, uid: string) => record?.retired !== true && record?.uid === uid

// What keeps a name from someone: a moderator retired it, or someone else holds it
export const barredBy = (records: readonly (NameRecord | undefined)[], uid: string): 'unkind' | 'taken' | undefined => {
  if (records.some((record) => record?.retired === true)) return 'unkind'
  if (records.some((record) => record?.uid !== undefined && record.uid !== uid)) return 'taken'
  return undefined
}

// The name a saved pen name passes for, read as typed (case and all, as penNameShape reads it).
// None for a name that tidies to nothing
export const shapeOf = (penName: unknown) => (typeof penName === 'string' && tidyPenName(penName) ? penNameShape(penName) : undefined)

// The reported name's shape, from the name as the moderator was shown it, or from the name they go
// by now when the queue item kept none (as reportedName falls back)
export const reportedShape = (shown: unknown, penName: unknown) => shapeOf(shown) ?? shapeOf(penName)

// Names to try when someone needs one made up: plain ones first ("Quiet Heron"), then numbered
// ones ("Quiet Heron 42"), as there are only 400 plain ones
export const generatedNames = (suggest: () => string, rand: () => number = Math.random, count = 12) =>
  Array.from({ length: count }, (_, i) => (i < count / 2 ? suggest() : `${suggest()} ${Math.floor(rand() * 90 + 10)}`))

// The first of the names found free, each one looked up before it is given: never one nobody
// checked. None when every one is taken
export const firstFree = async (names: readonly string[], isFree: (name: string) => Promise<boolean>) => {
  for (const name of names) {
    if (await isFree(name)) return name
  }
  return undefined
}

// Reset profile retires the name the moderator was shown, as the profile was reported,
// even if the person has renamed since. A queue item that kept no name falls back to
// the name they go by now. Keys are kept as saveProfile keeps them (penNameLower)
export const reportedName = (shown: unknown, current: string | undefined) =>
  (typeof shown === 'string' ? tidyPenName(shown).toLowerCase() : '') || current

// Nobody else holds it: still theirs, already retired, or left with no record by a rename
const mayRetire = (record: NameRecord | undefined, uid: string) => record?.uid === undefined || record.uid === uid

// What Reset profile does with each name, as it moves the person to a generated one. The
// reported name is retired, unless someone else has taken it since. The name they go by
// now, if it's another, was never judged: it's freed, as a rename frees the name it leaves
export const resetNames = (uid: string, reported: string | undefined, current: string | undefined, records: ReadonlyMap<string, NameRecord | undefined>) => ({
  retire: reported !== undefined && mayRetire(records.get(reported), uid) ? reported : undefined,
  free: current !== undefined && current !== reported && mayRelease(records.get(current), uid) ? current : undefined,
})
