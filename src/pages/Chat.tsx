import { collection, query, where } from 'firebase/firestore'
import { useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useMe } from '../auth/AuthProvider'
import { PageHead } from '../components/PageHead'
import { Quiet } from '../components/Quiet'
import { Talk } from '../components/Talk'
import { Who } from '../components/Who'
import { describeError } from '../lib/callables'
import { useCurrentPath } from '../lib/currentPath'
import { db } from '../lib/firebase'
import { useQueryData } from '../lib/live'
import { findById } from '../lib/lookup'
import { among } from '../lib/people'
import { hereOf } from '../lib/returnTo'
import { leaveChat } from '../lib/social'
import type { Chat as ChatDoc, Profile } from '../lib/types'
import { HEAD_DESCENDING } from '../wash/strokes'

// A private group chat: only the people on it can read or write
export const Chat = () => {
  const { chatId = '' } = useParams()
  const { uid, claims } = useMe()
  const navigate = useNavigate()
  const location = useLocation()
  const currentPath = useCurrentPath()
  const verified = claims.emailVerified
  // Which chat I'm leaving: another opened from the rail meanwhile keeps this page mounted, and
  // isn't the one being left
  const [leaving, setLeaving] = useState<string | null>(null)
  // Why the last Leave didn't go through, with the chat it was pressed in: another opened from the
  // rail keeps this page mounted, and starts with nothing said. Coming back doesn't bring it back
  // either, or it would be read out again as if it had just failed
  const [refusal, setRefusal] = useState<{ at: string; error: string } | null>(null)
  if (refusal && refusal.at !== chatId) setRefusal(null)
  const error = refusal?.at === chatId ? refusal.error : null

  // Found among my chats, not by its document: that's refused once I've left (Back
  // after leaving, an old notice). Listeners close before leaving, so the rules
  // never see a reader they'd reject
  const chats = useQueryData<ChatDoc>(verified && leaving !== chatId ? `chats|${uid}` : null, () =>
    query(collection(db, 'chats'), where('uids', 'array-contains', uid)),
  )
  const chat = findById(chats.data, chatId)
  const people = useQueryData<Profile>('people', () => collection(db, 'users'))
  const byId = new Map(people.data.map((p) => [p.id, p]))

  if (!verified) {
    return (
      <Quiet>
        Confirm your email to open private chats. <Link to="/verify" state={{ from: hereOf(location) }}>Confirm email</Link>
      </Quiet>
    )
  }
  if (leaving === chatId) return <Quiet>Leaving the chat…</Quiet>
  if (chats.loading) return <Quiet>Opening…</Quiet>
  if (!chat) return <Quiet>This chat isn’t yours to open.</Quiet>

  const members = chat.uids.map((id) => byId.get(id)).filter((p): p is Profile => Boolean(p))

  const leave = async () => {
    const from = location.pathname
    setLeaving(chatId)
    setRefusal(null)
    try {
      await new Promise((r) => setTimeout(r, 0))
      await leaveChat(chatId, uid)
      // It waits for the server, offline for as long as that lasts. Gone elsewhere by then, they
      // stay on the page they chose, and the chat drops from the rail
      if (currentPath() === from) return navigate('/messages')
    } catch (e) {
      // Said only on this chat, and only if they're on it when the answer lands
      if (currentPath() === from) setRefusal({ at: chatId, error: describeError(e) })
    }
    // Done, so this chat shows as it now is, whether they're still on it or come back to it later
    setLeaving((current) => (current === chatId ? null : current))
  }

  return (
    <div className="pane">
      <PageHead
        title={chat.name}
        kicker={`Private chat · ${chat.uids.length} ${chat.uids.length === 1 ? 'person' : 'people'}`}
        lede="Only the people here can read this. Messages are checked like everything else."
        strokes={HEAD_DESCENDING}
        seed={chatId.length * 17}
      >
        <div className="row" style={{ gap: '6px 16px' }}>
          {members.map((p) => (
            <Who key={p.id} person={{ ...p, avatarSeed: p.avatarSeed || p.id }} />
          ))}
        </div>
        <div className="row">
          <button type="button" className="link-btn" onClick={() => void leave()}>
            Leave chat
          </button>
        </div>
      </PageHead>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {/* Keyed on the chat: moving to another keeps this page mounted, and a draft or its @mentions must not follow you there */}
      <Talk
        key={chatId}
        path={`chats/${chatId}/messages`}
        me={uid}
        verified={verified}
        label="Private chat"
        privateThread
        people={among(people.data, chat.uids, uid)}
        host={<p>{chat.uids.length === 1 ? '1 person is in this chat.' : `${chat.uids.length} people are in this chat.`}</p>}
      />
    </div>
  )
}
