/*
 * Local backend: does Cloud Functions' work from our own machine (the Intel NUC)
 * while the project can't run Cloud Functions. It only makes outgoing connections.
 * - Answers the calls the site writes to calls/{id} (site built with VITE_LOCAL_BACKEND=true)
 *   by running each callable's own handler.
 * - Watches Firestore for what the triggers would do: moderate pending writing
 *   (which also pings people), handle reports, mirror friendships and tell people
 *   their request was accepted, keep counters.
 * Everything here is safe to repeat, so a restart simply catches up. Stopping lets the calls
 * under way finish first, and answers any that can't as interrupted.
 *
 *   npm --prefix functions run build
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json node functions/lib/local-backend.js
 *
 * Moderator emails come from functions/.env.<project-id> (or ADMIN_EMAILS in the environment).
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { DocumentData, DocumentReference, Query, QuerySnapshot } from 'firebase-admin/firestore'
import type { CallableFunction, CallableRequest } from 'firebase-functions/v2/https'
import { earliestFirst, firebaseConfigFor, listParam, namesAnyone, statusBefore, underWay, userOrNone, within, type SeenConnection } from './localBackendPolicy.js'

// Must match the allow-list in firestore.rules (calls/{callId})
const CALLABLES = [
  'saveProfile',
  'deleteAccount',
  'approveContent',
  'removeContent',
  'banUser',
  'unbanUser',
  'reviewProfessional',
  'setAdmin',
  'bootstrapAdmin',
  'createGroup',
  'createChat',
] as const

// The site gives up on a call nobody picks up within 25s (once one is running, it waits for
// the answer); anything older is not run, so a backlog never performs something (like
// deleting an account) long after the person left
const CALL_TTL_MS = 30_000
const CALL_CLEANUP_EVERY_MS = 10 * 60_000
// On stopping (a restart, a reboot, a listener failing), calls under way get this long to finish,
// then any still going is answered as interrupted: both within systemd's 90s before it kills us
const STOP_WAIT_MS = 60_000
const INTERRUPTED_WAIT_MS = 10_000

const log = (...parts: unknown[]) => console.log(new Date().toISOString(), '[local-backend]', ...parts)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Project, moderator list and (no) Storage bucket, before firebase-admin initialises
const prepareEnv = () => {
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS
  const projectId = process.env.GCLOUD_PROJECT ?? (keyFile ? (JSON.parse(readFileSync(keyFile, 'utf8')).project_id as string) : undefined)
  if (!projectId) throw new Error('Set GOOGLE_APPLICATION_CREDENTIALS to the service-account key file.')
  process.env.GCLOUD_PROJECT = projectId
  process.env.FIREBASE_CONFIG = firebaseConfigFor(projectId, process.env)
  const params = fileURLToPath(new URL(`../.env.${process.env.FIRESTORE_EMULATOR_HOST ? 'local' : projectId}`, import.meta.url))
  if (existsSync(params)) process.loadEnvFile(params)
  process.env.ADMIN_EMAILS = listParam(process.env.ADMIN_EMAILS)
  // Unset, or empty as functions/.env.example leaves it
  if (!namesAnyone(process.env.ADMIN_EMAILS)) log(`no emails in ADMIN_EMAILS (${params} or the environment): nobody can make themselves a moderator`)
  return projectId
}

// Transient failures (network, contention) get a few more tries; the work is idempotent.
// Whether it went through in the end, so nothing is logged as done that never was.
export const retrying = async (what: string, work: () => Promise<unknown>, attempt = 1): Promise<boolean> => {
  try {
    await work()
    return true
  } catch (error) {
    if (attempt >= 5) {
      log(`gave up on ${what}:`, error)
      return false
    }
    await sleep(attempt * 5000)
    return retrying(what, work, attempt + 1)
  }
}

// Collect paths for a second, then handle each once (counters after a burst of likes)
const batched = (flush: (paths: string[]) => Promise<void>) => {
  const pending = new Set<string>()
  let timer: NodeJS.Timeout | undefined
  return (path: string) => {
    pending.add(path)
    timer ??= setTimeout(() => {
      const paths = [...pending]
      pending.clear()
      timer = undefined
      void flush(paths)
    }, 1000)
  }
}

// Firestore can't store undefined; callables may return it
const plain = (value: unknown) => JSON.parse(JSON.stringify(value ?? null)) as unknown

export const startLocalBackend = async () => {
  const projectId = prepareEnv()
  const { FieldValue } = await import('firebase-admin/firestore')
  const { HttpsError } = await import('firebase-functions/v2/https')
  const { auth, db, NOT_FOUND } = await import('./app.js')
  const functions = (await import('./index.js')) as unknown as Record<(typeof CALLABLES)[number], CallableFunction<unknown, unknown>>
  const { handleNewContent } = await import('./content.js')
  const { handleNewReport } = await import('./reports.js')
  const { mirrorFriendshipOf, noticeOnAccept } = await import('./friendships.js')
  const { finishRefreshes } = await import('./admin.js')
  const { removeExpired } = await import('./housekeeping.js')

  const ignoreMissing = (error: { code?: number }) => {
    if (error.code !== NOT_FOUND) throw error
  }

  // A listener that dies leaves work undone without anyone noticing: exit, and let the service manager restart us
  const watch = (name: string, query: Query, onChange: (snap: QuerySnapshot) => void) =>
    query.onSnapshot(onChange, (error) => {
      log(`listener "${name}" failed, exiting so the service restarts:`, error)
      void stop().finally(() => process.exit(1))
    })

  // ---------- calls ----------

  const errorOf = (error: unknown) => {
    if (error instanceof HttpsError) {
      return { status: error.code, message: error.message, ...(error.details === undefined ? {} : { details: plain(error.details) }) }
    }
    log('call failed:', error)
    return { status: 'internal', message: 'internal' }
  }

  // The same request a callable gets from a verified ID token: claims, email and
  // verification read live from Auth, and the sign-in time the rules checked
  const run = async (call: DocumentData) => {
    const fn = (CALLABLES as readonly string[]).includes(call.name) ? functions[call.name as (typeof CALLABLES)[number]] : undefined
    if (!fn) throw new HttpsError('not-found', 'call')
    const user = await userOrNone(auth.getUser(call.uid))
    if (!user || user.disabled) throw new HttpsError('unauthenticated', 'Sign in first.')
    const token = { ...user.customClaims, uid: user.uid, sub: user.uid, email: user.email, email_verified: user.emailVerified, auth_time: call.authTime }
    return fn.run({ data: call.data, auth: { uid: user.uid, token, rawToken: '' }, acceptsStreaming: false } as unknown as CallableRequest<unknown>)
  }

  // This run's mark on the calls it takes on, so it only ever answers for its own as interrupted
  const runner = randomUUID()

  const answer = async (ref: DocumentReference) => {
    // Claim it first, so a replayed snapshot or a second backend never runs it twice. The claim
    // can go through and still report an error (a dropped connection), and the transaction then
    // tries again: finding the call taken by this same claim, it runs it all the same.
    const claim = randomUUID()
    // As aged when it was claimed: a second try keeps the first one's decision
    let age = 0
    const call = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref)
      const data = snap.data()
      if (data?.state === 'running' && data.claim === claim) return data
      if (!data || data.state !== 'new') return null
      // Aged on the server's clock, which also stamped createdAt: this machine's may be off
      age = snap.readTime.toMillis() - (data.createdAt?.toMillis?.() ?? 0)
      tx.update(ref, age > CALL_TTL_MS ? { state: 'expired' } : { state: 'running', runner, claim })
      return data
    })
    if (!call) return
    if (age > CALL_TTL_MS) {
      log(`${call.name} expired after ${age}ms`)
      return
    }
    const started = Date.now()
    const reply = await run(call).then(
      (result) => ({ state: 'done', result: plain(result) }),
      (error: unknown) => ({ state: 'failed', error: errorOf(error) }),
    )
    // The site may already have given up and removed the call
    const written = await retrying(`answer to ${call.name}`, () => ref.update({ ...reply, answeredAt: FieldValue.serverTimestamp() }).catch(ignoreMissing))
    log(`${call.name} ${reply.state} in ${Date.now() - started}ms${written ? '' : ', but the answer was never written'}`)
  }

  // A call this run took on and can't finish: answered, so the site doesn't wait on it in vain
  const interrupted = (ref: DocumentReference) =>
    db.runTransaction(async (tx) => {
      const snap = await tx.get(ref)
      if (snap.get('state') !== 'running' || snap.get('runner') !== runner) return
      const error = { status: 'unavailable', message: 'The server stopped before it finished.' }
      tx.update(ref, { state: 'failed', error, answeredAt: FieldValue.serverTimestamp() })
    })

  const answering = underWay<DocumentReference>()

  // Cut off on the server's clock (every read carries it), like the expiry above
  const removeStaleCalls = async () => {
    const { readTime } = await db.collection('calls').limit(1).get()
    const stale = await db.collection('calls').where('createdAt', '<', new Date(readTime.toMillis() - CALL_CLEANUP_EVERY_MS)).get()
    await Promise.all(stale.docs.map((d) => d.ref.delete()))
  }

  // ---------- counters (recounted, never incremented: restarts can't drift them) ----------

  const recountGroups = batched(async (paths) => {
    await Promise.all(
      paths.map((path) =>
        retrying(`count ${path}`, async () => {
          const group = db.doc(path)
          const members = await group.collection('members').count().get()
          await group.update({ memberCount: members.data().count }).catch(ignoreMissing)
        }),
      ),
    )
  })

  const recountPosts = batched(async (paths) => {
    await Promise.all(
      paths.map((path) =>
        retrying(`count ${path}`, async () => {
          const post = db.doc(path)
          const [likes, comments] = await Promise.all([
            post.collection('likes').count().get(),
            post.collection('comments').where('status', '==', 'published').count().get(),
          ])
          await post.update({ likeCount: likes.data().count, commentCount: comments.data().count }).catch(ignoreMissing)
        }),
      ),
    )
  })

  // The first snapshot is the baseline: recount everything once, then follow changes. The read
  // is retried, like everything else here: a failed one would end the process unhandled.
  const parentsOnChange = (recount: (path: string) => void, everything: () => Promise<string[]>) => {
    let primed = false
    return (snap: QuerySnapshot) => {
      if (!primed) {
        primed = true
        void retrying('recounting everything', async () => (await everything()).forEach(recount))
        return
      }
      snap.docChanges().forEach((change) => {
        const parent = change.doc.ref.parent.parent
        if (parent) recount(parent.path)
      })
    }
  }

  const allGroups = async () => (await db.collection('groups').get()).docs.map((d) => d.ref.path)
  const allPosts = async () => (await db.collectionGroup('posts').get()).docs.map((d) => d.ref.path)

  // ---------- friendships ----------

  // Remember each status, and when it was set, to see pending → accepted. The first snapshot
  // fills this in. Recent acceptances we never saw asked (made while we were off, or while the
  // listener reconnected, even by a pair we saw accepted before) are announced too; the notice
  // id names the acceptance, so none is announced twice.
  const statuses = new Map<string, SeenConnection>()
  let connectionsPrimed = false
  const onConnections = (snap: QuerySnapshot) => {
    const serverNow = snap.readTime.toMillis()
    snap.docChanges().forEach((change) => {
      const id = change.doc.id
      const after = change.type === 'removed' ? undefined : change.doc.data()
      const updatedAtMs: number | undefined = after?.updatedAt?.toMillis?.()
      const before = statusBefore(statuses.get(id), after?.status, updatedAtMs, serverNow)
      if (after) statuses.set(id, { status: after.status, updatedAtMs })
      else statuses.delete(id)
      // A retry looks at the connection again, so it can't put back what a later change removed
      void retrying(`friendship ${id}`, () => mirrorFriendshipOf(id))
      void retrying(`accepted ${id}`, () => noticeOnAccept(id, before, after))
    })
    if (connectionsPrimed) return
    connectionsPrimed = true
    // Connections removed while we were off left their friendship behind. Each is checked
    // against its connection as it is now: one accepted since this snapshot keeps its line.
    const accepted = new Set(snap.docs.filter((d) => d.data().status === 'accepted').map((d) => d.id))
    void retrying('friendships left behind', async () => {
      const friendships = await db.collection('friendships').get()
      friendships.docs.filter((d) => !accepted.has(d.id)).forEach((d) => void retrying(`friendship ${d.id}`, () => mirrorFriendshipOf(d.id)))
    })
  }

  const added = (handle: (ref: DocumentReference, data: DocumentData) => Promise<unknown>, what: string) => (snap: QuerySnapshot) =>
    snap
      .docChanges()
      .filter((change) => change.type === 'added')
      .forEach((change) => void retrying(`${what} ${change.doc.ref.path}`, () => handle(change.doc.ref, change.doc.data())))

  // ---------- moderation ----------

  // Each person's writing is judged one note at a time, earliest written first. The flood check
  // counts the notes written before each one, and only those within a minute after it, so a
  // longer run judged newest first (or in id order, as snapshots list it) would slip past it.
  const inWrittenOrder = earliestFirst()
  const moderateInOrder = (snap: QuerySnapshot) =>
    snap
      .docChanges()
      .filter((change) => change.type === 'added')
      .forEach(({ doc }) =>
        inWrittenOrder(String(doc.get('authorUid')), doc.get('createdAt')?.toMillis?.() ?? 0, () =>
          retrying(`moderate ${doc.ref.path}`, () => handleNewContent(doc.ref)),
        ),
      )

  const stops = [
    watch('calls', db.collection('calls').where('state', '==', 'new'), (snap) =>
      snap
        .docChanges()
        .filter((change) => change.type === 'added')
        .forEach((change) => answering.add(change.doc.ref, answer(change.doc.ref).catch((error: unknown) => log('answering failed:', error)))),
    ),
    ...['posts', 'comments', 'messages'].map((group) =>
      watch(`pending ${group}`, db.collectionGroup(group).where('status', '==', 'pending'), moderateInOrder),
    ),
    // Every report comes again on a restart; each one marked handled is skipped
    watch('reports', db.collection('reports'), added(handleNewReport, 'report')),
    watch('connections', db.collection('connections'), onConnections),
    watch('members', db.collectionGroup('members'), parentsOnChange(recountGroups, allGroups)),
    watch('likes', db.collectionGroup('likes'), parentsOnChange(recountPosts, allPosts)),
    watch('comments', db.collectionGroup('comments'), parentsOnChange(recountPosts, allPosts)),
  ]

  // Housekeeping: a failure waits for the next round, and never ends the process. Also, as the
  // housekeeping function does on Cloud Functions: a profile reset whose new name a failure, or a
  // stop, left off the writing they had out, and records past their expireAt
  const cleanUpCalls = () => {
    void removeStaleCalls().catch((error: unknown) => log('cleanup failed:', error))
    void finishRefreshes()
      .then((finished) => finished > 0 && log(`finished ${finished} profile reset(s) left undone`))
      .catch((error: unknown) => log('finishing profile resets failed:', error))
    void removeExpired().catch((error: unknown) => log('removing expired records failed:', error))
  }
  const cleanup = setInterval(cleanUpCalls, CALL_CLEANUP_EVERY_MS)
  cleanUpCalls()
  log(`running for ${projectId}`)

  // Stops listening, then lets the calls under way finish (a restart shouldn't leave an account
  // half deleted, or the site waiting on an answer that never comes). A second call waits on the first.
  let stopping: Promise<void> | undefined
  const stop = (waitMs = STOP_WAIT_MS) =>
    (stopping ??= (async () => {
      clearInterval(cleanup)
      stops.forEach((unsubscribe) => unsubscribe())
      const unfinished = await answering.settle(waitMs)
      if (unfinished.length === 0) return
      log(`answering ${unfinished.length} call(s) still running after ${waitMs}ms as interrupted`)
      await within(Promise.allSettled(unfinished.map(interrupted)), INTERRUPTED_WAIT_MS)
    })())

  return { stop }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const backend = await startLocalBackend()
  const shutdown = () => {
    log('stopping')
    void backend.stop().finally(() => process.exit(0))
  }
  // Once each: a second Ctrl-C stops at once
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}
