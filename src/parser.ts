
import { AttributeNameMatcher, NamespaceMap, NO_XML_PREFIX, PREDEFINED_XML_NAMESPACE } from "./names.ts"

import { TagResolver } from "./tagParser.ts"
import type { TagAttributes } from "./tagParser.ts"

interface CaptureFn {
  (...args: any[]): void
}

class XMLTransformStream<T extends any = any> implements TransformStream<Uint8Array<ArrayBuffer>, T> {
  readonly readable: ReadableStream<T>;
  readonly writable: WritableStream<Uint8Array<ArrayBuffer>>;
  constructor(readable: ReadableStream<T>, writable: WritableStream<Uint8Array<ArrayBuffer>>) {
    this.readable = readable
    this.writable = writable
  }
}

interface CapturedTagName { prefixBegin: number, prefixLength?: number, nameBegin: number, nameLength: number }
interface CapturedAttValue { prefixBegin?: number, prefixLength?: number, nameBegin: number, nameLength: number, value: Uint8Array<ArrayBuffer> }

const NOOP_CONTROLLER: ReadableStreamDefaultController<any> = {
  enqueue() { },
  close() { },
  error() { },
  desiredSize: 0,
}

//const EMPTY_FROZEN_OBJECT = Object.freeze({})
const EMPTY_SEQUENCE = new Uint8Array(0)
const NO_ATTRIBUTES = Object.freeze({}) as TagAttributes

export function createParser<
  C extends object = any,
