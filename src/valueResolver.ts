
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export interface ValueResolver<T> {
  (bs: Uint8Array<ArrayBuffer> | undefined): T
}

export interface ValueResolverInterface<T> {
  resolve(bs: Uint8Array<ArrayBuffer> | undefined): T
}

import { createTextDecoder } from "./textDecoder.ts"

export const wrapResolver = <T>(resolverInstance: ValueResolverInterface<T>): ValueResolver<T> => {
  return resolverInstance.resolve.bind(resolverInstance)
}

export class ValueDictionary<T, F extends T | undefined = T> implements ValueResolverInterface<T | F> {
  protected textContent: Array<Uint8Array<ArrayBuffer>>
  protected values: Array<T>
  protected options: {
    fallBack?: F,
    noTrim?: boolean,
  }
  constructor(valuePairs: Array<[Uint8Array<ArrayBuffer>, T]>, options?: {
    fallBack?: F,
    noTrim?: boolean,
  }) {
    this.options = options ?? {}
    this.textContent = []
    this.values = []
    //this.encode = options?.encode ?? textEncoder.encode.bind(textEncoder)
    for (let i = 0; i < valuePairs.length; i++) {
      const [text, value] = valuePairs[i]
      this.addValue(text, value)
    }
    this.options.fallBack = options?.fallBack as F
  }
  resolve(bs: Uint8Array<ArrayBuffer> | undefined): T | F {
    if (!bs) return this.options.fallBack as F
    if (!this.options.noTrim) bs = this.trim(bs)
    const index = this.indexOf(bs)
    if (index >= 0) {
      return this.values[index]
    }
    return this.fallBackFn(bs)
  }
  protected fallBackFn(_bytes: Uint8Array<ArrayBuffer>): T | F {
    return this.options.fallBack as F
  }
  protected indexOf(bs: Uint8Array<ArrayBuffer>): number {
    for (let i = 0; i < this.textContent.length; i++) {
      const tc = this.textContent[i]
      if (tc.length === bs.length && tc.every((value, index) => value === bs[index])) {
        return i
      }
    }
    return -1
  }
  protected addValue(text: Uint8Array<ArrayBuffer>, value?: T): void {
    if (!this.options.noTrim) text = this.trim(text)
    const bs = text
    this.values.push(value ?? text as T)
    this.textContent.push(bs)
  }
  trim(bs: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
    let begin = 0
    let end = bs.length
    while (begin < end && bs[begin] <= 0x20 /* space */) begin++
    while (end > begin && bs[end - 1] <= 0x20 /* space */) end--
    return bs.subarray(begin, end)
  }
}

export abstract class TextDictionary<T extends Uint8Array<ArrayBuffer> | string = Uint8Array<ArrayBuffer>> extends ValueDictionary<T, T> {
  declare protected options: {
    noTrim?: boolean,
    encode: TextEncoder['encode']
  }
  constructor(options?: TextDictionary['options']) {
    super([], options)
    if (!this.options.encode) this.options.encode = textEncoder.encode.bind(textEncoder)

  }
  override fallBackFn(bs: Uint8Array<ArrayBuffer>): T {
    const utf8 = utf8Resolver(bs)
    const value = this.valueFromUtf8(utf8)
    this.addValue(utf8, value)
    return value
  }
  protected addString(str: string): void {
    const escaped = str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    const encoded = this.options.encode(escaped)
    this.addValue(encoded, this.valueFromString(str))
    // matching both escaped and unescaped for allowed unescaped chars: > or " or ' (in attribute value)
    if (str.includes('>') || str.includes('"') || str.includes("'")) {
      const relaxedText = str.replace(/&/g, '&amp;').replace(/</g, '&lt;')
      const relaxedBytes = this.options.encode(relaxedText)
      this.addValue(relaxedBytes, this.valueFromString(str))
    }
  }
  protected addUtf8(bs: Uint8Array<ArrayBuffer>): void {
    let needEscaping = false
    for (const b of bs) {
      if (b === 0x26 /*&*/ || b === 0x3c /*<*/ || b === 0x3e /*>*/ || b === 0x22 /*"*/ || b === 0x27 /*'*/) {
        needEscaping = true
        break
      }
    }
    if (needEscaping) {
      const text = textDecoder.decode(bs)
      this.addString(text)
    } else {
      this.addValue(bs, this.valueFromUtf8(bs))
    }
  }
  protected abstract valueFromString(text: string): T;
  protected abstract valueFromUtf8(value: Uint8Array<ArrayBuffer>): T;
}

