import { FieldValue, type Transaction } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { auth, db, PIGMENTS } from './app.js'
import { userOrNone } from './localBackendPolicy.js'
import { checkPenName, moderate, suggestPenName, tidyPenName } from './moderation/index.js'
import { callable } from './options.js'
import { barredBy, firstFree, generatedNames, mayRelease, shapeOf } from './profilePolicy.js'

interface SaveProfileInput {
  penName?: string
  note?: string
  pigment?: string
}

// A made-up name nobody holds, by its key or by the name it passes for. Read in the transaction
// that gives it (Reset profile), or before saveProfile's, which checks it again
export const freeName = async (read: Pick<Transaction, 'get'> | undefined, skip: ReadonlySet<string> = new Set()) => {
  const get = (path: string) => (read ? read.get(db.doc(path)) : db.doc(path).get())
  return firstFree(generatedNames(suggestPenName), async (name) => {
    const key = name.toLowerCase()
    const shape = shapeOf(name) ?? key
    if (skip.has(key) || skip.has(shape)) return false
    const [claim, copy] = await Promise.all([get(`penNames/${key}`), get(`penNameShapes/${shape}`)])
    return !claim.exists && !copy.exists
  })
}

const pickFreeName = async () => {
  const name = await freeName(undefined)
  if (!name) throw new HttpsError('resource-exhausted', 'Could not find a free pen name. Try one of your own.')
  return name
}

// The only writer of users/{uid}: validates, moderates, and keeps names unique
export const saveProfile = onCall<SaveProfileInput>(callable(), async (request) => {
  const uid = request.auth?.uid
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in first.')
  const [ban, user] = await Promise.all([db.doc(`bans/${uid}`).get(), userOrNone(auth.getUser(uid))])
  if (ban.exists) throw new HttpsError('permission-denied', 'This account is paused.')
  // A token outlives the account it was made for, up to an hour: ask Auth, as the local backend
  // does, so a tab left open after deleting the account can't make it a profile again
  if (!user || user.disabled) throw new HttpsError('unauthenticated', 'Sign in first.')

  const input = request.data ?? {}
  const userRef = db.doc(`users/${uid}`)
  // Only to know whether to pick them a name: the transaction reads the profile itself
  const hasProfile = (await userRef.get()).exists

  let penName: string | undefined
  if (typeof input.penName === 'string') {
    const check = checkPenName(input.penName)
    if (!check.ok) throw new HttpsError('invalid-argument', 'pen-name', { problem: check.problem })
    penName = check.value
  } else if (!hasProfile) {
    penName = await pickFreeName()
  }

  let note: string | undefined
  let crisis = false
  if (typeof input.note === 'string') {
    const tidy = input.note.trim()
    if (tidy.length > 160) throw new HttpsError('invalid-argument', 'note', { problem: 'length' })
    const verdict = moderate(tidy, { context: 'public' })
    if (verdict.crisis) crisis = true
    else if (verdict.action === 'hold') throw new HttpsError('invalid-argument', 'note', { problem: 'unkind' })
    else note = tidy
  }

  if (input.pigment !== undefined && !(PIGMENTS as readonly string[]).includes(input.pigment)) {
    throw new HttpsError('invalid-argument', 'pigment')
  }

  const saved = await db.runTransaction(async (tx) => {
    // Read here, not before: a moderator's reset that lands first is seen (or makes this
    // retry), so the name it left them is the one a rename frees, never the one it retired
    // An account being deleted takes no profile, nor a name, from a save that was already on its
    // way (it asked Auth before the deletion finished): deleteAccount marks the uid first
    const [profile, leaving] = await Promise.all([tx.get(userRef), tx.get(db.doc(`accountDeletions/${uid}`))])
    if (leaving.exists) throw new HttpsError('unauthenticated', 'Sign in first.')
    const current = profile.data()
    const lower = penName ? tidyPenName(penName).toLowerCase() : undefined
    const nameRef = lower ? db.doc(`penNames/${lower}`) : undefined
    const oldLower = typeof current?.penNameLower === 'string' ? current.penNameLower : undefined
    const oldRef = nameRef && oldLower && oldLower !== lower ? db.doc(`penNames/${oldLower}`) : undefined
    // A name drawn the same as another ("Јоу" in Cyrillic for "Joy", "OʼNeil" for "O'Neil") is
    // that name, someone else's or retired, whichever spelling came first: penNameShapes holds
    // what each name passes for, and penNames the keys of names saved before it did
    const shape = penName ? shapeOf(penName) : undefined
    const shapeRef = shape ? db.doc(`penNameShapes/${shape}`) : undefined
    const copiedRef = shape && shape !== lower ? db.doc(`penNames/${shape}`) : undefined
    const oldShape = nameRef ? shapeOf(current?.penName) : undefined
    const oldShapeRef = oldShape && oldShape !== shape ? db.doc(`penNameShapes/${oldShape}`) : undefined
    const [claim, oldClaim, shaped, copied, oldShaped] = await Promise.all(
      [nameRef, oldRef, shapeRef, copiedRef, oldShapeRef].map(async (ref) => (ref ? (await tx.get(ref)).data() : undefined)),
    )
    // A name a moderator retired (Reset profile) has no owner, and nobody gets it back. Its copies
    // aren't read for the name they already go by: one saved before copies were read stays theirs
    const problem = barredBy(lower !== oldLower ? [claim, shaped, copied] : [claim], uid)
    if (problem === 'unkind') throw new HttpsError('invalid-argument', 'pen-name', { problem: 'unkind' })
    if (problem === 'taken') throw new HttpsError('already-exists', 'pen-name', { problem: 'taken' })

    if (oldRef && mayRelease(oldClaim, uid)) tx.delete(oldRef)
    if (nameRef) tx.set(nameRef, { uid })
    if (oldShapeRef && mayRelease(oldShaped, uid)) tx.delete(oldShapeRef)
    // Theirs unless someone else's name already passes for it (only a name they kept, as above)
    if (shapeRef && !barredBy([shaped, copied], uid)) tx.set(shapeRef, { uid })

    const now = FieldValue.serverTimestamp()
    tx.set(
      userRef,
      {
        ...(penName ? { penName, penNameLower: lower } : {}),
        ...(note !== undefined ? { note } : {}),
        ...(input.pigment ? { pigment: input.pigment } : {}),
        ...(current
          ? {}
          : { pro: false, banned: false, synthetic: false, avatarSeed: uid, pigment: input.pigment ?? 'paynesBlue', note: note ?? '', createdAt: now }),
        updatedAt: now,
      },
      { merge: true },
    )
    return penName ?? current?.penName
  })

  return { ok: true, crisis, penName: saved }
})
