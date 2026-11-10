import type { ReactElement, ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Chat } from './Chat'

// Opening another private chat from the rail keeps the same Chat mounted, so why a Leave didn't go
// through must stay with the chat it was pressed in, as Join and Leave do in a group
// (groupJoinLeave.test.ts). A server render can't keep state between renders, so the page runs on a
// small stand-in for useState: states keep their slots between renders (the same page, kept mounted)
const react = vi.hoisted(() => {
  let slots: { state?: unknown }[] = []
  let at = 0
  return {
    mount: () => {
      slots = []
    },
    begin: () => {
      at = 0
    },
    useState: (initial: unknown) => {
      const s = (slots[at++] ??= {})
      if (!('state' in s)) s.state = typeof initial === 'function' ? (initial as () => unknown)() : initial
      const set = (next: unknown) => {
        s.state = typeof next === 'function' ? (next as (last: unknown) => unknown)(s.state) : next
      }
      return [s.state, set]
    },
  }
})
vi.mock('react', async (importOriginal) => ({ ...(await importOriginal<typeof import('react')>()), useState: react.useState }))

// The chat open now, and the address the page is on: a case moves both, as a click on the rail does
const route = vi.hoisted(() => ({ chatId: 'c1' }))
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useParams: () => ({ chatId: route.chatId }),
  useLocation: () => ({ key: 'k', pathname: `/chats/${route.chatId}`, search: '', hash: '', state: null }),
  useNavigate: () => () => {},
}))
vi.mock('../lib/currentPath', () => ({ useCurrentPath: () => () => `/chats/${route.chatId}` }))

// Each leave waits for a case to answer it. No Firebase in node
const server = vi.hoisted(() => ({ held: new Map<string, (ok: boolean) => void>() }))
vi.mock('../lib/social', () => ({
  leaveChat: (chatId: string) =>
    new Promise<void>((resolve, reject) => server.held.set(chatId, (ok) => (ok ? resolve() : reject('refused')))),
}))
vi.mock('../lib/firebase', () => ({ db: {}, auth: {}, LOCAL_BACKEND: true }))
vi.mock('../lib/callables', () => ({ describeError: String }))
vi.mock('../auth/AuthProvider', () => ({
  useMe: () => ({ uid: 'alice', claims: { admin: false, pro: false, banned: false, emailVerified: true } }),
}))
vi.mock('../lib/live', () => ({
  useQueryData: (key: string | null) => ({
    data:
      key === 'chats|alice'
        ? [
            { id: 'c1', name: 'Tuesday soup', uids: ['alice', 'bob'] },
            { id: 'c2', name: 'Family', uids: ['alice', 'carl'] },
          ]
        : [],
    loading: false,
    error: null,
  }),
}))

type El = ReactElement<Record<string, unknown> & { children?: ReactNode }>

const isElement = (node: unknown): node is El => !!node && typeof node === 'object' && 'props' in node

const elements = (node: ReactNode): El[] => {
  if (Array.isArray(node)) return node.flatMap(elements)
  return isElement(node) ? [node, ...elements(node.props.children)] : []
}

const text = (node: ReactNode): string => {
  if (Array.isArray(node)) return node.map(text).join('')
  if (typeof node === 'string') return node
  return isElement(node) ? text(node.props.children) : ''
}

// The page opened afresh on a chat; each read of it renders it again, still mounted
const open = (chatId: string) => {
  route.chatId = chatId
  react.mount()
  return () => {
    react.begin()
    return Chat() as ReactNode
  }
}

const alert = (tree: ReactNode) => elements(tree).find((el) => el.props.role === 'alert')

const tick = () => new Promise((done) => setTimeout(done))

const pressLeave = async (page: () => ReactNode) => {
  const button = elements(page()).find((el) => el.type === 'button' && el.props.children === 'Leave chat')
  expect(button).toBeDefined()
  ;(button!.props.onClick as () => void)()
  await tick()
}

// The server takes (or refuses) a leave it was holding
const answer = async (chatId: string, ok: boolean) => {
  const held = server.held.get(chatId)
  expect(held, chatId).toBeDefined()
  held!(ok)
  await tick()
}

beforeEach(() => {
  server.held.clear()
})

describe('why Leave chat didn’t go through', () => {
  it('is said on the chat it was pressed in', async () => {
    const page = open('c1')
    await pressLeave(page)
    await answer('c1', false)
    expect(text(alert(page()))).toBe('refused')
  })

  it('isn’t shown on another chat opened after it, nor brought back to the first', async () => {
    const page = open('c1')
    await pressLeave(page)
    await answer('c1', false)
    expect(text(alert(page()))).toBe('refused')

    route.chatId = 'c2'
    expect(alert(page())).toBeUndefined()
    route.chatId = 'c1'
    expect(alert(page())).toBeUndefined()
  })

  // Leaving waits for the server, so offline it waits until the connection is back
  it('isn’t shown on another chat opened before the refusal lands', async () => {
    const page = open('c1')
    await pressLeave(page)
    route.chatId = 'c2'
    page()
    await answer('c1', false)
    expect(alert(page())).toBeUndefined()
    expect(elements(page()).some((el) => el.props.path === 'chats/c2/messages')).toBe(true)
  })

  it('is said on the first chat if they’re back on it by the time the refusal lands', async () => {
    const page = open('c1')
    await pressLeave(page)
    route.chatId = 'c2'
    page()
    route.chatId = 'c1'
    page()
    await answer('c1', false)
    expect(text(alert(page()))).toBe('refused')
  })
})