>(rootResolver: TagResolver<any, any>, context: any = {}) {
  const textContentBuffer = createTextBuffer(0x3c /*<*/)
  const dqValueBuffer = createTextBuffer(0x22 /* " */)
  const sqValueBuffer = createTextBuffer(0x27 /* ' */)
  let controller: ReadableStreamDefaultController<C> = NOOP_CONTROLLER
  let resolver = new TagResolver<C>({}, rootResolver.nsMap, '/')
  resolver.addChildResolver(rootResolver)
  const resolverStack = [resolver]
  let pendingCaptureFn: CaptureFn | null = null
  let seenLength = 0
  let begin = 0
  let end = 0
  let o = 0
  let tailBuffer = new TailBuffer()
  let pendingException: XmlParserException | null = null
  let bytes = new Uint8Array(0)
  const readable = new ReadableStream<C>({
    start(readableController) {
      controller = readableController
    },
    cancel() {
      controller = NOOP_CONTROLLER
    },
    pull(_controller) {
    }
  })
  const writable = new WritableStream<Uint8Array<ArrayBuffer>>({
    write(chunk) {
      try {
        const { front, tail } = tailBuffer.addChunk(chunk)
        if (front) {
          bytes = front
          parse()
          pendingException = null
        }
        if (tail) {
          bytes = tail
          parse()
          pendingException = null
        }
      } catch (err) {
        if (err instanceof XmlParserException) {
          // this is potentially resumable at next chunk, so save the tail for next round of parsing
          if (err instanceof XmlParserStartTagException) {
            dqValueBuffer.reset()
            sqValueBuffer.reset()
          }
          tailBuffer.saveTail(bytes, begin, end, 0)
          pendingException = err
        } else {
          controller.error(err instanceof Error ? err : new Error(String(err)))
        }
      }
    },
    close() {
      if (pendingException) {
        controller.error(new XmlParserError(pendingException, bytes, seenLength))
        return
      }
      if (pendingCaptureFn || resolver !== resolverStack[0] || resolverStack.length > 1) {
        controller.error(new Error('Unexpected end of XML stream'))
        return
      }
      controller.close()
    },
  });

  return new XMLTransformStream(readable, writable)

  function parse(): void {
    begin = o = 0
    end = bytes.length
    while (o < end) {
      if (pendingCaptureFn) {
        pendingCaptureFn()
        continue
      }
      if (bytes[o] !== 0x3c /*<*/) {
        captureTextContent()
        continue
      }
      if (o + 1 === end) throw new XmlParserStartTagException(o, 'tag opening')
      let b = bytes[++o]
      switch (b) {
        case 0x2f /*/*/:
          o++
          captureEndTagClosing()
          break
        case 0x21 /*!*/:
          o++
          tokenizeExclamTag()
          break
        case 0x3f /*?*/:
          o++
          skippingQuestionTag()
          break
        default:
          captureStartTagOpening()
      }
      begin = o
    }
    if (!pendingCaptureFn) tailBuffer.reset()
    seenLength += bytes.length
  }
  // CaptureFn functions
  function captureStartTagOpening(): void {
    while (o < end && bytes[o] <= 0x20 /* */) o++ // skip spaces before tag name
    let tagName: CapturedTagName = { prefixBegin: o, nameBegin: o, nameLength: 0 }
    let b = bytes[o]
    while (o < end && b > 0x20 /* */ && b !== 0x3a /*:*/ && b !== 0x3e /*>*/ && b !== 0x2f /*/*/) b = bytes[++o] // expecting prefix or local name
    if (o >= end) throw new XmlParserStartTagException(o, 'tag name')
    if (b === 0x3a /*:*/) {
      tagName.prefixLength = o++ - tagName.prefixBegin
      tagName.nameBegin = o
      b = bytes[o]
      while (o < end && b > 0x20 /* */ && b !== 0x3e /*>*/ && b !== 0x2f /*/*/) b = bytes[++o] // expecting local name
      if (o >= end) throw new XmlParserStartTagException(o, 'tag name')
      tagName.nameLength = o - tagName.nameBegin
    } else {
      tagName.nameLength = o - tagName.nameBegin
    }
    if (o >= end) throw new XmlParserStartTagException(o, 'tag body')
    let hasContent: boolean | undefined = true
    const attOffsets: CapturedAttValue[] = []
    while (o < end && (bytes[o] <= 0x20 /* */)) o++ // skip spaces before attribute name
    while (o < end) {
      let b = bytes[o]
      if (bytes[o] === 0x2f /* / */) {
        b = bytes[++o]
        hasContent = undefined
      }
      if (o === end && b !== 0x3e /* > */) {
        throw new XmlParserStartTagException(o, 'tag closing')
      }
      if (b === 0x3e /* > */) {
        o++
        pendingCaptureFn = null
        if (hasContent !== undefined) {
          const [b1, b2] = [bytes[o], bytes[o + 1]]
          if (b1 === 0x3c /*<*/ && b2 === 0x2f /*/*/) {
            scanEndTagClosing()
            hasContent = false
          }
        }
        return resolveOnStart(tagName, attOffsets, hasContent)
      }
      if (b === 0x78 /* x */ && bytes[o + 1] === 0x6d /* m */ && bytes[o + 2] === 0x6c /* l */ && bytes[o + 3] === 0x6e /* n */ && bytes[o + 4] === 0x73 /* s */) {
        const isDefaultNS = bytes[o + 5] !== 0x3a /*:*/
        const nsNameOffset = o += isDefaultNS ? 5 : 6
        if (!isDefaultNS) {
          b = bytes[o]
          while (o < end && b > 0x20 /* */ && b !== 0x3d /*=*/ && b !== 0x3e /*>*/ && b !== 0x2f /*/*/) b = bytes[++o] // name of the namespace declaration
        }
        if (o >= end) throw new XmlParserStartTagException(o, 'tag body')
        const nsNameEnd = o
        while (o < end && (bytes[o] <= 0x20 /* */)) o++ // skip spaces before =
        if (bytes[o] === 0x3d /* = */) {
          o++
          while (o < end && (bytes[o] <= 0x20 /* */)) o++ // skip spaces after =
          const q = bytes[o]
          if (o >= end) throw new XmlParserStartTagException(o, 'namespace uri')
          if (q !== 0x22 /* " */ && q !== 0x27 /* ' */) throwFatalError(new XmlParserStartTagException(o, 'expecting namespace uri'))
          const valueBuffer = q === 0x27 /* ' */ ? sqValueBuffer : dqValueBuffer
          const uri = valueBuffer.append(bytes, ++o)
          if (!uri.bytes) throw new XmlParserStartTagException(o, 'closing quote for namespace uri')
          const prefix = isDefaultNS ? null : bytes.subarray(nsNameOffset, nsNameEnd)
          resolver.nsMap = resolver.nsMap.registerNS(prefix, uri.bytes!)
          o = uri.o + 1
        }
      } else {
        const attOffset: CapturedAttValue = { nameBegin: o, nameLength: 0, value: EMPTY_SEQUENCE }
        while (o < end && b > 0x20 /* */ && b !== 0x3a /*:*/ && b !== 0x3d /*=*/ && b !== 0x3e /*>*/ && b !== 0x2f /*/*/) b = bytes[++o] // expecting prefix or local name
        if (o >= end) throw new XmlParserStartTagException(o, 'tag body')
        if (bytes[o] === 0x3a /*:*/) {
          attOffset.prefixBegin = attOffset.nameBegin
          attOffset.prefixLength = o++ - attOffset.prefixBegin
          attOffset.nameBegin = o
          b = bytes[o]
          while (o < end && b > 0x20 /* */ && b !== 0x3d /*=*/ && b !== 0x3e /*>*/ && b !== 0x2f /*/*/) b = bytes[++o] // expecting local name
          if (o >= end) throw new XmlParserStartTagException(o, 'tag body')
          attOffset.nameLength = o - attOffset.nameBegin
        } else {
          attOffset.nameLength = o - attOffset.nameBegin
        }
        if (!attOffset.nameLength) throwFatalError(new XmlParserStartTagException(o, 'expecting attribute name'))
        while (o < end && (bytes[o] <= 0x20 /* */)) o++ // skip spaces before =
        if (o >= end) throw new XmlParserStartTagException(o, 'tag body')
        if (bytes[o] === 0x3d /*=*/) {
          o++
          while (o < end && (bytes[o] <= 0x20 /* */)) o++ // skip spaces after =
          if (o >= end) throw new XmlParserStartTagException(o, 'tag body')
          let q = bytes[o]
          if (o >= end) throw new XmlParserStartTagException(o, 'attribute value')
          if (q !== 0x22 /* " */ && q !== 0x27 /* ' */) throwFatalError(new XmlParserStartTagException(o, 'expecting attribute value'))
          const valueBuffer = q === 0x27 /* ' */ ? sqValueBuffer : dqValueBuffer
          const attValue = valueBuffer.append(bytes, ++o)
          if (!attValue.bytes) throw new XmlParserStartTagException(o, 'closing quote for attribute value')
          attOffset.value = attValue.bytes!
          if (attOffset.nameLength > 0) attOffsets.push(attOffset)
          o = attValue.o + 1
        }
      }
      while (o < end && (bytes[o] <= 0x20 /* */)) o++ // skip spaces after attribute
    }
    throw new XmlParserStartTagException(o, 'tag body')
  }
  function throwFatalError(exception: XmlParserException) {
    throw new XmlParserError(exception, bytes, seenLength)
  }
  function resolveOnStart(tagNameOffset: CapturedTagName, attOffsets?: CapturedAttValue[], hasContent?: boolean): void {
    const nsMap = resolver.nsMap
    const namespace = tagNameOffset.prefixLength !== undefined ? nsMap.resolveNamespace(bytes, tagNameOffset.prefixBegin, tagNameOffset.prefixLength) : nsMap.resolveNamespace(NO_XML_PREFIX, 0, 0)
    const resolvedStartTag = resolver && resolver.childResolver?.find(bytes, tagNameOffset.nameBegin, tagNameOffset.nameLength, namespace)
    if (!resolvedStartTag) {
      if (hasContent) {
        skipContent(1)
      } else {
        begin = o
      }
      return
    }
    const { fqName, resolver: childResolver } = resolvedStartTag
    const attributes = attOffsets?.length && childResolver.attributeResolvers ? resolveAttributes(nsMap, childResolver.attributeResolvers, attOffsets) : NO_ATTRIBUTES
    const skipNode = childResolver.onStart?.call(context, attributes, fqName, hasContent)
    if (skipNode) {
      skipContent(1)
      return
    }
    if (!hasContent) {
      resolveOnEnd(childResolver)
    } else {
      resolverStack.push(resolver)
      childResolver.nsMap = resolver.nsMap
      resolver = childResolver
    }
  }
  function resolveAttributes(nsMap: NamespaceMap, attributeNames: AttributeNameMatcher, attOffsets: CapturedAttValue[]) {
    const attributes: { [P in string]?: Uint8Array<ArrayBuffer> } = {}
    for (let j = 0; j < attOffsets.length; j++) {
      const attOffset = attOffsets[j]
      const namespace = attOffset.prefixLength !== undefined ? nsMap.resolveNamespace(bytes, attOffset.prefixBegin!, attOffset.prefixLength) : PREDEFINED_XML_NAMESPACE
      const fqName = attributeNames.find(bytes, attOffset.nameBegin, attOffset.nameLength, namespace)
      if (!fqName) continue
      const attributeName = fqName.namespace && fqName.namespace !== PREDEFINED_XML_NAMESPACE ? `${fqName.namespace.prefix}:${fqName.name}` : fqName.name
      attributes[attributeName] = attOffset.value
    }
    return attributes
  }
  function scanEndTagClosing() {
    while (o < end && bytes[o] <= 0x20 /* */) o++ // skip spaces before tag name
    // should check tag name of closing tag match opening tag?
    while (o < end && bytes[o] !== 0x3e /*>*/) o++ // skip all before >
    if (bytes[o] !== 0x3e /*>*/) {
      if (o === end) return tailBuffer.saveTail(bytes, begin, end, 0x3e /*>*/)
      throwFatalError(new XmlParserEndTagException(o, 'tag closing'))
    }
  }
  function captureEndTagClosing() {
    scanEndTagClosing()
    resolveOnEnd(resolver)
    resolver = resolverStack.pop()!
    begin = ++o
    pendingCaptureFn = null
  }
  function resolveOnEnd(resolver: TagResolver) {
    const onEnd = resolver?.onEnd
    if (onEnd) {
      const chunk = onEnd.call(context)
      if (chunk !== undefined) {
        controller.enqueue(chunk)
      }
    }
  }
  function tokenizeExclamTag() {
    if (o === end) throw new XmlParserStartTagException(o, 'markup declaration')
    let b = bytes[o]
    if (b === 0x2d /*-*/) {
      o++
      pendingCaptureFn = tokenizeCommentOpening
    } else if (b === 0x5b /*[*/) {
      o++
      pendingCaptureFn = tokenizeCDATAOpening
    } else {
      pendingCaptureFn = skippingDeclaration
    }
  }
  function tokenizeCommentOpening() {
    if (o === end) throw new XmlParserCommentException(o, '<!--')
    if (bytes[o] !== 0x2d /*-*/) {
      throwFatalError(new XmlParserCommentException(o, '<!--'))
    }
    begin = ++o
    pendingCaptureFn = tokenizeComment
  }
  function tokenizeComment() {
    let b = bytes[o]
    while (o < end && b !== 0x2d /*-*/) b = bytes[++o]
    if (o === end) throw new XmlParserCommentException(o, '-->')
    if (b !== 0x2d /*-*/ || bytes[o + 1] !== 0x2d /*-*/ || bytes[o + 2] !== 0x3e /*>*/) throw new XmlParserCommentException(o, '-->')
    if (resolver && resolver.onComment) {
      resolver.onComment.call(context, bytes.subarray(begin, o))
    }
    o += 3
    pendingCaptureFn = null
  }
  function tokenizeCDATAOpening() {
    if (o + 5 >= end) return
    // [0x43, 0x44, 0x41, 0x54, 0x41, 0x5b]) /*CDATA[*/
    if (bytes[o] !== 0x43 /*C*/ || bytes[o + 1] !== 0x44 /*D*/ || bytes[o + 2] !== 0x41 /*A*/ || bytes[o + 3] !== 0x54 /*T*/ || bytes[o + 4] !== 0x41 /*A*/ || bytes[o + 5] !== 0x5b /*[*/) {
      throwFatalError(new XmlParserCDataException(o, '<![CDATA['))
    }
    o += 6
    begin = o
    pendingCaptureFn = captureCDATA
  }
  function captureCDATA() {
    let b = bytes[o]
    while (o < end && (b !== 0x5d /*]*/)) b = bytes[++o]
    if (o + 2 >= end) throw new XmlParserCDataException(o, ']]>')
    if (b !== 0x5d /*]*/ || bytes[o + 1] !== 0x5d /*]*/ || bytes[o + 2] !== 0x3e /*>*/) return tailBuffer.saveTail(bytes, begin, end, 0x5d /*]*/)
    pushTextContent(bytes.subarray(begin, o))
    o += 3
    begin = o
    pendingCaptureFn = null
  }
  function captureTextContent(): void {
    if (resolver.onTextContent) {
      const textContent = textContentBuffer.append(bytes, o)
      o = textContent.o
      if (textContent.bytes) {
        if (textContent.bytes.length > 0) {
          pushTextContent(textContent.bytes)
        }
        pendingCaptureFn = null
      } else {
        pendingCaptureFn = captureTextContentInto
      }
    } else {
      pendingCaptureFn = skipTextContent
    }
  }
  function skipContent(openedTag = 1, _pendingSkipFn?: CaptureFn): void {
    const startAt = begin
    while (o < end && openedTag > 0) {
      let b = bytes[o]
      while (o < end && b !== 0x3c /*<*/) b = bytes[++o]
      if (o + 1 === end) break
      b = bytes[++o]
      switch (b) {
        case 0x2f /*/*/:
          b = bytes[++o]
          while (b && b !== 0x3e /*>*/) b = bytes[++o] // skip all before >
          if (bytes[o] === 0x3e /*>*/) {
            begin = ++o
            --openedTag
          }
          break
        case 0x21 /*!*/:
          b = bytes[++o]
          if (b === 0x2d /*-*/) {
            b = bytes[++o]
            while (b && (b !== 0x2d /*-*/ || bytes[o + 1] !== 0x3e /*>*/)) b = bytes[++o]
            if (bytes[o + 1] === 0x3e /*>*/) {
              begin = o += 2
            }
          } else if (b === 0x5b /*[*/) {
            b = bytes[++o]
            while (b && (b !== 0x5d /*]*/ || bytes[o + 1] !== 0x5d /*]*/ || bytes[o + 2] !== 0x3e /*>*/)) b = bytes[++o]
            if (bytes[o + 2] === 0x3e /*>*/) {
              begin = o += 3
            }
          } else {
            let openQuote: 0x22 | 0x27 | undefined
            b = bytes[++o]
            while (o < end) {
              if (openQuote && b === openQuote) {
                openQuote = undefined
              } else if (b === 0x22 /* " */ || b === 0x27 /* ' */) {
                openQuote = b
              } else if (!openQuote && b === 0x3e /*>*/) {
                begin = ++o
                break
              }
              b = bytes[++o]
            }
          }
          break
        case 0x3f /*?*/:
          b = bytes[++o]
          while (b && (b !== 0x3f /*?*/ || bytes[o + 1] !== 0x3e /*>*/)) b = bytes[++o]
          if (bytes[o + 1] === 0x3e /*>*/) {
            begin = o += 2
          }
          break
        default:
          openedTag = skipTagOpening(openedTag)
      }
    }
    if (begin === startAt) {
      tailBuffer.saveTail(bytes, begin, end)
    } else {
      tailBuffer.reset()
    }
    if (openedTag === 0) {
      pendingCaptureFn = null
    } else {
      pendingCaptureFn = skipContent.bind(null, openedTag)
    }
  }
  function skipTagOpening(openedTag: number, openQuote?: 0x22 | 0x27): number {
    while (o < end) {
      const b = bytes[o]
      if (openQuote) {
        if (b === openQuote) openQuote = undefined
        o++
      } else if (b === 0x22 /* " */ || b === 0x27 /* ' */) {
        openQuote = b
        o++
      } else if (b === 0x3e /* > */) {
        let previous = o - 1
        while (previous > begin && bytes[previous] <= 0x20 /* */) previous--
        if (bytes[previous] !== 0x2f /*/*/) {
          openedTag++
        }
        begin = o += 1
        return openedTag
      } else {
        o++
      }
    }
    return openedTag
  }
  function skipTextContent(): void {
    let b = bytes[begin]
    o = begin
    while (o < end && b !== 0x3c /*<*/) b = bytes[++o]
    if (b === 0x3c) {
      pendingCaptureFn = null
    } else if (o >= end) {
      pendingCaptureFn = null
    }
  }
  function captureTextContentInto(): void {
    let b = bytes[begin]
    o = begin
    while (b && b !== 0x3c /*<*/) b = bytes[++o]
    const textContent = textContentBuffer.append(bytes, begin)
    o = textContent.o
    if (textContent.bytes) {
      pushTextContent(textContent.bytes)
      pendingCaptureFn = null
    }
  }
  function pushTextContent(textContent: Uint8Array<ArrayBuffer>): void {
    if (resolver.onTextContent) {
      resolver.onTextContent.call(context, textContent)
    }
  }
  function skippingQuestionTag(): CaptureFn | null {
    let b = bytes[o]
    while (o < end && (b !== 0x3f /*?*/ || bytes[o + 1] !== 0x3e /*>*/)) b = bytes[++o]
    if (o + 1 >= end) {
      pendingCaptureFn = skippingQuestionTag
      return pendingCaptureFn
    }
    begin = o += 2
    pendingCaptureFn = null
    return null
  }
  function skippingDeclaration(openQuote?: 0x22 | 0x27, openBrackets = 0): CaptureFn | null {
    let b = bytes[o]
    while (o < end) {
      if (openQuote && b === openQuote) {
        openQuote = undefined;
      } else if (b === 0x22 /* " */ || b === 0x27 /* ' */) {
        openQuote = b;
      } else if (b === 0x5b /* [ */) {
        openBrackets++;
      } else if (b === 0x5d /* ] */) {
        if (openBrackets > 0) {
          openBrackets--;
        }
      } else if (b === 0x3e /* > */ && openBrackets === 0) {
        // skip it all
        o += 1
        return null
      }
      b = bytes[++o];
    }
    return skippingDeclaration.bind(null, openQuote, openBrackets)
  }
}

