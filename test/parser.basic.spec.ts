import { describe, expect, it } from 'vitest'

import {
  boolean,
  createParser,
  decimal,
  equals,
  leafParser,
  NamespaceMap,
  rootResolver,
  stringTextContent,
  TagResolver,
} from '../src/index.ts'

const textEncoder = new TextEncoder()

interface Result {
  title?: string | null
}

async function parseXml<T extends object>(
  root: TagResolver<T>,
  context: T,
  xml: string,
  chunkSize = xml.length,
): Promise<T[]> {
  const parser = createParser<T>(root, context)
  const writer = parser.writable.getWriter()

  for (let i = 0; i < xml.length; i += chunkSize) {
    const chunk = xml.slice(i, i + chunkSize)
    await writer.write(textEncoder.encode(chunk))
  }
  await writer.close()

  const results: T[] = []
  for await (const result of parser.readable) {
    results.push(result)
  }
  return results
}

async function parseXmlChunks<T extends object>(
  root: TagResolver<T>,
  context: T,
  chunks: string[],
): Promise<T[]> {
  const parser = createParser<T>(root, context)
  const writer = parser.writable.getWriter()

  for (const chunk of chunks) {
    await writer.write(textEncoder.encode(chunk))
  }
  await writer.close()

  const results: T[] = []
  for await (const result of parser.readable) {
    results.push(result)
  }
  return results
}

