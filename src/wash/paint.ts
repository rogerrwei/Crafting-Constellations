/*
 * The Value Study — wash painting (DOM side)
 *
 * Asks a worker for the pigment field, then lets the wash enter along the
 * brush path. Decorative only: content never waits on it.
 */
import { renderField, seedFrom, type FieldOptions, type Stroke } from './field'
import { pigmentStops, type Pigment } from './pigments'

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)

// Workers: big jobs go to the least-loaded worker ---------------------------

interface Slot {
  worker: Worker
  load: number
  // Running while it has work: how long it may go without answering
  timer?: ReturnType<typeof setTimeout>
}

interface Job {
  w: number
  h: number
  opts: FieldOptions
  resolve: (pixels: Uint8ClampedArray) => void
  reject: (error: unknown) => void
  slot: Slot
}

const WORKER_COUNT = Math.min(2, navigator.hardwareConcurrency || 1)
// The biggest field takes a worker about a second on a slow phone. One with work that says
// nothing for this long has died without an error (closed for memory, say)
export const WORKER_SILENCE_MS = 15_000
const pending = new Map<number, Job>()
let workers: Slot[] | null = null
let nextId = 0

// Painted here when no worker can: a throw rejects, rather than escaping whoever asked
const onMainThread = (w: number, h: number, opts: FieldOptions) =>
  new Promise<Uint8ClampedArray>((resolve) => resolve(renderField(w, h, opts)))

// Done with a job: with its worker's pixels, or painted here when its worker failed
const settle = (id: number, pixels?: Uint8ClampedArray) => {
  const job = pending.get(id)
  if (!job) return
  pending.delete(id)
  job.slot.load -= job.w * job.h
  if (pixels) job.resolve(pixels)
  else onMainThread(job.w, job.h, job.opts).then(job.resolve, job.reject)
}

// A worker that didn't load, threw, sent what couldn't be read or went silent gets no
// more work, and what it held is painted here. Once none are left, everything is
const retire = (slot: Slot) => {
  clearTimeout(slot.timer)
  slot.worker.terminate()
  workers = workers?.filter((s) => s !== slot) ?? null
  pending.forEach((job, id) => {
    if (job.slot === slot) settle(id)
  })
}

// Each answer starts the wait again, so a long queue on a working worker never runs out
const watch = (slot: Slot) => {
  clearTimeout(slot.timer)
  slot.timer = slot.load > 0 ? setTimeout(() => retire(slot), WORKER_SILENCE_MS) : undefined
}

const startWorkers = (): Slot[] => {
  try {
    return Array.from({ length: WORKER_COUNT }, () => {
      const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
      const slot: Slot = { worker, load: 0 }
      worker.onmessage = ({ data }: MessageEvent<{ id: number; pixels: Uint8ClampedArray }>) => {
        settle(data.id, data.pixels)
        watch(slot)
      }
      // Neither says which job it was, so it's all of them: a script that never loaded, an
      // uncaught throw, or an answer that arrived unreadable
      worker.onerror = () => retire(slot)
      worker.onmessageerror = () => retire(slot)
      return slot
    })
  } catch {
    return []
  }
}

export const requestField = (w: number, h: number, opts: FieldOptions): Promise<Uint8ClampedArray> => {
  workers ??= startWorkers()
  if (workers.length === 0) return onMainThread(w, h, opts)
  const slot = workers.reduce((a, b) => (b.load < a.load ? b : a))
  const id = nextId++
  slot.load += w * h
  return new Promise((resolve, reject) => {
    pending.set(id, { w, h, opts, resolve, reject, slot })
    // Started by the first job only: a dead worker handed a steady stream must still run out
    if (!slot.timer) watch(slot)
    slot.worker.postMessage({ id, w, h, opts })
  })
}

// Reveal along the brush path ---------------------------------------------

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3)

