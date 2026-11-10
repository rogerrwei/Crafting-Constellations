import { FieldValue, type DocumentData, type DocumentReference, type QueryDocumentSnapshot, type Timestamp, type Transaction } from 'firebase-admin/firestore'
import { defineList } from 'firebase-functions/params'
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https'
import { approvalOf, crisisOnPublish, leftAsIs, licenceOpen, moderatorNote, outcomeOf, removalOf, type Outcome, type Removal } from './adminPolicy.js'
import { auth, closeAll, db, logAction, logActionIn, NOT_FOUND, snapshotOf } from './app.js'
import { userOrNone } from './localBackendPolicy.js'
import { checkPenName } from './moderation/index.js'
import { applyNotices, planNotices } from './notify.js'
import { callable } from './options.js'
import { freeName } from './profile.js'
import { reportedName, reportedShape, resetNames, shapeOf } from './profilePolicy.js'

const ADMIN_EMAILS = defineList('ADMIN_EMAILS', { default: [] })

// The token says what the role was when it was made, up to an hour ago: a moderator whose role
// was removed since still holds one that says admin, so ask Auth too
const requireAdmin = async (request: CallableRequest) => {
  if (request.auth?.token.admin !== true) throw new HttpsError('permission-denied', 'Admins only.')
  const { uid } = request.auth
  if ((await auth.getUser(uid)).customClaims?.admin !== true) throw new HttpsError('permission-denied', 'Admins only.')
  return uid
}

// A moderator's own case (their writing, their profile, their licence) is another moderator's to
// decide: what reporters wrote is kept from them, and a licence is checked by someone else
const notTheirOwn = (actor: string, uid: unknown) => {
  if (uid === actor) throw new HttpsError('permission-denied', 'Ask another moderator.', { problem: 'self' })
}

const str = (value: unknown, name: string, max = 200) => {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new HttpsError('invalid-argument', name)
  }
  return value.trim()
}

// Claims are merged, never replaced: setCustomUserClaims overwrites everything. Gives the claims before
const mergeClaims = async (uid: string, patch: Record<string, unknown>) => {
  const current = (await auth.getUser(uid)).customClaims ?? {}
  await auth.setCustomUserClaims(uid, { ...current, ...patch })
  return current
}

const notice = (type: string, extra: Record<string, unknown> = {}) => ({ type, ...extra, createdAt: FieldValue.serverTimestamp(), seen: false })

// What a moderator takes down stays readable to its writer, and a uid is enough to find the person
// behind it, so it says only that a moderator did (as automod's say 'automod'). Who it was is kept
// where only moderators read: the queue entry, the ban and adminActions
const removedByModerator = (now: FieldValue) => ({ status: 'removed', removedBy: 'moderator', removedAt: now })

