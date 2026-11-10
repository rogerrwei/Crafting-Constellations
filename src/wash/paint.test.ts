import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Painted on the main thread: all zeros, where a worker's answer here is all nines
const { renderField } = vi.hoisted(() => ({
  renderField: vi.fn((w: number, h: number) => new Uint8ClampedArray(w * h * 4)),
}))
vi.mock('./field', () => ({ renderField, seedFrom: () => 7 }))

interface Posted {
  id: number
  w: number
  h: number
}

interface FakeWorker {
  posted: Posted[]
  terminated: boolean
  onmessage?: (event: { data: unknown }) => void
  onerror?: () => void
  onmessageerror?: () => void
}

const OPTS = { stops: [[0, '#fff']] as const, strokes: [] }

let started: FakeWorker[] = []

// Workers the test drives by hand; with `fails`, the browser can't make one at all
const stubWorkers = (count: number, { fails = false } = {}) => {
  started = []
  vi.stubGlobal('navigator', { hardwareConcurrency: count })
  vi.stubGlobal('Worker', function Worker() {
    if (fails) throw new Error('no workers here')
    const worker = {
      posted: [] as Posted[],
      terminated: false,
      postMessage: (job: Posted) => void worker.posted.push(job),
      terminate: () => {
        worker.terminated = true
      },
    }
    started.push(worker)
    return worker
  })
}

// A fresh module each time: its workers and jobs are module state
const loadPaint = async () => {
  vi.resetModules()
  return import('./paint')
}

const answer = (worker: FakeWorker, index: number) => {
  const { id, w, h } = worker.posted[index]
  worker.onmessage?.({ data: { id, pixels: new Uint8ClampedArray(w * h * 4).fill(9) } })
}

const painted = (pixels: Uint8ClampedArray) => (pixels.every((p) => p === 9) ? 'worker' : 'here')

// Whether a promise has settled yet, without waiting on it
const settledYet = async (promise: Promise<unknown>) => {
  let settled = false
  void promise.then(
    () => (settled = true),
    () => (settled = true),
  )
  await Promise.resolve()
  await Promise.resolve()
  return settled
}

beforeEach(() => {
  vi.useFakeTimers()
  renderField.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('requestField when a worker fails', () => {
  it('paints the jobs a worker held on the main thread when its script never loads, then paints everything here', async () => {
    stubWorkers(1)
    const { requestField } = await loadPaint()
    const jobs = [requestField(2, 2, OPTS), requestField(3, 3, OPTS)]
    const [worker] = started
    expect(worker.posted).toHaveLength(2)

    worker.onerror?.()
    const [small, big] = await Promise.all(jobs)
    expect([painted(small), small.length, painted(big), big.length]).toEqual(['here', 16, 'here', 36])
    expect(worker.terminated).toBe(true)
    // Nothing left waiting on it: no watch still running
    expect(vi.getTimerCount()).toBe(0)

    // No worker left: the next one is painted here, and none is started again
    const later = await requestField(1, 1, OPTS)
    expect(painted(later)).toBe('here')
    expect(worker.posted).toHaveLength(2)
    expect(started).toHaveLength(1)
  })

  it('treats an unreadable answer as the worker failing, since it says nothing of whose it was', async () => {
    stubWorkers(1)
    const { requestField } = await loadPaint()
    const job = requestField(2, 2, OPTS)
    started[0].onmessageerror?.()
    expect(painted(await job)).toBe('here')
    expect(started[0].terminated).toBe(true)
  })

  it('stops giving work to a worker that crashed, and sends it to the one still running', async () => {
    stubWorkers(2)
    const { requestField } = await loadPaint()
    // The first takes a small job, the second a big one: the crashed one would look the least busy
    const small = requestField(2, 2, OPTS)
    const big = requestField(10, 10, OPTS)
    const [crashed, running] = started
    expect([crashed.posted.length, running.posted.length]).toEqual([1, 1])

    crashed.onerror?.()
    expect(painted(await small)).toBe('here')

    const next = requestField(3, 3, OPTS)
    expect(crashed.posted).toHaveLength(1)
    expect(running.posted).toHaveLength(2)

    answer(running, 0)
    answer(running, 1)
    expect([painted(await big), painted(await next)]).toEqual(['worker', 'worker'])
    expect(renderField).toHaveBeenCalledTimes(1)
  })

  it('takes a busy worker that goes silent as dead, and paints what it held', async () => {
    stubWorkers(1)
    const { requestField, WORKER_SILENCE_MS } = await loadPaint()
    const job = requestField(2, 2, OPTS)

    vi.advanceTimersByTime(WORKER_SILENCE_MS - 1)
    expect(await settledYet(job)).toBe(false)
    vi.advanceTimersByTime(1)
    expect(painted(await job)).toBe('here')
    expect(started[0].terminated).toBe(true)
  })

  it('gives a worker that keeps answering as long as its queue takes', async () => {
    stubWorkers(1)
    const { requestField, WORKER_SILENCE_MS } = await loadPaint()
    const first = requestField(2, 2, OPTS)
    const second = requestField(2, 2, OPTS)
    const [worker] = started

    vi.advanceTimersByTime(WORKER_SILENCE_MS - 1)
    answer(worker, 0)
    vi.advanceTimersByTime(WORKER_SILENCE_MS - 1)
    expect(await settledYet(second)).toBe(false)
    answer(worker, 1)

    expect([painted(await first), painted(await second)]).toEqual(['worker', 'worker'])
    expect(worker.terminated).toBe(false)
    // Idle again: nothing is timing it
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores an answer for a job already painted here', async () => {
    stubWorkers(2)
    const { requestField } = await loadPaint()
    const job = requestField(2, 2, OPTS)
    const [worker] = started
    worker.onerror?.()
    // The browser had it queued before the worker was closed
    answer(worker, 0)
    expect(painted(await job)).toBe('here')
  })
})

describe('renderBlot', () => {
  const stubPage = () => {
    vi.stubGlobal('window', { devicePixelRatio: 1 })
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '#000' }))
    vi.stubGlobal('document', {
      documentElement: {},
      createElement: () => ({ width: 0, height: 0, getContext: () => null, toDataURL: () => 'data:image/png;base64,blot' }),
    })
  }

  it('paints a blot that failed again the next time, and keeps one that worked', async () => {
    stubWorkers(1, { fails: true })
    stubPage()
    const { renderBlot } = await loadPaint()

    renderField.mockImplementationOnce(() => {
      throw new Error('no paint')
    })
    await expect(renderBlot('ann', 'paynesBlue', 8)).rejects.toThrow('no paint')

    const again = renderBlot('ann', 'paynesBlue', 8)
    await expect(again).resolves.toBe('data:image/png;base64,blot')
    expect(renderBlot('ann', 'paynesBlue', 8)).toBe(again)
    expect(renderField).toHaveBeenCalledTimes(2)
  })
})