export class Utf8Dictionary extends TextDictionary<Uint8Array<ArrayBuffer>> {
  constructor(options?: Utf8Dictionary['options']) {
    super(options)
  }
  static create(values: Array<string>): Utf8Dictionary {
    const resolver = new Utf8Dictionary()
    for (const value of values) {
      resolver.addString(value)
    }
    return resolver
  }
  override valueFromString(text: string) {
    return this.options.encode(text)
  }
  override valueFromUtf8(value: Uint8Array<ArrayBuffer>) {
    return value
  }
}

export class StringDictionary extends TextDictionary<string> {
  declare protected options: {
    noTrim?: boolean,
    encode: TextEncoder['encode'],
    decode: TextDecoder['decode']
  }
  constructor(options?: StringDictionary['options']) {
    super(options)
    if (!this.options.decode) this.options.decode = textDecoder.decode.bind(textDecoder)
  }
  static create(values: Array<string>) {
    const dict = new StringDictionary()
    for (const value of values) {
      dict.addString(value)
    }
    return dict
  }
  override valueFromString(text: string): string {
    return text
  }
  override valueFromUtf8(value: Uint8Array<ArrayBuffer>): string {
    return this.options.decode(value)
  }
}

export const int: ValueResolver<number | null> = (bs) => {
  if (!bs?.length) return null
    let o = 0
    let b = bs[o]
    while (b && b <= 0x20 /* space */) b = bs[++o]
    if (o === bs.length) return b !== 0x30 ? null : 0
    let result = 0
    let sign = 1
    if (b === 0x2d /*-*/) {
      sign = -1
      b = bs[++o]
    } else if (b === 0x2b /*+*/) {
      b = bs[++o]
    }
    while (b && b >= 0x30 /*0*/ && b <= 0x39 /*9*/) {
      result = result * 10 + (b - 0x30)
      b = bs[++o]
    }
    return sign * result
  }

export const bigInt: ValueResolver<bigint | null> = (bs) => {
  if (!bs?.length) return null
    let o = 0
    let b = bs[o]
    while (b && b <= 0x20 /* space */) b = bs[++o]
    if (o === bs.length) return b !== 0x30 ? null : BigInt(0)
    let result = ''
    if (b === 0x2d /*-*/) {
      result += '-'
      b = bs[++o]
    } else if (b === 0x2b /*+*/) {
      b = bs[++o]
    }
    while (b && b >= 0x30 /*0*/ && b <= 0x39 /*9*/) {
      result += String.fromCharCode(b)
      b = bs[++o]
    }
    return BigInt(result)
  }

export const decimal: ValueResolver<number | null> = (bs) => {
  if (!bs?.length) return null
    // int part
    let o = 0
    let b = bs[o]
    const bytesLength = bs.length
    while (b && b <= 0x20 /* space */) b = bs[++o]
    let multiplier = 1
    if (b === 0x2d /*-*/ || b === 0x2b /*+*/) {
      multiplier = b === 0x2d /*-*/ ? -1 : 1
      b = bs[++o]
    }
    if (o === bytesLength) return b === 0x30 ? 0 : null
    let mant = 0
    while (b && b >= 0x30 /*0*/ && b <= 0x39 /*9*/) {
      mant = mant * 10 + (b - 0x30)
      b = bs[++o]
    }
    // decimal part
    if (o === bytesLength) return multiplier * mant
    if (b === 0x2e /*.*/) {
      let decimalPart = 0
      let divisor = 1
      b = bs[++o]
      while (b && b >= 0x30 /*0*/ && b <= 0x39 /*9*/) {
        decimalPart = decimalPart * 10 + (b - 0x30)
        divisor *= 10
        b = bs[++o]
      }
      mant += decimalPart / divisor
    }
    if (o === bytesLength) return multiplier * mant
    // exponent part
    if ((b & 0x5f) !== 0x45 /*E*/) return multiplier * mant
    b = bs[++o]
    let exponentSign = 1
    if (b === 0x2d /*-*/ || b === 0x2b /*+*/) {
      exponentSign = b === 0x2d /*-*/ ? -1 : 1
      b = bs[++o]
    }
    let exponentPart = 0
    while (b && b >= 0x30 /*0*/ && b <= 0x39 /*9*/) {
      exponentPart = exponentPart * 10 + (b - 0x30)
      b = bs[++o]
    }
    multiplier *= Math.pow(10, exponentSign * exponentPart)
    return multiplier * mant
  }