// Reset a reported profile to a quiet generated name and clear the note. The name
// it was reported under is retired, not freed, so nobody can take it again, the
// person included, even if they've renamed since (see resetNames), and so is the
// name it passes for (penNameShapes), so no lookalike spelling of it can be had
// either. The retired records are the name alone: account deletion leaves them,
// and nothing in them points back at them. Gives the new name, or null when the
// account is gone. With no free name to give, changes nothing and says so.
const resetProfile = async (tx: Transaction, queued: DocumentData, now: FieldValue) => {
  const uid: string = queued.authorUid
  const profile = (await tx.get(db.doc(`users/${uid}`))).data()
  if (!profile) return null
  const current = typeof profile.penNameLower === 'string' && profile.penNameLower ? profile.penNameLower : undefined
  const reported = reportedName(queued.authorPenName, current)
  const shapes = { reported: reportedShape(queued.authorPenName, profile.penName), current: shapeOf(profile.penName) }
  // Every read before the first write: who holds each name and shape now, then a free one to give them
  const readAll = async (collection: string, keys: (string | undefined)[]) =>
    new Map(
      await Promise.all(
        [...new Set(keys)].filter((key): key is string => key !== undefined).map(async (key) => [key, (await tx.get(db.doc(`${collection}/${key}`))).data()] as const),
      ),
    )
  const [records, shapeRecords] = await Promise.all([readAll('penNames', [reported, current]), readAll('penNameShapes', [shapes.reported, shapes.current])])
  // Not one of the names being retired or freed here, however its records read
  const name = await freeName(tx, new Set([...records.keys(), ...shapeRecords.keys()]))
  if (!name) throw new HttpsError('resource-exhausted', 'pen-name', { problem: 'no-free-name' })
  const names = resetNames(uid, reported, current, records)
  const passesFor = resetNames(uid, shapes.reported, shapes.current, shapeRecords)
  if (names.retire) tx.set(db.doc(`penNames/${names.retire}`), { retired: true })
  if (names.free) tx.delete(db.doc(`penNames/${names.free}`))
  if (passesFor.retire) tx.set(db.doc(`penNameShapes/${passesFor.retire}`), { retired: true })
  if (passesFor.free) tx.delete(db.doc(`penNameShapes/${passesFor.free}`))
  tx.set(db.doc(`penNames/${name.toLowerCase()}`), { uid })
  tx.set(db.doc(`penNameShapes/${shapeOf(name) ?? name.toLowerCase()}`), { uid })
  tx.update(db.doc(`users/${uid}`), { penName: name, penNameLower: name.toLowerCase(), note: '', updatedAt: now })
  return name
}

const ignoreMissing = (error: { code?: number }) => {
  if (error.code !== NOT_FOUND) throw error
}

// Writing keeps the name and mark it went out with, but a reset is there to take the
// name out of view, and a revoke the mark: put what they show now on everything they
// wrote (held writing too, so approving it later can't bring the old back) and on the
// notices they caused. Given a time, only on what was written by then: anything newer
// went out with what they showed when it did
const refreshWriting = async (uid: string, shown: { penName?: string; pro?: boolean }, by?: Timestamp) => {
  const [writing, notices] = await Promise.all([
    Promise.all(['posts', 'comments', 'messages'].map((group) => db.collectionGroup(group).where('authorUid', '==', uid).get())),
    db.collectionGroup('notices').where('actorUid', '==', uid).get(),
  ])
  const writtenBy = (d: QueryDocumentSnapshot) => {
    const at = d.get('createdAt')
    return !by || typeof at?.toMillis !== 'function' || at.toMillis() <= by.toMillis()
  }
  const writer = db.bulkWriter()
  // Only what it shows differently. Writing still pending has nothing on it yet, and
  // takes what they show now as it goes out
  const refresh = (snapshot: 'author' | 'actor') => (d: QueryDocumentSnapshot) => {
    const stale = Object.entries(shown).filter(([field, value]) => {
      const was = d.get(`${snapshot}.${field}`)
      return was !== undefined && was !== value
    })
    return stale.length === 0 || !writtenBy(d) ? [] : [writer.update(d.ref, Object.fromEntries(stale.map(([field, value]) => [`${snapshot}.${field}`, value])))]
  }
  const results = [
    ...writing.flatMap((s) => s.docs).flatMap(refresh('author')),
    ...notices.docs.flatMap(refresh('actor')),
  ].map((result) => result.catch(ignoreMissing)) // deleted meanwhile, with someone else's account
  await closeAll(writer, results)
}

// A reset's new name goes on the writing they already had out after the decision is in, and that
// can fail part way, or the process can stop. So the decision keeps what is left to do on its
// queue entry (writingRefresh), and this does it, then says so: safe to run again, and run until
// it is done, by Remove pressed again and by finishRefreshes. Only the refresh that is still the
// entry's is marked done: the profile may have been reported and reset again meanwhile
const finishRefresh = async (queueRef: DocumentReference) => {
  const queued = (await queueRef.get()).data()
  const refresh = queued?.writingRefresh
  if (!queued || refresh?.state !== 'pending') return
  await refreshWriting(queued.authorUid, { penName: refresh.penName }, refresh.at)
  await db.runTransaction(async (tx) => {
    const now = (await tx.get(queueRef)).get('writingRefresh')
    if (now?.state === 'pending' && now.at?.isEqual?.(refresh.at)) tx.update(queueRef, { 'writingRefresh.state': 'done' })
  })
}

