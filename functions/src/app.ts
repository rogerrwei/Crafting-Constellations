import { initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { FieldValue, getFirestore, type BulkWriter, type Transaction } from 'firebase-admin/firestore'
import { getStorage } from 'firebase-admin/storage'

initializeApp()

export const db = getFirestore()
export const auth = getAuth()
export const storage = getStorage()

// gRPC status for a missing document (update() on a deleted doc)
export const NOT_FOUND = 5

// Audit log: who did what to whom (ids only)
const actionOf = (actorUid: string, action: string, target: string, details: Record<string, unknown>) => ({
  actorUid,
  action,
  target,
  details,
  at: FieldValue.serverTimestamp(),
})
export const logAction = (actorUid: string, action: string, target: string, details: Record<string, unknown> = {}) =>
  db.collection('adminActions').add(actionOf(actorUid, action, target, details))
// The same, in the transaction that makes the decision: one is never without the other
export const logActionIn = (tx: Transaction, actorUid: string, action: string, target: string, details: Record<string, unknown> = {}) =>
  tx.set(db.collection('adminActions').doc(), actionOf(actorUid, action, target, details))

// Closes a BulkWriter and waits for its operations, each handled from the start: one that fails
// while close() flushes would otherwise sit as an unhandled rejection, which ends a Node process
// (the local backend). Rejects with the first failure, once every operation has settled
export const closeAll = async (writer: BulkWriter, results: Promise<unknown>[]) => {
  const settled = Promise.allSettled(results)
  await writer.close()
  const failed = (await settled).find((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failed) throw failed.reason
}

// The nine pigments of the source sheet (mirrors src/wash/pigments.ts)
export const PIGMENTS = ['paynesBlue', 'graphite', 'fresco', 'paynes', 'titanium', 'caliente', 'neutral', 'cool', 'warm'] as const

export type ContentKind = 'post' | 'comment' | 'groupMessage' | 'dm' | 'chatMessage' | 'profile'

// groups/g/posts/p, groups/g/posts/p/comments/c, groups/g/messages/m, dms/a_b/messages/m, chats/c/messages/m, users/u
export const kindOf = (path: string): ContentKind | null => {
  const s = path.split('/')
  if (s[0] === 'users' && s.length === 2) return 'profile'
  if (s[0] === 'dms' && s[2] === 'messages' && s.length === 4) return 'dm'
  if (s[0] === 'chats' && s[2] === 'messages' && s.length === 4) return 'chatMessage'
  if (s[0] === 'groups' && s[2] === 'messages' && s.length === 4) return 'groupMessage'
  if (s[0] === 'groups' && s[2] === 'posts' && s.length === 4) return 'post'
  if (s[0] === 'groups' && s[2] === 'posts' && s[4] === 'comments' && s.length === 6) return 'comment'
  return null
}

export { queueIdFor } from './queueId.js'

export const textOf = (data: FirebaseFirestore.DocumentData | undefined) =>
  [data?.title, data?.body ?? data?.text].filter((v): v is string => typeof v === 'string').join('\n')

// Connection / private-thread id for two people: sorted uids joined by _
export const pairIdOf = (a: string, b: string) => [a, b].sort().join('_')

// The name and mark shown on someone's writing, as of now (attached by functions only)
export const snapshotOf = (uid: string, profile: FirebaseFirestore.DocumentData | undefined) => ({
  penName: profile?.penName ?? 'Someone',
  avatarSeed: profile?.avatarSeed ?? uid,
  pigment: profile?.pigment ?? 'paynesBlue',
  pro: profile?.pro === true,
  ...(profile?.synthetic ? { synthetic: true } : {}),
})