export const isoDate: ValueResolver<number | null> = (bs) => {
  if (!bs?.length) return null
  let o = 0
  let b = bs[o]
  while (b <= 0x20 /* space */) b = bs[++o]
  if (bs.length - o < 10) return null
  const [b0, b1, b2, b3, b4, b5, b6, b7, b8, b9] = [bs[o++], bs[o++], bs[o++], bs[o++], bs[o++], bs[o++], bs[o++], bs[o++], bs[o++], bs[o++]]
  if (b4 !== 0x2d /*-*/ || b7 !== 0x2d /*-*/) return null
  const year = (b0 - 0x30) * 1000 + (b1 - 0x30) * 100 + (b2 - 0x30) * 10 + (b3 - 0x30)
  const month = (b5 - 0x30) * 10 + (b6 - 0x30) - 1
  const day = (b8 - 0x30) * 10 + (b9 - 0x30)
  b = bs[o + 10]
  return Date.UTC(year, month, day)
}

export const isoDateTime: ValueResolver<number | null> = (bs) => {
  if (!bs?.length) return null
  let o = 0
  let b = bs[o]
  while (b <= 0x20 /* space */) b = bs[++o]
  if (bs.length - o < 10) return null
  const [b0, b1, b2, b3, b4, b5, b6, b7, b8, b9] = [bs[o++], bs[o++], bs[o++], bs[o++], bs[o++], bs[o++], bs[o++], bs[o++], bs[o++], bs[o++]]
  if (b4 !== 0x2d /*-*/ || b7 !== 0x2d /*-*/) return null
  const year = (b0 - 0x30) * 1000 + (b1 - 0x30) * 100 + (b2 - 0x30) * 10 + (b3 - 0x30)
  const month = (b5 - 0x30) * 10 + (b6 - 0x30) - 1
  const day = (b8 - 0x30) * 10 + (b9 - 0x30)
  b = bs[o + 10]
  if ((b0 & 0x5f) === 0x54 /* T */) return Date.UTC(year, month, day)
  const [t0, t1, t2, t3, t4, t5, t6, t7] = [bs[o++], bs[o++], bs[o++], bs[o++], bs[o++], bs[o++], bs[o++], bs[o++]]
  if (t2 !== 0x3a /*:*/ || t5 !== 0x3a /*:*/) return null
  const hour = (t0 - 0x30) * 10 + (t1 - 0x30)
  const minute = (t3 - 0x30) * 10 + (t4 - 0x30)
  const second = (t6 - 0x30) * 10 + (t7 - 0x30)
  if (bs[o++] !== 0x2e /*.*/) return Date.UTC(year, month, day, hour, minute, second)
  let millisecond = 0
  b = bs[++o]
  if (b >= 0x30 /*0*/ && b <= 0x39 /*9*/) {
    millisecond = (b - 0x30) * 100
    b = bs[++o]
  }
  if (b >= 0x30 /*0*/ && b <= 0x39 /*9*/) {
    millisecond += (b - 0x30) * 10
    b = bs[++o]
  }
  if (b >= 0x30 /*0*/ && b <= 0x39 /*9*/) {
    millisecond += (b - 0x30)
  }
  if (!b || (b & 0x5f) === 0x5a /* Z */) {
    return Date.UTC(year, month, day, hour, minute, second, millisecond)
  }
  let offsetSign = 1
  if (b !== 0x2b /*+*/ && b !== 0x2d /*-*/) {
    return Date.UTC(year, month, day, hour, minute, second, millisecond)
  } else {
    offsetSign = b === 0x2b /*+*/ ? 1 : -1
    o++
  }
  const [o0, o1, o2, o3] = [bs[o++], bs[o++], bs[o++], bs[o++]]
  const oh = (o0 - 0x30) * 10 + (o1 - 0x30)
  const om = (o2 - 0x30) * 10 + (o3 - 0x30)
  const oms = offsetSign * (oh * 60 + om) * 60000
  return Date.UTC(year, month, day, hour, minute, second, millisecond) - oms

}

