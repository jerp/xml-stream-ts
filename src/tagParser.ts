import { TagNameMatcher, AttributeNameMatcher, NamespaceMap } from "./names.ts"
import type { FQName, Namespace } from "./names.ts"

type AttributePropertyName<Name extends string> = Name extends `${string}:${infer LocalName}` ? LocalName : Name

type OnStartHandler<T = any, AK extends string = any> = (
  this: T,
  attributes: TagAttributes<AK>,
  tagName: FQName,
  hasContent?: boolean
) => boolean | void

export type TagAttributes<AK extends string = string> = {
  [P in AttributePropertyName<AK>]?: Uint8Array<ArrayBuffer>;
}

export interface TagAttribute<AK extends string = string> {
  name: AK
  value: Uint8Array<ArrayBuffer>
  namespace: Namespace
}

export interface LeafTagParser<T = any, AK extends string = string> {
  onStart?: OnStartHandler<T, AK>
  onTextContent?: (this: T, textContent: Uint8Array<ArrayBuffer>) => void
  onEnd?: (this: T) => void
  attributes?: readonly AK[]
}

export interface TagParser<T = any, AK extends string = string> {
  onStart?: OnStartHandler<T, AK>
  onEnd?: (this: T) => T | void
  onComment?: (this: T, textContent: any) => void
  onLeaf?: { [K in string]?: LeafTagParser<T> }
  onChild?: { [K in string]?: TagParser<T> }
  attributes?: readonly AK[]
  onTextContent?: (this: T, textContent: Uint8Array<ArrayBuffer>) => void
}

export type TagParserConfig<T, Attrs extends readonly string[] = readonly string[]> =
  Omit<TagParser<T, Attrs[number]>, 'attributes'> & {
    attributes?: Attrs
  }

export type LeafTagParserConfig<T, Attrs extends readonly string[] = readonly string[]> =
  Omit<LeafTagParser<T, Attrs[number]>, 'attributes'> & {
    attributes?: Attrs
  }

export function tagParser<T>(): <const Attrs extends readonly string[] = readonly []>(
  parser: TagParserConfig<T, Attrs>,
) => TagParser<T, Attrs[number]>
export function tagParser<T, const Attrs extends readonly string[] = readonly []>(
  parser: TagParserConfig<T, Attrs>,
): TagParser<T, Attrs[number]>
export function tagParser<T, const Attrs extends readonly string[] = readonly []>(
  parser?: TagParserConfig<T, Attrs>,
): TagParser<T, Attrs[number]> | (<const InnerAttrs extends readonly string[] = readonly []>(
  parser: TagParserConfig<T, InnerAttrs>,
) => TagParser<T, InnerAttrs[number]>) {
  if (parser) return parser
  return (innerParser) => innerParser
}

export function leafParser<T>(): <const Attrs extends readonly string[] = readonly []>(
  parser: LeafTagParserConfig<T, Attrs>,
) => LeafTagParser<T, Attrs[number]>
export function leafParser<T, const Attrs extends readonly string[] = readonly []>(
  parser: LeafTagParserConfig<T, Attrs>,
): LeafTagParser<T, Attrs[number]>
export function leafParser<T, const Attrs extends readonly string[] = readonly []>(
  parser?: LeafTagParserConfig<T, Attrs>,
): LeafTagParser<T, Attrs[number]> | (<const InnerAttrs extends readonly string[] = readonly []>(
  parser: LeafTagParserConfig<T, InnerAttrs>,
) => LeafTagParser<T, InnerAttrs[number]>) {
  if (parser) return parser
  return (innerParser) => innerParser
}

