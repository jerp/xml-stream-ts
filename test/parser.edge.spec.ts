import { describe, expect, it } from 'vitest'

import { createParser, NamespaceMap, stringTextContent, TagResolver } from '../src/index.ts'

const textEncoder = new TextEncoder()

async function parseXmlChunks<T extends object>(root: TagResolver<T>, context: T, chunks: string[]): Promise<T[]> {
  const parser = createParser<T>(root, context)
  const writer = parser.writable.getWriter()

  for (const chunk of chunks) {
    await writer.write(textEncoder.encode(chunk))
  }
  await writer.close()

  const out: T[] = []
  for await (const item of parser.readable) {
    out.push(item)
  }
  return out
}

describe('xml-stream-ts edge behavior', () => {
  it('decodes escaped entities in text content', async () => {
    type Context = { value?: string | null }

    const nsMap = NamespaceMap.create({ '': 'urn:test' })
    const root = new TagResolver<Context>({
      onEnd() {
        return { value: this.value }
      },
    }, nsMap, 'root')

    root.onLeaf('value', {
      onTextContent(textContent) {
        this.value = stringTextContent(textContent)
      },
    })

    const results = await parseXmlChunks(root, {}, [
      '<root xmlns="urn:test"><value>Tom &amp; Jerry &lt;3&gt; &quot;ok&quot; &apos;yes&apos;</value></root>',
    ])

    expect(results).toEqual([{ value: 'Tom & Jerry <3> "ok" \'yes\'' }])
  })

  it('parses CDATA blocks as plain text', async () => {
    type Context = { body?: string | null }

    const nsMap = NamespaceMap.create({ '': 'urn:test' })
    const root = new TagResolver<Context>({
      onEnd() {
        return { body: this.body }
      },
    }, nsMap, 'root')

    root.onLeaf('body', {
      onTextContent(textContent) {
        this.body = stringTextContent(textContent)
      },
    })

    const results = await parseXmlChunks(root, {}, [
      '<root xmlns="urn:test"><body><![CDATA[raw <xml> & symbols]]></body></root>',
    ])

    expect(results).toEqual([{ body: 'raw <xml> & symbols' }])
  })

  it('parses input fragmented into extremely tiny chunks', async () => {
    type Context = { title?: string | null }

    const nsMap = NamespaceMap.create({ '': 'urn:test' })
    const root = new TagResolver<Context>({
      onEnd() {
        return { title: this.title }
      },
    }, nsMap, 'root')

    root.onLeaf('title', {
      onTextContent(textContent) {
        this.title = stringTextContent(textContent)
      },
    })

    const xml = '<root xmlns="urn:test"><title>Chunked XML stream</title></root>'
    const chunks: string[] = []
    for (let i = 0; i < xml.length; i += 3) {
      chunks.push(xml.slice(i, i + 3))
    }

    await expect(parseXmlChunks(root, {}, chunks)).resolves.toEqual([
      { title: 'Chunked XML stream' },
    ])
  })

  it('parses comments, attributes, and text across single-byte chunks', async () => {
    type Context = { id?: string | null; value?: string | null; comments: string[] }

    const nsMap = NamespaceMap.create({ '': 'urn:test' })
    const root = new TagResolver<Context>({
      attributes: ['id'],
      onStart(attributes) {
        this.id = stringTextContent(attributes.id)
      },
      onComment(commentBytes) {
        this.comments.push(stringTextContent(commentBytes) ?? '')
      },
      onEnd() {
        return { id: this.id, value: this.value, comments: this.comments.slice() }
      },
    }, nsMap, 'root')

    root.onLeaf('value', {
      onTextContent(textContent) {
        this.value = stringTextContent(textContent)
      },
    })

    const xml = '<root xmlns="urn:test" id="abc-123"><!--split comment--><value>A &amp; B</value></root>'

    await expect(parseXmlChunks(root, { comments: [] }, Array.from(xml))).resolves.toEqual([
      { id: 'abc-123', value: 'A & B', comments: ['split comment'] },
    ])
  })

  it('does not treat > inside a split quoted attribute as the end of the tag', async () => {
    type Context = { label?: string | null }

    const nsMap = NamespaceMap.create({ '': 'urn:test' })
    const root = new TagResolver<Context>({
      attributes: ['label'],
      onStart(attributes) {
        this.label = stringTextContent(attributes.label)
      },
      onEnd() {
        return { label: this.label }
      },
    }, nsMap, 'root')

    const xml = '<root xmlns="urn:test" label="a>b"></root>'

    await expect(parseXmlChunks(root, {}, Array.from(xml))).resolves.toEqual([
      { label: 'a>b' },
    ])
  })

  it('surfaces malformed XML as a stream error', async () => {
    type Context = { title?: string | null }

    const nsMap = NamespaceMap.create({ '': 'urn:test' })
    const root = new TagResolver<Context>({
      onEnd() {
        return { title: this.title }
      },
    }, nsMap, 'root')

    root.onLeaf('title', {
      onTextContent(textContent) {
        this.title = stringTextContent(textContent)
      },
    })

    const parser = createParser<Context>(root, {})
    const writer = parser.writable.getWriter()
    await writer.write(textEncoder.encode('<root xmlns="urn:test"><title>Broken'))
    await writer.close()

    const consume = async () => {
      for await (const _item of parser.readable) {
      }
    }

    await expect(consume()).rejects.toThrow(/Unexpected end of XML stream/)
  })
})
