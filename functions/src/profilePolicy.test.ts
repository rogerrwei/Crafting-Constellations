import { describe, expect, it, vi } from 'vitest'
import { barredBy, firstFree, generatedNames, mayRelease, reportedName, reportedShape, resetNames, shapeOf, type NameRecord } from './profilePolicy.js'

describe('mayRelease', () => {
  it('frees the person’s own claim', () => {
    expect(mayRelease({ uid: 'u1' }, 'u1')).toBe(true)
  })

  it('keeps a name a moderator retired', () => {
    expect(mayRelease({ retired: true }, 'u1')).toBe(false)
    expect(mayRelease({ uid: 'u1', retired: true }, 'u1')).toBe(false)
  })

  it('keeps a claim someone else holds', () => {
    expect(mayRelease({ uid: 'u2' }, 'u1')).toBe(false)
  })

  it('has nothing to free when there is no claim', () => {
    expect(mayRelease(undefined, 'u1')).toBe(false)
    expect(mayRelease({}, 'u1')).toBe(false)
  })
})

describe('reportedName', () => {
  it('is the name the moderator was shown, kept as saveProfile keeps it', () => {
    expect(reportedName('Bad  Name', 'plain fern')).toBe('bad name')
    expect(reportedName('O’Neil', 'plain fern')).toBe("o'neil")
  })

  it('falls back to the name they go by now when the queue item kept none', () => {
    expect(reportedName(undefined, 'bad name')).toBe('bad name')
    expect(reportedName('  ', 'bad name')).toBe('bad name')
    expect(reportedName(undefined, undefined)).toBeUndefined()
  })
})

describe('resetNames', () => {
  const records = (entries: Record<string, NameRecord | undefined>) => new Map(Object.entries(entries))

  it('retires the name they still go by when it is the one reported', () => {
    expect(resetNames('u1', 'bad name', 'bad name', records({ 'bad name': { uid: 'u1' } }))).toEqual({ retire: 'bad name', free: undefined })
  })

  it('retires the reported name they renamed away from, and frees the one nobody judged', () => {
    expect(resetNames('u1', 'bad name', 'plain fern', records({ 'bad name': undefined, 'plain fern': { uid: 'u1' } }))).toEqual({
      retire: 'bad name',
      free: 'plain fern',
    })
  })

  it('leaves the reported name with someone who has taken it since', () => {
    expect(resetNames('u1', 'bad name', 'plain fern', records({ 'bad name': { uid: 'u2' }, 'plain fern': { uid: 'u1' } }))).toEqual({
      retire: undefined,
      free: 'plain fern',
    })
  })

  it('frees only a current name that is still their own', () => {
    expect(resetNames('u1', 'bad name', 'plain fern', records({ 'plain fern': { uid: 'u2' } })).free).toBeUndefined()
    expect(resetNames('u1', 'bad name', 'plain fern', records({ 'plain fern': { retired: true } })).free).toBeUndefined()
  })

  it('has nothing to do for a profile with no name', () => {
    expect(resetNames('u1', undefined, undefined, records({}))).toEqual({ retire: undefined, free: undefined })
  })
})

describe('barredBy', () => {
  it('lets someone have a name nobody holds, or one that is theirs', () => {
    expect(barredBy([undefined, {}], 'u1')).toBeUndefined()
    expect(barredBy([{ uid: 'u1' }, undefined], 'u1')).toBeUndefined()
  })

  it('refuses a retired name as unkind, before one someone else holds', () => {
    expect(barredBy([{ uid: 'u2' }, { retired: true }], 'u1')).toBe('unkind')
  })

  it('refuses a name someone else holds as taken', () => {
    expect(barredBy([undefined, { uid: 'u2' }], 'u1')).toBe('taken')
  })
})

describe('shapeOf and reportedShape', () => {
  it('reads the name a pen name passes for, whichever way it is spelled', () => {
    expect(shapeOf('OʼNeil')).toBe("o'neil")
    expect(shapeOf("O'Neil")).toBe("o'neil")
    expect(shapeOf('Јоу')).toBe('joy')
  })

  it('reads capitals as typed, not from the lowercased key', () => {
    // Greek capital Nu is drawn as N; its small letter is a rounded v
    expect(shapeOf('ΝΟΑ')).toBe('noa')
  })

  it('has no shape for a name that tidies to nothing', () => {
    expect(shapeOf('  ')).toBeUndefined()
    expect(shapeOf(undefined)).toBeUndefined()
  })

  it('takes the reported name as shown, else the name they go by now', () => {
    expect(reportedShape('OʼNeil', 'Plain Fern')).toBe("o'neil")
    expect(reportedShape(undefined, 'Plain Fern')).toBe('plain fern')
    expect(reportedShape(' ', undefined)).toBeUndefined()
  })
})

describe('generatedNames', () => {
  it('tries plain names first, then numbered ones', () => {
    const names = generatedNames(() => 'Quiet Heron', () => 0)
    expect(names).toHaveLength(12)
    expect(names.slice(0, 6)).toEqual(Array(6).fill('Quiet Heron'))
    expect(names.slice(6)).toEqual(Array(6).fill('Quiet Heron 10'))
  })
})

describe('firstFree', () => {
  it('gives the first name found free', async () => {
    await expect(firstFree(['a', 'b', 'c'], async (name) => name !== 'a')).resolves.toBe('b')
  })

  it('gives nothing when every name is taken, the last one included', async () => {
    const checked: string[] = []
    const isFree = vi.fn(async (name: string) => {
      checked.push(name)
      return false
    })
    await expect(firstFree(['a', 'b', 'c'], isFree)).resolves.toBeUndefined()
    expect(checked).toEqual(['a', 'b', 'c'])
  })

  it('never gives a name it did not check', async () => {
    const checked = new Set<string>()
    const given = await firstFree(['a', 'b', 'c'], async (name) => {
      checked.add(name)
      return name === 'c'
    })
    expect(given).toBe('c')
    expect(checked.has('c')).toBe(true)
  })
})