// Resets whose refresh was left undone (a failure part way, a stop), finished. Only ones left a
// while, so a Remove still at its own isn't doubled. Each is tried; a failure waits for the next round
export const finishRefreshes = async (leftForMs = 2 * 60_000) => {
  const pending = await db.collection('modQueue').where('writingRefresh.state', '==', 'pending').get()
  const cutoff = pending.readTime.toMillis() - leftForMs
  const left = pending.docs.filter((d) => (d.get('writingRefresh.at')?.toMillis?.() ?? 0) <= cutoff)
  const failed = (await Promise.allSettled(left.map((d) => finishRefresh(d.ref)))).filter((result) => result.status === 'rejected')
  if (failed.length > 0) throw (failed[0] as PromiseRejectedResult).reason
  return left.length
}

// ---------- review queue ----------

// Approve and Remove answer with what came of them, for the moderator's page (see Outcome)

// Approve queued writing that is still held or waiting, and say what came of it
const approveHeld = async (tx: Transaction, queued: DocumentData, now: FieldValue): Promise<Outcome> => {
  const contentRef = db.doc(queued.contentPath)
  const content = (await tx.get(contentRef)).data()
  if (!content || !['held', 'pending'].includes(content.status)) return leftAsIs(content?.status)
  // Every read goes before the first write: whether it can still reach its readers, then who it pings
  const [ban, connection, chat] = await Promise.all([
    tx.get(db.doc(`bans/${content.authorUid}`)),
    queued.kind === 'dm' ? tx.get(db.doc(`connections/${queued.pairId}`)) : undefined,
    queued.kind === 'chatMessage' ? tx.get(db.doc(`chats/${queued.chatId}`)) : undefined,
  ])
  const approval = approvalOf({
    kind: queued.kind,
    authorUid: content.authorUid,
    publishedAt: content.publishedAt,
    authorBanned: ban.exists,
    undelivered: content.undelivered,
    connectionStatus: connection?.data()?.status,
    chatUids: chat?.data()?.uids,
  })
  if (approval === 'restore') tx.update(contentRef, { status: 'published' })
  // It stays held, and its writer sees it won't arrive, not that it still waits for a person
  if (approval === 'undeliverable' || approval === 'paused') tx.update(contentRef, { undelivered: true })
  if (approval !== 'publish') return outcomeOf(approval)

  // Writing held before it went out pings nobody until now
  const notices = await planNotices(tx, queued.contentPath, content, content.author ?? snapshotOf(content.authorUid, undefined))
  tx.update(contentRef, {
    status: 'published',
    publishedAt: now,
    ...(crisisOnPublish({ kind: queued.kind, heldReason: content.heldReason, automodCrisis: queued.automod?.crisis }) ? { crisis: true } : {}),
    ...(notices.mentioned.length > 0 ? { mentioned: notices.mentioned } : {}),
  })
  applyNotices(tx, notices)
  if (queued.kind === 'dm') {
    tx.set(db.doc(`dms/${queued.pairId}`), { uids: String(queued.pairId).split('_'), lastMessageAt: now, lastAuthorUid: queued.authorUid }, { merge: true })
  }
  if (queued.kind === 'chatMessage') {
    tx.update(db.doc(`chats/${queued.chatId}`), { lastMessageAt: now, lastAuthorUid: queued.authorUid })
  }
  return outcomeOf(approval)
}