export const boolean: ValueResolver<boolean | null> = (bs) => {
  if (!bs?.length) return null
  let o = 0
  let b = bs[o]
  let end = bs.length
  while (b <= 0x20 /* space */) b = bs[++o]
  while (end > o && bs[end - 1] <= 0x20 /* space */) end--
  if (end - o === 4) {
    const [b0, b1, b2, b3] = [bs[o++], bs[o++], bs[o++], bs[o++]]
    const isTrue = (b0 & 0x5f) === 0x54 /* T */ && (b1 & 0x5f) === 0x52 /* R */ && (b2 & 0x5f) === 0x55 /* U */ && (b3 & 0x5f) === 0x45 /* E */
    return isTrue ? true : null
  } else if (end - o === 5) {
    const [b0, b1, b2, b3, b4] = [bs[o++], bs[o++], bs[o++], bs[o++], bs[o++]]
    const isFalse = (b0 & 0x5f) === 0x46 /* F */ && (b1 & 0x5f) === 0x41 /* A */ && (b2 & 0x5f) === 0x4c /* L */ && (b3 & 0x5f) === 0x53 /* S */ && (b4 & 0x5f) === 0x45 /* E */
    return isFalse ? false : null
  } else {
    return null
  }
}
export const isTrue: ValueResolver<boolean> = (bs) => {
  if (!bs?.length) return false
  let o = 0
  let b = bs[o]
  let end = bs.length
  while (b <= 0x20 /* space */) b = bs[++o]
  while (end > o && bs[end - 1] <= 0x20 /* space */) end--
  if (end - o === 4) {
    const [b0, b1, b2, b3] = [bs[o++], bs[o++], bs[o++], bs[o++]]
    return (b0 & 0x5f) === 0x54 /* T */ && (b1 & 0x5f) === 0x52 /* R */ && (b2 & 0x5f) === 0x55 /* U */ && (b3 & 0x5f) === 0x45 /* E */
  } else {
    return false
  }
}
export const equals = (value: Uint8Array<ArrayBuffer> | string, trim = true): ValueResolver<boolean> => {
  if (typeof value === 'string') {
    value = textEncoder.encode(value)
  }
  return (bs) => {
    if (!bs?.length) return false
    let o = 0
    let b = bs[o]
    let end = bs.length
    if (trim) {
      while (b <= 0x20 /* space */) b = bs[++o]
      while (end > o && bs[end - 1] <= 0x20 /* space */) end--
    }
    if (end - o !== value.length) return false
    for (let i = 0; i < value.length; i++) {
      if (bs[o + i] !== value[i]) return false
    }
    return true
  }
}

const DEFAULT_BUFFER_CAPACITY = 256
let UTF8_BUFFER = new Uint8Array(DEFAULT_BUFFER_CAPACITY)
function growUtf8Buffer(bs: Uint8Array<ArrayBuffer>, newCapacity: number) {
  const next = new Uint8Array(newCapacity)
  next.set(bs)
  UTF8_BUFFER = next
}

export const passThrough: ValueResolver<Uint8Array<ArrayBuffer> | null> = (bs) => bs ?? null

const utf8Resolver = (bs: Uint8Array<ArrayBuffer> | undefined, preserveNl?: boolean) => {
  if (!bs?.length) return new Uint8Array(0)
  const decoder = createTextDecoder(bs, preserveNl)
  const out = UTF8_BUFFER
  let o = 0
  for (const b of decoder) {
    out[o++] = b
    if (o === out.length) {
      growUtf8Buffer(out, out.length * 2)
    }
  }
  return out.slice(0, o)
}

export const utf8Value = utf8Resolver as ValueResolver<Uint8Array<ArrayBuffer>>
export const utf8TextContent: ValueResolver<Uint8Array<ArrayBuffer>> = (bs) => utf8Resolver(bs, true)

const stringResolver = (bs: Uint8Array<ArrayBuffer> | undefined, preserveNl?: boolean) => {
  if (!bs?.length) return null
  const decoder = createTextDecoder(bs, preserveNl)
  const out = UTF8_BUFFER
  let o = 0
  for (const b of decoder) {
    out[o++] = b
    if (o === out.length) {
      growUtf8Buffer(out, out.length * 2)
    }
  }
  return textDecoder.decode(out.subarray(0, o))
}

export const stringValue = stringResolver as ValueResolver<string>
export const stringTextContent: ValueResolver<string | null> = (bs) => stringResolver(bs, true)

