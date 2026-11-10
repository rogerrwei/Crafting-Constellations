import { FieldValue, Timestamp, type DocumentReference, type Query } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { confirmMatches, isPairOf, isRecentSignIn, pairOfDmPath, underPath } from './accountPolicy.js'
import { auth, closeAll, db, logAction, storage } from './app.js'
import { callable } from './options.js'

// How long the mark that an account is leaving outlasts the deletion: longer than a call already on
// its way, or a sign-in token (an hour), can still act for it. Firestore's TTL policy removes it after
const LEAVING_FOR_MS = 24 * 60 * 60_000

const refsOf = async (query: Query) => (await query.get()).docs.map((d) => d.ref)

// Plain documents (no subcollections), in parallel; rejects if any delete fails
const deleteAll = async (refs: DocumentReference[]) => {
  const writer = db.bulkWriter()
  await closeAll(writer, refs.map((ref) => writer.delete(ref)))
  return refs.length
}

const deleteTrees = async (refs: DocumentReference[]) => {
  await Promise.all(refs.map((ref) => db.recursiveDelete(ref)))
  return refs.length
}

// Everything a person leaves behind, except moderation evidence (bans, the
// audit log, reports others filed, pen names a moderator retired: those hold
// no uid, so they stay blocked), and deleteAccount's mark that they are leaving,
// which expires. Safe to run again after a partial failure.
export const purgeAccount = async (uid: string) => {
  // 1. Cut off writing first: rules need a membership, a connection, a chat seat or a profile
  const [memberships, connections, friendships, penNames, shapes, threadDocs, chats] = await Promise.all([
    refsOf(db.collectionGroup('members').where('uid', '==', uid)),
    refsOf(db.collection('connections').where('uids', 'array-contains', uid)),
    refsOf(db.collection('friendships').where('uids', 'array-contains', uid)),
    refsOf(db.collection('penNames').where('uid', '==', uid)),
    refsOf(db.collection('penNameShapes').where('uid', '==', uid)),
    refsOf(db.collection('dms').where('uids', 'array-contains', uid)),
    refsOf(db.collection('chats').where('uids', 'array-contains', uid)),
  ])
  const access = await deleteAll([...memberships, ...connections, ...friendships, ...penNames, ...shapes])
  // Private group chats carry on for everyone else; their own lines go in step 4
  await Promise.all(chats.map((ref) => ref.update({ uids: FieldValue.arrayRemove(uid) })))
  await db.recursiveDelete(db.doc(`users/${uid}`)) // with private/settings and notices

  // 2. Their posts, with the replies and likes under them: replies answer their story
  const posts = await refsOf(db.collectionGroup('posts').where('authorUid', '==', uid))
  await deleteTrees(posts)

  // 3. Private threads, both sides. Their own lines also find threads that have no thread doc yet, and
  // the list of threads (which names those too) finds one holding only the other person's undelivered lines
  const [comments, messages, likes, reports, queued, pings, threadIds] = await Promise.all([
    refsOf(db.collectionGroup('comments').where('authorUid', '==', uid)),
    refsOf(db.collectionGroup('messages').where('authorUid', '==', uid)),
    refsOf(db.collectionGroup('likes').where('uid', '==', uid)),
    refsOf(db.collection('reports').where('reporterUid', '==', uid)),
    refsOf(db.collection('modQueue').where('authorUid', '==', uid)),
    // Mentions, comments and acceptances they caused in other people's notifications
    refsOf(db.collectionGroup('notices').where('actorUid', '==', uid)),
    db.collection('dms').listDocuments(),
  ])
  const pairs = [
    ...new Set([
      ...connections.map((ref) => ref.id),
      ...threadDocs.map((ref) => ref.id),
      ...messages.map((ref) => pairOfDmPath(ref.path)).filter((pair): pair is string => pair !== undefined),
      ...threadIds.map((ref) => ref.id).filter((pair) => isPairOf(pair, uid)),
    ]),
  ]
  const threads = await deleteTrees(pairs.map((pair) => db.doc(`dms/${pair}`)))

  // 4. Their comments, group talk, likes, reports and notices elsewhere (counters follow by trigger)
  const writing = await deleteAll([...comments, ...messages, ...likes, ...reports, ...pings])

  // 5. Review-queue items that would now point at nothing
  const orphaned = await Promise.all([
    ...posts.map((post) => {
      const [start, end] = underPath(post.path)
      return refsOf(db.collection('modQueue').where('contentPath', '>=', start).where('contentPath', '<', end))
    }),
    ...pairs.map((pair) => refsOf(db.collection('modQueue').where('pairId', '==', pair))),
  ])
  const queue = await deleteAll([...queued, ...orphaned.flat()])
  // Queue items they reported keep the report (moderation evidence), without their uid
  const reported = await refsOf(db.collection('modQueue').where('reports.reporterUids', 'array-contains', uid))
  await Promise.all(reported.map((ref) => ref.update({ 'reports.reporterUids': FieldValue.arrayRemove(uid) })))

  // 6. Licence application and its documents; their posting-rate stamps
  const application = await deleteAll([db.doc(`proApplications/${uid}`), db.doc(`rateLimits/${uid}`)])
  // No bucket configured (Storage not set up, e.g. the local backend) means no documents to delete
  const bucket = storage.app.options.storageBucket
  if (bucket) {
    await storage
      .bucket(bucket)
      .deleteFiles({ prefix: `proDocs/${uid}/` })
      .catch((error: { code?: number }) => {
        if (error.code !== 404) throw error
      })
  }

  return { posts: posts.length, threads, items: access + writing + queue + application }
}

export const deleteAccount = onCall<{ confirm?: string }>(
  // No App Check here: leaving must work even where a blocker stops reCAPTCHA
  callable({ enforceAppCheck: false, timeoutSeconds: 300 }),
  async (request) => {
    const uid = request.auth?.uid
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in first.')

    const [user, profile, ban] = await Promise.all([auth.getUser(uid), db.doc(`users/${uid}`).get(), db.doc(`bans/${uid}`).get()])
    if (user.customClaims?.admin === true) throw new HttpsError('failed-precondition', 'admin', { problem: 'admin' })
    // Timed on the server's clock (the read time), like auth_time: the local backend's may be off
    if (!isRecentSignIn(request.auth?.token.auth_time, profile.readTime.toMillis() / 1000)) throw new HttpsError('failed-precondition', 'recent-login', { problem: 'recent-login' })
    if (ban.exists) throw new HttpsError('permission-denied', 'paused', { problem: 'paused' })
    if (!confirmMatches(request.data?.confirm, profile.data()?.penNameLower)) {
      throw new HttpsError('invalid-argument', 'confirm', { problem: 'confirm' })
    }

    // Before anything goes. A save already on its way (it asked Auth before this finished) reads it
    // and gives up, and the rules refuse a tab's writes, so nothing they had comes back after the purge
    await db.doc(`accountDeletions/${uid}`).set({ at: FieldValue.serverTimestamp(), expireAt: Timestamp.fromMillis(Date.now() + LEAVING_FOR_MS) })
    const counts = await purgeAccount(uid)
    await auth.deleteUser(uid).catch((error: { code?: string }) => {
      if (error.code !== 'auth/user-not-found') throw error
    })
    await logAction(uid, 'deleteAccount', uid, counts)
    return { ok: true }
  },
)