const DEFAULT_TAIL_BUFFER_CAPACITY = 1024 // 1 KB
export class TailBuffer {
  private bytes: Uint8Array<ArrayBuffer>
  private end: number
  private tailByte: number
  private extendCapacityBy: number
  constructor(extendCapacityBy?: number) {
    this.extendCapacityBy = extendCapacityBy ?? DEFAULT_TAIL_BUFFER_CAPACITY
    this.bytes = new Uint8Array(0)
    this.end = 0
    this.tailByte = 0
  }
  addChunk(bytes: Uint8Array<ArrayBuffer>) {
    if (this.end === 0) {
      return { front: null, tail: bytes }
    }
    if (!this.tailByte) {
      this.appendBytes(bytes, bytes.length)
      const tail = this.bytes.slice(0, this.end)
      this.reset()
      return { front: null, tail }
    }
    let i = 0
    let b = bytes[i]
    const tailByte = this.tailByte
    const end = bytes.length
    while (i < end && b !== tailByte) b = bytes[++i]
    if (b === tailByte) {
      this.appendBytes(bytes, i + 1)
      const front = this.bytes.subarray(0, this.end)
      this.reset()
      return { front, tail: bytes.subarray(i + 1, bytes.length) }
    } else {
      this.appendBytes(bytes, i)
      return { front: null, tail: null }
    }
  }
  saveTail(source: Uint8Array<ArrayBuffer>, begin: number, end: number, tailByte = this.tailByte) {
    const length = end - begin
    if (length > this.bytes.length) {
      while (this.extendCapacityBy < length) this.extendCapacityBy *= 2
      this.bytes = new Uint8Array(this.extendCapacityBy)
    }
    this.bytes.set(source.subarray(begin, end), 0)
    this.end = end - begin
    this.tailByte = tailByte
  }
  reset() {
    this.tailByte = 0
    this.end = 0
  }
  private appendBytes(bytes: Uint8Array<ArrayBuffer>, length: number) {
    if (length === 0) return this
    const minCapacity = this.end + length
    if (minCapacity > this.bytes.length) {
      while (this.extendCapacityBy < minCapacity) this.extendCapacityBy *= 2
      const next = new Uint8Array(this.extendCapacityBy)
      next.set(this.bytes.subarray(0, this.end))
      this.bytes = next
    }
    this.bytes.set(bytes.subarray(0, length), this.end)
    this.end += length
    return this
  }
}

