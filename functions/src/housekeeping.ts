import { Timestamp } from 'firebase-admin/firestore'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import { finishRefreshes } from './admin.js'
import { closeAll, db, NOT_FOUND } from './app.js'

// Records that stop mattering at their expireAt: deleteAccount's marks that an account is leaving
// (accountDeletions) and the counter triggers' markers of events already counted (counterEvents)
const EXPIRING = ['accountDeletions', 'counterEvents']

// gRPC status for a delete whose document changed since it was read
const FAILED_PRECONDITION = 9

// Removes what has expired, up to `batch` of each kind a round (the next round takes the rest).
// Done here, not by a Firestore TTL policy: those need billing on the project, which it hasn't.
// Each goes only as it was read: a mark written again since (a deletion tried again) stays
export const removeExpired = async (batch = 500) => {
  const now = Timestamp.now()
  const expired = await Promise.all(EXPIRING.map((collection) => db.collection(collection).where('expireAt', '<=', now).limit(batch).get()))
  const docs = expired.flatMap((snapshot) => snapshot.docs)
  const writer = db.bulkWriter()
  await closeAll(
    writer,
    docs.map((d) =>
      writer.delete(d.ref, { lastUpdateTime: d.updateTime }).catch((error: { code?: number }) => {
        if (error.code !== NOT_FOUND && error.code !== FAILED_PRECONDITION) throw error
      }),
    ),
  )
  return docs.length
}

// Every 10 minutes on Cloud Functions: profile resets left part done, and what has expired. The
// local backend does the same on its own timer
export const housekeeping = onSchedule('every 10 minutes', async () => {
  const results = await Promise.allSettled([finishRefreshes(), removeExpired()])
  const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failed) throw failed.reason
})