const reveal = (
  ctx: CanvasRenderingContext2D,
  source: HTMLCanvasElement,
  w: number,
  h: number,
  stroke: Stroke,
  duration: number,
  isCurrent: () => boolean,
) => {
  const ax = stroke.from[0] * w
  const ay = stroke.from[1] * h
  const dx = stroke.to[0] * w - ax
  const dy = stroke.to[1] * h - ay
  const len = Math.hypot(dx, dy)
  const ux = dx / len
  const uy = dy / len
  const proj = [[0, 0], [w, 0], [0, h], [w, h]].map(([x, y]) => (x - ax) * ux + (y - ay) * uy)
  const t0 = Math.min(...proj)
  const t1 = Math.max(...proj)
  const start = performance.now()

  const frame = (now: number) => {
    if (!isCurrent()) return
    const p = easeOut(Math.min(1, (now - start) / duration))
    ctx.globalCompositeOperation = 'source-over'
    ctx.clearRect(0, 0, w, h)
    ctx.drawImage(source, 0, 0)
    ctx.globalCompositeOperation = 'destination-in'
    const g = ctx.createLinearGradient(ax + ux * t0, ay + uy * t0, ax + ux * t1, ay + uy * t1)
    const front = p * 1.15
    g.addColorStop(0, 'rgba(0,0,0,1)')
    g.addColorStop(clamp01(front - 0.15), 'rgba(0,0,0,1)')
    g.addColorStop(clamp01(front), 'rgba(0,0,0,0)')
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)
    ctx.globalCompositeOperation = 'source-over'
    if (p < 1) requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

// Public -------------------------------------------------------------------

const MAX_PIXELS = 1_700_000

export interface WashOptions extends FieldOptions {
  animate?: boolean
  duration?: number
  maxScale?: number
}

// Paints into a canvas inside `el`; returns a disposer for React effects
export const paintWash = (el: HTMLElement, opts: WashOptions) => {
  const canvas = el.querySelector('canvas') ?? el.appendChild(document.createElement('canvas'))
  canvas.setAttribute('aria-hidden', 'true')
  let lastW = 0
  let lastH = 0
  let version = 0
  let disposed = false

  const paint = (animate: boolean) => {
    const rect = el.getBoundingClientRect()
    if (rect.width < 2 || rect.height < 2) return
    const dpr = Math.min(window.devicePixelRatio || 1, opts.maxScale ?? 1.5)
    const fit = Math.min(1, Math.sqrt(MAX_PIXELS / (rect.width * rect.height * dpr * dpr)))
    const scale = dpr * fit
    const w = Math.round(rect.width * scale)
    const h = Math.round(rect.height * scale)
    lastW = rect.width
    lastH = rect.height

    const token = ++version
    const { stops, strokes, seed, granulation, streaks, fieldScale } = opts
    void requestField(w, h, { stops, strokes, seed, granulation, streaks, fieldScale, scale }).then((pixels) => {
      if (disposed || token !== version) return
      const off = document.createElement('canvas')
      off.width = w
      off.height = h
      off.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(pixels), w, h), 0, 0)

      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      el.classList.add('is-painted')

      if (!animate || reducedMotion()) {
        ctx.drawImage(off, 0, 0)
        return
      }
      reveal(ctx, off, w, h, strokes[0], opts.duration ?? 1000, () => !disposed && token === version)
    })
  }

  paint(opts.animate ?? true)

  let timer = 0
  const observer = new ResizeObserver(([entry]) => {
    const { width, height } = entry.contentRect
    if (Math.abs(width - lastW) < 4 && Math.abs(height - lastH) < 4) return
    window.clearTimeout(timer)
    timer = window.setTimeout(() => paint(false), 160)
  })
  observer.observe(el)

  return () => {
    disposed = true
    observer.disconnect()
    window.clearTimeout(timer)
  }
}

// A cut swatch bar, left-dense → right-paper
export const swatchOptions = (
  stops: FieldOptions['stops'],
  { seed = 101, density = 1, loose = false, granulation = 0.35 } = {},
): WashOptions => ({
  seed,
  stops,
  granulation,
  streaks: loose ? 0.4 : 0.12,
  animate: false,
  maxScale: 2,
  strokes: [
    {
      from: [0.01, 0.5],
      to: [0.99, 0.5],
      width: loose ? 0.9 : 0.84,
      density,
      falloff: 0.85,
      rag: loose ? 0.22 : 0.08,
      dry: loose ? 0.55 : 0.12,
      pool: loose ? 0.45 : 0.15,
      edgeFreq: loose ? 14 : 8,
      comb: loose ? 0.14 : 0.025,
      strand: loose ? 7 : 12,
      roundEnd: !loose,
    },
  ],
})

// Avatar blots: a short loaded dab, cached as a data URL per seed/pigment/size
const blotCache = new Map<string, Promise<string>>()

export const renderBlot = (avatarSeed: string, pigment: Pigment, size: number) => {
  const px = Math.round(size * Math.min(window.devicePixelRatio || 1, 2))
  const key = `${avatarSeed}:${pigment}:${px}`
  const cached = blotCache.get(key)
  if (cached) return cached

  const seed = seedFrom(avatarSeed)
  const angle = ((seed % 360) * Math.PI) / 180
  const r = 0.3
  const cx = 0.5
  const cy = 0.5
  const job = requestField(px, px, {
    seed,
    stops: pigmentStops(pigment),
    granulation: 0.5,
    streaks: 0.3,
    scale: 2,
    fieldScale: 1,
    strokes: [
      {
        from: [cx - Math.cos(angle) * r, cy - Math.sin(angle) * r],
        to: [cx + Math.cos(angle) * r, cy + Math.sin(angle) * r],
        width: 0.66,
        density: 0.95,
        falloff: 0.7,
        rag: 0.3,
        dry: 0.15,
        pool: 0.4,
        comb: 0.06,
        strand: 5,
        roundEnd: true,
      },
    ],
  }).then((pixels) => {
    const c = document.createElement('canvas')
    c.width = px
    c.height = px
    c.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(pixels), px, px), 0, 0)
    return c.toDataURL('image/png')
  })
  blotCache.set(key, job)
  // One that failed is painted again the next time it's asked for, not kept as a failure
  job.catch(() => {
    if (blotCache.get(key) === job) blotCache.delete(key)
  })
  return job
}