export const approveContent = onCall<{ queueId: string }>(callable(), async (request) => {
  const actor = await requireAdmin(request)
  const queueRef = db.doc(`modQueue/${str(request.data?.queueId, 'queueId', 1500)}`)

  // As with Remove, a second moderator (or a retry) finds the entry resolved and changes nothing
  const outcome = await db.runTransaction(async (tx): Promise<Outcome> => {
    const queued = (await tx.get(queueRef)).data()
    if (!queued) throw new HttpsError('not-found', 'queue item')
    if (queued.state !== 'open') return 'already-resolved'
    notTheirOwn(actor, queued.authorUid)
    const now = FieldValue.serverTimestamp()
    const outcome = queued.kind === 'profile' ? 'kept' : await approveHeld(tx, queued, now)
    // Writing that can no longer reach its readers stays held, and still leaves the queue
    const resolution = outcome === 'undelivered' || outcome === 'paused' ? 'approved-undelivered' : 'approved'
    tx.update(queueRef, { state: 'resolved', resolution, resolvedBy: actor, resolvedAt: now, updatedAt: now })
    return outcome
  })

  if (outcome !== 'already-resolved') await logAction(actor, 'approveContent', request.data.queueId, { outcome })
  return { ok: true, outcome }
})

// Take down queued writing, or reset a queued profile, as Remove says. A reset
// also gives the new name, for the writing the person already has out.
const takeDown = async (tx: Transaction, queued: DocumentData, now: FieldValue): Promise<{ removal: Removal; penName?: string }> => {
  if (queued.kind === 'profile') {
    const penName = await resetProfile(tx, queued, now)
    return penName ? { removal: 'remove', penName } : { removal: 'gone' }
  }
  const contentRef = db.doc(queued.contentPath)
  const removal = removalOf((await tx.get(contentRef)).data()?.status)
  if (removal === 'remove') tx.update(contentRef, removedByModerator(now))
  return { removal }
}

export const removeContent = onCall<{ queueId: string; note?: string }>(callable(), async (request) => {
  const actor = await requireAdmin(request)
  const queueId = str(request.data?.queueId, 'queueId', 1500)
  const queueRef = db.doc(`modQueue/${queueId}`)
  const note = moderatorNote(request.data?.note)

  // One transaction, so a second moderator (or a retry) finds the entry resolved and does nothing
  // twice, and the decision is never without its line in the audit log
  const done = await db.runTransaction(async (tx) => {
    const queued = (await tx.get(queueRef)).data()
    if (!queued) throw new HttpsError('not-found', 'queue item')
    if (queued.state !== 'open') return null
    notTheirOwn(actor, queued.authorUid)
    const now = FieldValue.serverTimestamp()
    const { removal, penName } = await takeDown(tx, queued, now)
    tx.update(queueRef, {
      state: 'resolved',
      resolution: removal === 'withdrawn' ? 'withdrawn' : 'removed',
      resolvedBy: actor,
      resolvedAt: now,
      updatedAt: now,
      // What the reset leaves to do: the new name on what they already wrote (finishRefresh)
      ...(penName ? { writingRefresh: { penName, at: now, state: 'pending' } } : {}),
    })
    // Only the writer of something a moderator took down hears about it
    if (removal === 'remove') {
      tx.set(db.collection(`users/${queued.authorUid}/notices`).doc(), notice('removed', { contentPath: queued.contentPath, ...(note ? { note } : {}) }))
    }
    logActionIn(tx, actor, 'removeContent', queueId, { note, removal })
    return { removal }
  })

  // Decided here or before: a reset's refresh an earlier try left undone is finished now, without
  // a second reset or notice. Writing that goes out from now on takes the new name itself
  await finishRefresh(queueRef)
  return done ? { ok: true, outcome: outcomeOf(done.removal) } : { ok: true, outcome: 'already-resolved' }
})

// ---------- people ----------