export function rootResolver<T>(): <const Attrs extends readonly string[] = readonly []>(
  tagName: string,
  nsMap: NamespaceMap,
  parser: TagParserConfig<T, Attrs>,
) => TagResolver<T, Attrs[number]>
export function rootResolver<T, const Attrs extends readonly string[] = readonly []>(
  tagName: string,
  nsMap: NamespaceMap,
  parser: TagParserConfig<T, Attrs>,
): TagResolver<T, Attrs[number]>
export function rootResolver<T, const Attrs extends readonly string[] = readonly []>(
  tagName?: string,
  nsMap?: NamespaceMap,
  parser?: TagParserConfig<T, Attrs>,
): TagResolver<T, Attrs[number]> | (<const InnerAttrs extends readonly string[] = readonly []>(
  tagName: string,
  nsMap: NamespaceMap,
  parser: TagParserConfig<T, InnerAttrs>,
) => TagResolver<T, InnerAttrs[number]>) {
  if (tagName === undefined || nsMap === undefined || parser === undefined) {
    return (innerTagName, innerNsMap, innerParser) => new TagResolver(innerParser, innerNsMap, innerTagName)
  }
  return new TagResolver<T, Attrs[number]>(parser, nsMap, tagName)
}

export class TagResolver<T = any, AK extends string = string> {
  onStart?: OnStartHandler<T, AK>
  onEnd?: (this: T) => T | void
  onComment?: (this: T, textContent: any) => void
  onTextContent?: (this: T, textContent: any) => void
  childResolver?: TagNameMatcher<T>
  attributeResolvers?: AttributeNameMatcher
  nsMap: NamespaceMap
  tagName: string

  constructor(parser: TagParser<T, AK>, nsMap: NamespaceMap, tagName = "/") {
    this.onStart = parser.onStart
    this.onEnd = parser.onEnd
    this.onComment = parser.onComment
    this.nsMap = nsMap
    this.tagName = tagName
    this.onTextContent = parser.onTextContent
    if (parser.onChild) {
      for (const childPattern in parser.onChild) {
        const childParser = parser.onChild[childPattern]
        if (childParser) {
          this.onChild(childPattern, childParser)
        }
      }
    }
    if (parser.onLeaf) {
      for (const childPattern in parser.onLeaf) {
        const childParser = parser.onLeaf[childPattern]
        if (childParser) {
          this.onLeaf(childPattern, childParser)
        }
      }
    }

    if (parser.attributes) {
      for (const attributePattern of parser.attributes) {
          this.addAttributeResolver(attributePattern)
      }
    }
  }

  onChild<CAK extends string = string>(tagName: string, childParser: TagParser<T, CAK>) {
    const childResolver = this.createChildResolver(tagName, childParser)
    this.addChildResolver(childResolver)
    return childResolver
  }

  onLeaf<CAK extends string = string>(tagName: string, leafParser: LeafTagParser<T, CAK>) {
    return this.onChild<CAK>(tagName, leafParser)
  }

  createChildResolver<CT = any, CAK extends string = string>(tagName: string, childParser: TagParser<CT, CAK>) {
    return new TagResolver(childParser, this.nsMap, tagName as string)
  }

  addChildResolver<CAK extends string = string>(childResolver: TagResolver<T, CAK>): this {
    if (!this.childResolver) this.childResolver = new TagNameMatcher()
    const { prefix, localName } = this.parseNamePattern(childResolver.tagName)
    const namespace = this.nsMap.get(prefix ?? "")
    this.childResolver.setName(childResolver as any, localName, namespace)
    return this
  }

  private addAttributeResolver(tagName: string) {
    if (!this.attributeResolvers) this.attributeResolvers = new AttributeNameMatcher()
    const { prefix, localName } = this.parseNamePattern(tagName)
    const namespace = prefix ? this.nsMap.get(prefix) : undefined
    this.attributeResolvers.setName(localName, namespace)
  }

  private parseNamePattern(tagName: string): { prefix: string | undefined, localName: string } {
    const parts = tagName.split(":")
    const prefix = parts.length === 2 ? parts[0] || "*" : tagName === "*" ? "*" : undefined
    const localName = parts.length === 2 ? parts[1] || "*" : tagName === "*" ? "*" : tagName
    return { prefix, localName }
  }
}
