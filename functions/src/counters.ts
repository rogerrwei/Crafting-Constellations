import { createHash } from 'node:crypto'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import { db, NOT_FOUND } from './app.js'

// gRPC status for create() on a document that is already there
const ALREADY_EXISTS = 6

// Long enough to outlast any retry of the event; the TTL policy on expireAt clears them after
const MARKER_DAYS = 7

const existed = (snap: { exists: boolean } | undefined) => Number(snap?.exists ?? false)
const published = (snap: { data: () => FirebaseFirestore.DocumentData | undefined } | undefined) =>
  Number(snap?.data()?.status === 'published')

// One marker per event and counter, named by a hash: an event id is not promised to be a valid
// document id
const markerOf = (eventId: string, field: string) =>
  db.doc(`counterEvents/${createHash('sha256').update(`${field}|${eventId}`).digest('hex')}`)

// Events can arrive more than once (a retry, a replay), so each one moves its counter once only:
// the marker is created in the same batch as the increment, and a marker already there fails the
// whole batch. update, never set: a late delete-trigger must not resurrect a removed parent, and
// a parent that's gone fails the batch too, leaving no marker behind
const bump = async (eventId: string, path: string, field: string, delta: number) => {
  if (delta === 0) return
  const batch = db.batch()
  batch.create(markerOf(eventId, field), { path, field, delta, expireAt: Timestamp.fromMillis(Date.now() + MARKER_DAYS * 86_400_000) })
  batch.update(db.doc(path), { [field]: FieldValue.increment(delta) })
  await batch.commit().catch((error: { code?: number }) => {
    if (error.code !== NOT_FOUND && error.code !== ALREADY_EXISTS) throw error
  })
}

export const countMembers = onDocumentWritten('groups/{gid}/members/{uid}', async (event) => {
  const delta = existed(event.data?.after) - existed(event.data?.before)
  await bump(event.id, `groups/${event.params.gid}`, 'memberCount', delta)
})

export const countLikes = onDocumentWritten('groups/{gid}/posts/{pid}/likes/{uid}', async (event) => {
  const delta = existed(event.data?.after) - existed(event.data?.before)
  await bump(event.id, `groups/${event.params.gid}/posts/${event.params.pid}`, 'likeCount', delta)
})

// Only published comments count, so publish / approve / remove / withdraw all land here
export const countComments = onDocumentWritten('groups/{gid}/posts/{pid}/comments/{cid}', async (event) => {
  const delta = published(event.data?.after) - published(event.data?.before)
  await bump(event.id, `groups/${event.params.gid}/posts/${event.params.pid}`, 'commentCount', delta)
})
