# @jerp/xml-stream-ts

A small TypeScript XML stream parser for extracting selected elements, text, attributes, and comments from arbitrarily chunked input.

It is designed for event-style parsing: define the tags you care about, stream bytes in, and receive parsed results as the matching root elements close. Unmatched branches are skipped.

## Install

```sh
npm install @jerp/xml-stream-ts
```

## Usage

```ts
import {
  createParser,
  decimal,
  leafParser,
  NamespaceMap,
  rootResolver,
  stringTextContent,
} from '@jerp/xml-stream-ts'

interface Book {
  lang?: string | null
  title?: string | null
  price?: number | null
}

const nsMap = NamespaceMap.create({
  '': 'urn:book',
  xml: 'http://www.w3.org/XML/1998/namespace',
})

const book = rootResolver<Book>()('book', nsMap, {
  attributes: ['xml:lang'] as const,
  onStart(attributes) {
    this.lang = stringTextContent(attributes.lang)
  },
  onEnd() {
    return {
      lang: this.lang,
      title: this.title,
      price: this.price,
    }
  },
})

book.onLeaf('title', leafParser<Book>()({
  onTextContent(textContent) {
    this.title = stringTextContent(textContent)
  },
}))

book.onLeaf('price', leafParser<Book>()({
  onTextContent(textContent) {
    this.price = decimal(textContent)
  },
}))

const parser = createParser<Book>(book, {})
const writer = parser.writable.getWriter()

await writer.write(new TextEncoder().encode('<book xmlns="urn:book" xml:lang="en">'))
await writer.write(new TextEncoder().encode('<title>XML Guide</title><price>19.95</price></book>'))
await writer.close()

for await (const book of parser.readable) {
  console.log(book)
  // { lang: 'en', title: 'XML Guide', price: 19.95 }
}
```

## Typed Resolvers

`rootResolver`, `tagParser`, and `leafParser` are convenience helpers around `TagResolver`. They keep resolver declarations readable while preserving TypeScript validation for callback `this` values and attribute names.

Use `as const` on `attributes` when you want precise keys in `onStart`:

```ts
const root = rootResolver<Book>()('book', nsMap, {
  attributes: ['xml:lang', 'id'] as const,
  onStart(attributes) {
    attributes.lang // Uint8Array | undefined
    attributes.id // Uint8Array | undefined
  },
})
```

Namespaced attribute keys use the local name at runtime, so `xml:lang` is read as `attributes.lang`.

The parser callbacks receive `Uint8Array` text. Use the exported value resolvers to decode only when needed:

```ts
stringTextContent(bytes) // string | null
decimal(bytes) // number | null
```

## Scope

This library parses XML elements, text, comments, attributes, namespaces, and CDATA. Processing instructions and declarations are skipped. Unmatched element branches are skipped without building a DOM.

Input is accepted as `Uint8Array` chunks through a `WritableStream`, and chunks may split anywhere in the document, including inside tag names, attributes, comments, and text.

## Development

```sh
npm install
npm run build
npm test
```

## Publishing

This package is intended to be published as `@jerp/xml-stream-ts` using npm Trusted Publishing from GitHub Actions.
