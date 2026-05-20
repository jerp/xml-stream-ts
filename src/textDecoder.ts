

export type DecoderIterator = Generator<number, number, unknown>
export function* createTextDecoder(bs: Uint8Array<ArrayBuffer>, preserveNl?: boolean): DecoderIterator {
  let o = 0
  while (o < bs.length) {
    const b = bs[o]
    if (b === 0x0a /*\n*/) {
      yield preserveNl ? 0x0a : 0x20
      o++
      continue
    }

    if (b !== 0x26 /*&*/) {
      yield b
      o++
      continue
    }

    const b1 = bs[o + 1]
    const b2 = bs[o + 2]
    const b3 = bs[o + 3]
    const b4 = bs[o + 4]
    const b5 = bs[o + 5]

    if (b3 === 0x3b /*;*/ && b1 === 0x6c /*l*/ && b2 === 0x74 /*t*/) {
      yield 0x3c /*<*/
      o += 4
      continue
    }
    if (b3 === 0x3b /*;*/ && b1 === 0x67 /*g*/ && b2 === 0x74 /*t*/) {
      yield 0x3e /*>*/
      o += 4
      continue
    }
    if (b4 === 0x3b /*;*/ && b1 === 0x61 /*a*/ && b2 === 0x6d /*m*/ && b3 === 0x70 /*p*/) {
      yield 0x26 /*&*/
      o += 5
      continue
    }
    if (b5 === 0x3b /*;*/ && b1 === 0x71 /*q*/ && b2 === 0x75 /*u*/ && b3 === 0x6f /*o*/ && b4 === 0x74 /*t*/) {
      yield 0x22 /*"*/
      o += 6
      continue
    }
    if (b5 === 0x3b /*;*/ && b1 === 0x61 /*a*/ && b2 === 0x70 /*p*/ && b3 === 0x6f /*o*/ && b4 === 0x73 /*s*/) {
      yield 0x27 /*'*/
      o += 6
      continue
    }

    if (b1 === 0x23 /*#*/) {
      const isHex = b2 === 0x78 /*x*/ || b2 === 0x58 /*X*/
      let cp = 0
      let i = o + (isHex ? 3 : 2)
      let valid = true
      let digitCount = 0

      while (i < bs.length && bs[i] !== 0x3b /*;*/) {
        const c = bs[i]
        const isDigit = c >= 0x30 && c <= 0x39
        const isHexDigit = (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46)
        if (!isDigit && !(isHex && isHexDigit)) {
          valid = false
          break
        }
        cp = cp * (isHex ? 16 : 10) + (isDigit ? c - 0x30 : (c | 0x20) - 87)
        digitCount++
        i++
      }

      if (i < bs.length && bs[i] === 0x3b /*;*/ && valid && digitCount > 0 && cp > 0) {
        if (cp <= 0x7f) {
          yield cp
        } else if (cp <= 0x7ff) {
          yield cp >> 6 | 0xc0
          yield (cp & 0x3f) | 0x80
        } else if (cp <= 0xffff) {
          yield cp >> 12 | 0xe0
          yield (cp >> 6 & 0x3f) | 0x80
          yield (cp & 0x3f) | 0x80
        } else {
          yield cp >> 18 | 0xf0
          yield (cp >> 12 & 0x3f) | 0x80
          yield (cp >> 6 & 0x3f) | 0x80
          yield (cp & 0x3f) | 0x80
        }
        o = i + 1
        continue
      }

      yield 0xff
      yield 0xfd
      o = i < bs.length ? i + 1 : i
      continue
    }

    let i = o + 1
    while (i < bs.length && bs[i] !== 0x3b /*;*/) i++
    if (i >= bs.length) {
      yield 0x26 /*&*/
      o++
      continue
    }
    yield 0xff
    yield 0xfd
    o = i + 1
  }
  return o
}

