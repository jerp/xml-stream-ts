import type { TagResolver } from "./tagParser.ts"

export const NO_XML_PREFIX = new Uint8Array(0)
const PREDEFINED_XML_PREFIX = "xml"
const PREDEFINED_XML_URI = 'http://www.w3.org/XML/1998/namespace'
const XMLNS_PREFIX = "xmlns"
const XMLNS_URI = 'http://www.w3.org/2000/xmlns/'

export const PREDEFINED_XML_NAMESPACE: Namespace = { prefix: PREDEFINED_XML_PREFIX, uri: PREDEFINED_XML_URI }
export const XMLNS_NAMESPACE: Namespace = { prefix: XMLNS_PREFIX, uri: XMLNS_URI }

export interface Namespace {
  readonly prefix: string
  readonly uri: string
}

export interface FQName {
  readonly namespace: Namespace
  readonly name: string
}

const textDecoder = new TextDecoder()
const textEncoder = new TextEncoder()

export class TagNameMatcher<T> {
  private nameMap = new Map<Namespace | undefined, Array<{ name: Uint8Array<ArrayBuffer>, fqName: FQName, resolver: TagResolver<T>, }>>()
  setName(resolver: TagResolver<T>, tagName: string, namespace: Namespace = PREDEFINED_XML_NAMESPACE) {
    for (const [ns, localNames] of this.nameMap.entries()) {
      if (ns === namespace && localNames.some(({ fqName }) => fqName.name === tagName)) {
        return
      }
    }
    if (!this.nameMap.has(namespace)) {
      this.nameMap.set(namespace, [])
    }
    const name = textEncoder.encode(tagName)
    this.nameMap.get(namespace)!.push({ name, fqName: { name: tagName, namespace }, resolver })
  }
  find(bytes: Uint8Array<ArrayBuffer>, begin: number, length: number, namespace: Namespace = PREDEFINED_XML_NAMESPACE): { fqName: FQName, resolver: TagResolver<T> } | undefined {
    const fqNameMatches = this.nameMap.get(namespace)
    if (fqNameMatches) {
      const matched = fqNameMatches.find(({ name }) => name.length === length && name.every((value, index) => value === bytes[begin + index]))
      if (matched) {
        return { fqName: matched.fqName, resolver: matched.resolver }
      }
    }
  }
}
export class AttributeNameMatcher {
  private nameMap = new Map<Namespace | undefined, Array<{ name: Uint8Array<ArrayBuffer>, fqName: FQName }>>()
  setName(attributeName: string, namespace: Namespace = PREDEFINED_XML_NAMESPACE) {
    for (const [ns, localNames] of this.nameMap.entries()) {
      if (ns === namespace && localNames.some(({ fqName }) => fqName.name === attributeName)) {
        return
      }
    }
    if (!this.nameMap.has(namespace)) {
      this.nameMap.set(namespace, [])
    }
    const name = textEncoder.encode(attributeName)
    this.nameMap.get(namespace)!.push({ name, fqName: { name: attributeName, namespace } })
  }
  find(bytes: Uint8Array<ArrayBuffer>, begin: number, length: number, namespace: Namespace = PREDEFINED_XML_NAMESPACE): FQName | undefined {
    const fqNameMatches = this.nameMap.get(namespace)
    if (fqNameMatches) {
      const matched = fqNameMatches.find(({ name }) => name.length === length && name.every((value, index) => value === bytes[begin + index]))
      if (matched) {
        return matched.fqName
      }
    }
  }
}

export class NamespaceMap {
  prefixes: Readonly<Uint8Array<ArrayBuffer>>[]
  uris: Readonly<Uint8Array<ArrayBuffer>>[]
  namespaces: Namespace[]
  private constructor(prefixes: Uint8Array<ArrayBuffer>[], uris: Uint8Array<ArrayBuffer>[], namespaces: Namespace[]) {
    this.prefixes = prefixes
    this.uris = uris
    this.namespaces = namespaces
  }
  static create(nsMap: Record<string, string>) {
    const nsList = Object.entries(nsMap).filter(([prefix, uri]) => {
      return prefix !== 'xml' && uri !== PREDEFINED_XML_URI && prefix !== 'xmlns' && uri !== XMLNS_URI
    }).map(([prefix, uri]) => ({ prefix, uri }))
    const prefixes = [PREDEFINED_XML_PREFIX, XMLNS_PREFIX].concat(nsList.map(ns => ns.prefix)).map(prefix => textEncoder.encode(prefix))
    const uris = [PREDEFINED_XML_URI, XMLNS_URI].concat(nsList.map(ns => ns.uri)).map(uri => textEncoder.encode(uri))
    const namespaces = [PREDEFINED_XML_NAMESPACE, XMLNS_NAMESPACE].concat(nsList)
    return new NamespaceMap(prefixes, uris, namespaces)
  }
  registerNS(prefixBuffer: Uint8Array<ArrayBuffer> | null, nsUriBuffer: Uint8Array<ArrayBuffer>): NamespaceMap {
    const prefixIndex = this.indexOfUri(nsUriBuffer)
    if (prefixIndex === -1) {
      const prefix = prefixBuffer ? prefixBuffer.slice() : NO_XML_PREFIX
      this.prefixes.push(prefix)
      this.uris.push(nsUriBuffer.slice())
      this.namespaces.push({ prefix: textDecoder.decode(prefix), uri: textDecoder.decode(nsUriBuffer) })
      return this
    } else {
      const existingPrefixIndex = this.indexOfPrefix(prefixBuffer ?? NO_XML_PREFIX)
      if (existingPrefixIndex === prefixIndex) {
        return this
      }
      const clonedPrefixes = this.prefixes.slice()
      clonedPrefixes[prefixIndex] = prefixBuffer ? prefixBuffer.slice() : NO_XML_PREFIX
      const clonedMap = new NamespaceMap(clonedPrefixes, this.uris, this.namespaces)
      return clonedMap
    }
  }
  resolveNamespace(bytes: ArrayLike<number>, begin: number, prefixLength: number): Namespace {
    for (let i = this.prefixes.length - 1; i >= 0; i--) {
      const prefix = this.prefixes[i]
      if (prefix.length !== prefixLength) continue
      let matches = true
      for (let o = 0; o < prefixLength; o++) {
        if (prefix[o] !== bytes[begin + o]) {
          matches = false
          break
        }
      }
      if (matches) {
        return this.namespaces[i]
      }
    }
    return PREDEFINED_XML_NAMESPACE
  }
  get(prefix?: string): Namespace | undefined {
    return this.namespaces.find(ns => ns.prefix === prefix)
  }

  private indexOfPrefix(prefixBuffer: Uint8Array<ArrayBuffer>): number {
    for (let i = this.prefixes.length - 1; i >= 0; i--) {
      const prefix = this.prefixes[i]
      if (prefixBuffer.length === prefix.length && prefixBuffer.every((value, index) => value === prefix[index])) {
        return i
      }
    }
    return -1
  }
  private indexOfUri(uriBuffer: Uint8Array<ArrayBuffer>) {
    for (let i = this.uris.length - 1; i >= 0; i--) {
      const uri = this.uris[i]
      if (uriBuffer.length === uri.length && uriBuffer.every((value, index) => value === uri[index])) return i
    }
    return -1
  }
  // @ts-ignore
  private print() {
    const textDecoder = new TextDecoder()
    const lines = this.namespaces.slice(2).map((ns, i) => `${textDecoder.decode(this.prefixes[i])} => ${ns.prefix}:${ns.uri}`)
    return `NamespaceMap {\n${lines.join('\n  ')}\n}`
  }
}