describe('xml-stream-ts basic behavior', () => {
  it('parses a leaf text node from a stream', async () => {
    const nsMap = NamespaceMap.create({ '': 'urn:test' })
    const root = new TagResolver<Result>({
      onEnd() {
        return { title: this.title }
      },
    }, nsMap, 'root')
    root.onLeaf('title', {
      onTextContent(textContent) {
        this.title = stringTextContent(textContent)
      },
    })

    const results = await parseXml(root, {}, '<root xmlns="urn:test"><title>Hello XML</title></root>')

    expect(results).toEqual([{ title: 'Hello XML' }])
  })

  it('parses nested children and attributes into a typed object', async () => {
    type BookContext = {
      id?: string | null
      title?: string | null
      price?: number | null
      available?: boolean | null
    }

    const nsMap = NamespaceMap.create({ '': 'urn:book', xml: 'http://www.w3.org/XML/1998/namespace' })
    const root = new TagResolver<BookContext>({
      onEnd() {
        return {
          id: this.id,
          title: this.title,
          price: this.price,
          available: this.available,
        }
      },
      attributes: ['xml:lang'],
      onStart(attributes) {
        this.id = stringTextContent(attributes.lang)
      },
    }, nsMap, 'book')

    root.onLeaf('title', {
      onTextContent(textContent) {
        this.title = stringTextContent(textContent)
      },
    })
    root.onLeaf('price', {
      onTextContent(textContent) {
        this.price = decimal(textContent)
      },
    })
    root.onLeaf('available', {
      onTextContent(textContent) {
        this.available = boolean(textContent)
      },
    })

    const xml = '<book xmlns="urn:book" xml:lang="bk-001"><title>XML Guide</title><price>19.95</price><available>true</available></book>'
    const results = await parseXml(root, {}, xml)

    expect(results).toEqual([
      { id: 'bk-001', title: 'XML Guide', price: 19.95, available: true },
    ])
  })

  it('builds a readable resolver with inferred attribute keys', async () => {
    type BookContext = {
      lang?: string | null
      title?: string | null
    }

    const nsMap = NamespaceMap.create({ '': 'urn:book', xml: 'http://www.w3.org/XML/1998/namespace' })
    const root = rootResolver<BookContext>()('book', nsMap, {
      attributes: ['lang'] as const,
      onStart(attributes) {
        this.lang = stringTextContent(attributes.lang)
      },
      onEnd() {
        return {
          lang: this.lang,
          title: this.title,
        }
      },
    })

    root.onLeaf('title', leafParser<BookContext>()({
      onTextContent(textContent) {
        this.title = stringTextContent(textContent)
      },
    }))

    const results = await parseXml(root, {}, '<book xmlns="urn:book" xml:lang="en"><title>Readable API</title></book>')

    expect(results).toEqual([{ lang: 'en', title: 'Readable API' }])
  })

  it('decodes escaped entities and comments in text content', async () => {
    type FeedContext = { body?: string | null; comments: string[] }

    const nsMap = NamespaceMap.create({ '': 'urn:feed' })
    const root = new TagResolver<FeedContext>({
      onEnd() {
        return { body: this.body, comments: this.comments.slice() }
      },
      onComment(commentBytes) {
        this.comments.push(stringTextContent(commentBytes) ?? '')
      },
    }, nsMap, 'entry')

    root.onLeaf('body', {
      onTextContent(textContent) {
        this.body = stringTextContent(textContent)
      },
    })

    const xml = '<entry xmlns="urn:feed"><!--teaser--><body>Tom &amp; Jerry &lt;3&gt; &amp; friends</body></entry>'
    const results = await parseXml(root, { comments: [] }, xml)

    expect(results).toEqual([{ body: 'Tom & Jerry <3> & friends', comments: ['teaser'] }])
  })

  it('parses one XML document split across stream chunks', async () => {
    type ChunkContext = { titles: string[] }

    const nsMap = NamespaceMap.create({ '': 'urn:chunk' })
    const root = new TagResolver<ChunkContext>({
      onEnd() {
        return { titles: this.titles.slice() }
      },
    }, nsMap, 'root')

    root.onLeaf('title', {
      onTextContent(textContent) {
        this.titles.push(stringTextContent(textContent) ?? '')
      },
    })

    const results = await parseXmlChunks(root, { titles: [] }, [
      '<root xmlns="urn:chunk"><title>First</title>',
      '<title>Second</title></root>',
    ])

    expect(results).toEqual([{ titles: ['First', 'Second'] }])
  })

  it('can skip unmatched branches and capture only target tags', async () => {
    type EventContext = { event?: string | null }

    const nsMap = NamespaceMap.create({ '': 'urn:events' })
    const root = new TagResolver<EventContext>({
      onEnd() {
        return { event: this.event }
      },
    }, nsMap, 'payload')

    root.onLeaf('event', {
      onTextContent(textContent) {
        this.event = stringTextContent(textContent)
      },
    })

    const xml = '<payload xmlns="urn:events"><debug><trace><id>ignore-me</id></trace></debug><event>ORDER_CREATED</event></payload>'
    const results = await parseXml(root, {}, xml)

    expect(results).toEqual([{ event: 'ORDER_CREATED' }])
    expect(equals('ORDER_CREATED')(textEncoder.encode(results[0].event ?? ''))).toBe(true)
  })

  it('can capture attribute with namespace', async () => {
    type EventContext = { event?: string | null, level?: string | null }

    const nsMap = NamespaceMap.create({ 'ev': 'urn:events' })
    const root = new TagResolver<EventContext>({
      onEnd() {
        return { event: this.event }
      },
    }, nsMap, 'payload')

    root.onLeaf('event', {
      attributes: ['ev:level'] as const,
      onStart(attributes) {
        this.level = stringTextContent(attributes['ev:level'])
      },
      onTextContent(textContent) {
        this.event = stringTextContent(textContent)
      },
    })

    const xml = '<payload xmlns:ev="urn:events" ev:level="high"><debug><trace><id>ignore-me</id></trace></debug><event>ORDER_CREATED</event></payload>'
    const results = await parseXml(root, {}, xml)

    expect(results).toEqual([{ event: 'ORDER_CREATED' }])
    expect(equals('ORDER_CREATED')(textEncoder.encode(results[0].event ?? ''))).toBe(true)
  })
})