class XmlParserError extends Error {
  constructor(exception: XmlParserException, bytes: Uint8Array<ArrayBuffer>, seenLength: number) {
    const preContext = bytes.subarray(Math.max(0, exception.position - 10), exception.position)
    const postContext = bytes.subarray(exception.position, Math.min(bytes.length, exception.position + 10))
    const contextStr = new TextDecoder().decode(preContext) + 'ꞈ' + new TextDecoder().decode(postContext)
    const locationName = exception.location ? ` in ${exception.location}` : ''
    const message = `Error in ${locationName} ${exception.message ?? ''} (at position ${exception.position + seenLength}): ${contextStr}`
    super(message)
  }
}
class XmlParserException<L extends string = string> extends Error {
  position: number
  location?: L
  tailByte = 0
  constructor(position: number, message?: string, location?: L) {
    super(message)
    this.position = position
    this.location = location
  }
}
class XmlParserStartTagException extends XmlParserException<'start'> {
  tailByte = 0x3e /*>*/
  constructor(position: number, expecting: string) {
    super(position, `Expecting ${expecting}`, 'start')
  }
}
class XmlParserEndTagException extends XmlParserException<'end'> {
  tailByte = 0x3e /*>*/
  constructor(position: number, expecting: string) {
    super(position, `Expecting ${expecting}`, 'end')
  }
}
class XmlParserCommentException extends XmlParserException<'comment'> {
  tailByte = 0x2d /*-*/
  constructor(position: number, expecting: string) {
    super(position, `Expecting ${expecting}`, 'comment')
  }
}
class XmlParserCDataException extends XmlParserException<'cdata'> {
  tailByte = 0x5d /*]*/
  constructor(position: number, expecting: string) {
    super(position, `Expecting ${expecting}`, 'cdata')
  }
}