export const banUser = onCall<{ uid: string; reason: string; hideContent?: boolean }>(callable(), async (request) => {
  const actor = await requireAdmin(request)
  const uid = str(request.data?.uid, 'uid', 128)
  const reason = str(request.data?.reason, 'reason', 500)
  if (uid === actor) throw new HttpsError('failed-precondition', 'You cannot ban yourself.')
  const target = await auth.getUser(uid)
  if (target.customClaims?.admin === true) throw new HttpsError('failed-precondition', 'Remove admin first.', { problem: 'admin' })

  const now = FieldValue.serverTimestamp()
  await db.doc(`bans/${uid}`).set({ uid, reason, bannedBy: actor, createdAt: now })
  await mergeClaims(uid, { banned: true })
  await auth.updateUser(uid, { disabled: true })
  await auth.revokeRefreshTokens(uid)
  // Only a profile that is there: one deleted meanwhile (an account leaving) must not come back nameless
  await db.doc(`users/${uid}`).update({ banned: true, updatedAt: now }).catch(ignoreMissing)

  const writer = db.bulkWriter()
  const memberships = await db.collectionGroup('members').where('uid', '==', uid).get()
  memberships.docs.forEach((d) => writer.delete(d.ref))
  const chats = await db.collection('chats').where('uids', 'array-contains', uid).get()
  chats.docs.forEach((d) => writer.update(d.ref, { uids: FieldValue.arrayRemove(uid) }))

  if (request.data.hideContent) {
    for (const group of ['posts', 'comments', 'messages']) {
      const items = await db.collectionGroup(group).where('authorUid', '==', uid).get()
      items.docs
        .filter((d) => ['published', 'pending', 'held'].includes(d.data().status))
        .forEach((d) => writer.update(d.ref, removedByModerator(now)))
    }
  }
  await writer.close()

  await logAction(actor, 'banUser', uid, { reason, hideContent: Boolean(request.data.hideContent) })
  return { ok: true }
})

export const unbanUser = onCall<{ uid: string }>(callable(), async (request) => {
  const actor = await requireAdmin(request)
  const uid = str(request.data?.uid, 'uid', 128)
  await db.doc(`bans/${uid}`).delete()
  await mergeClaims(uid, { banned: false })
  await auth.updateUser(uid, { disabled: false })
  await db.doc(`users/${uid}`).update({ banned: false, updatedAt: FieldValue.serverTimestamp() }).catch(ignoreMissing)
  await logAction(actor, 'unbanUser', uid)
  return { ok: true }
})

export const reviewProfessional = onCall<{ uid: string; decision: 'approve' | 'deny' | 'revoke'; note?: string }>(
  callable(),
  async (request) => {
    const actor = await requireAdmin(request)
    const uid = str(request.data?.uid, 'uid', 128)
    const decision = request.data?.decision
    if (!['approve', 'deny', 'revoke'].includes(decision)) throw new HttpsError('invalid-argument', 'decision')
    // Taking their own mark away is still theirs to do
    if (decision !== 'revoke') notTheirOwn(actor, uid)
    const note = typeof request.data.note === 'string' ? request.data.note.slice(0, 500) : ''
    const appRef = db.doc(`proApplications/${uid}`)
    const userRef = db.doc(`users/${uid}`)
    const pro = decision === 'approve'

    // One transaction, so a second moderator (or a stale row) finds it decided and changes nothing,
    // and nothing is written for someone whose profile is gone: an account being deleted loses its
    // profile first and its application last, and a write between would leave a nameless profile
    const decided = await db.runTransaction(async (tx) => {
      const [application, profile] = await Promise.all([tx.get(appRef), tx.get(userRef)])
      // Seeded or hand-set pros never applied, but their mark can still be taken away
      if (!application.exists && decision !== 'revoke') throw new HttpsError('not-found', 'application')
      if (!profile.exists) throw new HttpsError('not-found', 'profile')
      if (!licenceOpen(decision, application.get('status'), profile.get('pro'))) return false
      const now = FieldValue.serverTimestamp()
      const status = decision === 'approve' ? 'approved' : decision === 'deny' ? 'denied' : 'revoked'
      // The applicant reads their application, so it never names the moderator (adminActions does),
      // and a decision takes off the name an older one left there
      if (application.exists) tx.update(appRef, { status, reviewedAt: now, reviewedBy: FieldValue.delete(), reviewNote: note })
      tx.update(userRef, { pro, ...(pro ? { proSince: now } : {}), updatedAt: now })
      if (decision !== 'revoke') tx.set(userRef.collection('notices').doc(), notice(pro ? 'proApproved' : 'proDenied', { note }))
      return true
    })

    // A profile its account outlived has no tokens left to carry the claim, but still loses the mark
    const claim = async () => {
      if (await userOrNone(auth.getUser(uid))) await mergeClaims(uid, { pro })
    }
    // Writing from now on takes the mark from the profile. Taking it away takes it off what
    // they already wrote too; an approval marks only what they write next
    const mark = async () => {
      if (!pro) await refreshWriting(uid, { pro: false })
    }

    if (!decided) {
      // The same decision again, as a retry after Auth failed or the local backend was stopped
      // part way: what follows it is safe to do again, and may not have been done. Only while the
      // profile says what this decision says, read now, as another moderator may have decided since
      const current = await userRef.get()
      if (current.exists && (current.get('pro') === true) === pro) {
        await claim()
        await mark()
      }
      return { ok: true, outcome: 'already-resolved' }
    }
    // Logged as soon as it's decided, so a failure after still leaves who decided
    await logAction(actor, 'reviewProfessional', uid, { decision })
    await claim()
    await mark()
    return { ok: true }
  },
)