interface TextBuffer {
  append(bytesToAppend: Uint8Array<ArrayBuffer>, o: number): { o: number, bytes?: Uint8Array<ArrayBuffer> }
  reset(): void
  //flush(): Uint8Array<ArrayBuffer>
}

function createTextBuffer(upTo: 0x3c /* < */ | 0x22 /* " */ | 0x27 /* ' */, expandCapacityBy = 1024): TextBuffer {
  let at = 0
  let flushedAt = 0
  let byteBuffer = new Uint8Array(expandCapacityBy)
  let pendingCR = false
  const utf8Buffer: TextBuffer = {
    append(bytesToAppend, begin) {
      let o = begin
      if (pendingCR) {
        if (bytesToAppend[o] === 0x0a /*\n*/) o++
        checkCapacity(1)
        byteBuffer[at++] = 0x0a /*\n*/
        begin = o
        pendingCR = false
      }
      while (o < bytesToAppend.length) {
        const b = bytesToAppend[o]
        if (b === upTo) {
          if (at > flushedAt) {
            appendBytes(bytesToAppend, begin, o)
            const textContent = byteBuffer.slice(flushedAt, at)
            flushedAt = at
            return { bytes: textContent, o }
          }
          return { bytes: bytesToAppend.subarray(begin, o), o }
        }
        if (b === 0x0d /*\r*/) {
          appendBytes(bytesToAppend, begin, o)
          if (o + 1 >= bytesToAppend.length) {
            pendingCR = true
            return { o: o + 1 }
          }
          if (bytesToAppend[o + 1] === 0x0a /*\n*/) {
            o += 2
          } else {
            o++
          }
          checkCapacity(1)
          byteBuffer[at++] = 0x0a /*\n*/
          begin = o
          continue
        }
        o++
      }
      appendBytes(bytesToAppend, begin, o)
      return { o }
    },
    reset() {
      at = 0
      flushedAt = 0
      pendingCR = false
    },
  }
  return utf8Buffer
  function appendBytes(bytesToAppend: Uint8Array<ArrayBuffer>, begin: number, end: number) {
    const addLength = end - begin
    checkCapacity(addLength)
    byteBuffer.set(bytesToAppend.subarray(begin, end), at)
    at += addLength
  }
  function checkCapacity(addLength: number) {
    const requiredCapacity = at + addLength
    if (requiredCapacity > byteBuffer.length && flushedAt > 0) {
      byteBuffer.copyWithin(0, flushedAt, at)
      at -= flushedAt
      flushedAt = 0
    }
    if (requiredCapacity <= byteBuffer.length) return
    while (byteBuffer.length + expandCapacityBy < requiredCapacity) expandCapacityBy *= 2
    const next = new Uint8Array(byteBuffer.length + expandCapacityBy)
    next.set(byteBuffer, 0)
    byteBuffer = next
  }
}