export const setAdmin = onCall<{ uid: string; admin: boolean }>(callable(), async (request) => {
  const actor = await requireAdmin(request)
  const uid = str(request.data?.uid, 'uid', 128)
  if (uid === actor && request.data.admin === false) throw new HttpsError('failed-precondition', 'Ask another admin.')
  const admin = request.data.admin === true
  const was = (await mergeClaims(uid, { admin })).admin === true
  // Their tokens say admin until they expire, up to an hour, and the rules can't be told sooner.
  // Functions ask Auth (requireAdmin), and their sessions end as a ban's do: each device signs in again
  if (was && !admin) await auth.revokeRefreshTokens(uid)
  await logAction(actor, 'setAdmin', uid, { admin })
  // Whether they had the role before, which the page has no other way to know
  return { ok: true, was }
})

// First admin: a verified account whose email is listed in ADMIN_EMAILS
export const bootstrapAdmin = onCall(callable(), async (request) => {
  const token = request.auth?.token
  if (!request.auth || token?.email_verified !== true || typeof token.email !== 'string') {
    throw new HttpsError('permission-denied', 'Verify your email first.')
  }
  const allowed = ADMIN_EMAILS.value().map((e) => e.trim().toLowerCase())
  if (!allowed.includes(token.email.toLowerCase())) throw new HttpsError('permission-denied', 'Not on the admin list.')
  await mergeClaims(request.auth.uid, { admin: true })
  await logAction(request.auth.uid, 'bootstrapAdmin', request.auth.uid)
  return { ok: true }
})

// ---------- groups ----------

export const createGroup = onCall<{ name: string; constellationId: string; description?: string }>(callable(), async (request) => {
  const actor = await requireAdmin(request)
  const name = str(request.data?.name, 'name', 60)
  const description = typeof request.data.description === 'string' ? request.data.description.slice(0, 280) : ''
  const constellationId = str(request.data?.constellationId, 'constellationId', 80)
  const constellation = (await db.doc(`constellations/${constellationId}`).get()).data()
  if (!constellation) throw new HttpsError('not-found', 'constellation')
  // Named like a chat: a group can't pass for a person ("Night-shift nurses")
  if (!checkPenName(name, { chat: true }).ok) throw new HttpsError('invalid-argument', 'name')

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'group'
  const ref = db.collection('groups').doc(`${slug}-${Math.random().toString(36).slice(2, 6)}`)
  await ref.set({
    name,
    description,
    constellationId,
    constellationName: constellation.name,
    memberCount: 0,
    createdBy: actor,
    createdAt: FieldValue.serverTimestamp(),
    synthetic: false,
  })
  await logAction(actor, 'createGroup', ref.id)
  return { ok: true, id: ref.id }
})
