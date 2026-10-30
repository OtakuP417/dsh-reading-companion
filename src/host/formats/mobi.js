/**
 * MOBI / PalmDOC extraction.
 *
 * Ported from foliate-js (`mobi.js`, MIT, © John Factotum): the record layout,
 * PalmDOC LZ77 and HUFF/CDIC dictionary decompression are exactly its
 * algorithms. What is deliberately left out is everything that needs a DOM —
 * this runs in the Host, so a chapter is plain text and images are dropped.
 *
 * KF8 (.azw3) is refused with a precise message: its text is a skeleton plus
 * fragment index that has to be assembled, and handing the model a scrambled
 * concatenation would be worse than saying no.
 */

import { decodeEntities } from './text.js'

const PDB_HEADER = { type: [60, 4, 'string'], creator: [64, 4, 'string'], numRecords: [76, 2, 'uint'] }

const PALMDOC_HEADER = {
  compression: [0, 2, 'uint'],
  numTextRecords: [8, 2, 'uint'],
  encryption: [12, 2, 'uint'],
}

const MOBI_HEADER = {
  magic: [16, 4, 'string'],
  length: [20, 4, 'uint'],
  encoding: [28, 4, 'uint'],
  version: [36, 4, 'uint'],
  titleOffset: [84, 4, 'uint'],
  titleLength: [88, 4, 'uint'],
  huffcdic: [112, 4, 'uint'],
  numHuffcdic: [116, 4, 'uint'],
  exthFlag: [128, 4, 'uint'],
  trailingFlags: [240, 4, 'uint'],
}

const HUFF_HEADER = { magic: [0, 4, 'string'], offset1: [8, 4, 'uint'], offset2: [12, 4, 'uint'] }
const CDIC_HEADER = {
  magic: [0, 4, 'string'],
  length: [4, 4, 'uint'],
  numEntries: [8, 4, 'uint'],
  codeLength: [12, 4, 'uint'],
}
const EXTH_HEADER = { magic: [0, 4, 'string'], length: [4, 4, 'uint'], count: [8, 4, 'uint'] }

const ENCODINGS = { 1252: 'windows-1252', 65001: 'utf-8' }

const getUint = (buffer) => {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  if (buffer.byteLength === 4) return view.getUint32(0)
  if (buffer.byteLength === 2) return view.getUint16(0)
  return view.getUint8(0)
}

const getStruct = (def, buffer) =>
  Object.fromEntries(
    Object.entries(def).map(([key, [start, len, type]]) => {
      const slice = buffer.subarray(start, start + len)
      return [key, type === 'string' ? Buffer.from(slice).toString('latin1') : getUint(slice)]
    }),
  )

const getVarLenFromEnd = (byteArray) => {
  let value = 0
  for (const byte of byteArray.subarray(-4)) {
    if (byte & 0b1000_0000) value = 0
    value = (value << 7) | (byte & 0b111_1111)
  }
  return value
}

const countBitsSet = (x) => {
  let count = 0
  for (; x > 0; x = x >> 1) if ((x & 1) === 1) count++
  return count
}

export function decompressPalmDOC(array) {
  const output = []
  for (let i = 0; i < array.length; i++) {
    const byte = array[i]
    if (byte === 0) output.push(0)
    else if (byte <= 8) {
      for (const x of array.subarray(i + 1, (i += byte) + 1)) output.push(x)
    } else if (byte <= 0b0111_1111) output.push(byte)
    else if (byte <= 0b1011_1111) {
      const bytes = (byte << 8) | array[i++ + 1]
      const distance = (bytes & 0b0011_1111_1111_1111) >>> 3
      const length = (bytes & 0b111) + 3
      for (let j = 0; j < length; j++) output.push(output[output.length - distance])
    } else output.push(32, byte ^ 0b1000_0000)
  }
  return Uint8Array.from(output)
}

const read32Bits = (byteArray, from) => {
  const startByte = from >> 3
  const end = from + 32
  const endByte = end >> 3
  let bits = 0n
  for (let i = startByte; i <= endByte; i++) bits = (bits << 8n) | BigInt(byteArray[i] ?? 0)
  return (bits >> (8n - BigInt(end & 7))) & 0xffffffffn
}

const concat = (a, b) => {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

/** Same table walk as foliate-js's `huffcdic`. */
function makeHuffcdic(loadRecord, mobi) {
  const huffRecord = loadRecord(mobi.huffcdic)
  const { magic, offset1, offset2 } = getStruct(HUFF_HEADER, huffRecord)
  if (magic !== 'HUFF') throw new Error('MOBI 的 HUFF 记录损坏')

  const table1 = Array.from({ length: 256 }, (_, i) => offset1 + i * 4)
    .map((offset) => getUint(huffRecord.subarray(offset, offset + 4)))
    .map((x) => [x & 0b1000_0000, x & 0b1_1111, x >>> 8])

  const table2 = [null].concat(
    Array.from({ length: 32 }, (_, i) => offset2 + i * 8).map((offset) => [
      getUint(huffRecord.subarray(offset, offset + 4)),
      getUint(huffRecord.subarray(offset + 4, offset + 8)),
    ]),
  )

  const dictionary = []
  for (let i = 1; i < mobi.numHuffcdic; i++) {
    const record = loadRecord(mobi.huffcdic + i)
    const cdic = getStruct(CDIC_HEADER, record)
    if (cdic.magic !== 'CDIC') throw new Error('MOBI 的 CDIC 记录损坏')
    const n = Math.min(1 << cdic.codeLength, cdic.numEntries - dictionary.length)
    const buffer = record.subarray(cdic.length)
    for (let i = 0; i < n; i++) {
      const offset = getUint(buffer.subarray(i * 2, i * 2 + 2))
      const x = getUint(buffer.subarray(offset, offset + 2))
      const length = x & 0x7fff
      const decompressed = x & 0x8000
      dictionary.push([new Uint8Array(buffer.subarray(offset + 2, offset + 2 + length)), decompressed])
    }
  }

  const decompress = (byteArray) => {
    let output = new Uint8Array()
    const bitLength = byteArray.byteLength * 8
    for (let i = 0; i < bitLength; ) {
      const bits = Number(read32Bits(byteArray, i))
      let [found, codeLength, value] = table1[bits >>> 24]
      if (!found) {
        while (bits >>> (32 - codeLength) < table2[codeLength][0]) codeLength += 1
        value = table2[codeLength][1]
      }
      if ((i += codeLength) > bitLength) break
      const code = value - (bits >>> (32 - codeLength))
      let [result, done] = dictionary[code]
      if (!done) {
        result = decompress(result)
        dictionary[code] = [result, true]
      }
      output = concat(output, result)
    }
    return output
  }
  return decompress
}

function getExth(buffer, encoding) {
  const header = getStruct(EXTH_HEADER, buffer)
  if (header.magic !== 'EXTH') return null
  const decoder = new TextDecoder(ENCODINGS[encoding] ?? 'utf-8')
  const out = {}
  let offset = 12
  for (let i = 0; i < header.count && offset + 8 <= header.length; i++) {
    const type = getUint(buffer.subarray(offset, offset + 4))
    const length = getUint(buffer.subarray(offset + 4, offset + 8))
    if (length < 8) break
    const value = buffer.subarray(offset + 8, offset + length)
    const key = type === 100 ? 'creator' : type === 503 ? 'title' : type === 524 ? 'language' : null
    if (key) {
      const text = decoder.decode(value).replace(/\0+$/, '')
      if (key === 'creator') out.creator = out.creator ? `${out.creator} ${text}` : text
      else out[key] = text
    }
    if (type === 121) out.boundary = getUint(value.subarray(0, 4))
    offset += length
  }
  return out
}

/** Strip MOBI/HTML markup down to reading text. */
function htmlToText(html) {
  return decodeEntities(
    String(html ?? '')
      .replace(/<\?xml[\s\S]*?\?>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
      .replace(/<mbp:[^>]*>/gi, '')
      .replace(/<\/?(?:html|body|div|p|h[1-6]|li|tr|blockquote|section)\b[^>]*>/gi, '\n\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const PAGEBREAK = /<\s*(?:mbp:)?pagebreak[^>]*>/gi

/**
 * @param {Buffer} bytes
 * @returns {{ title: string, author: string, language: string, sections: { title: string, text: string }[] }}
 */
export function parseMobi(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (buf.length < 100) throw new Error('不是有效的 MOBI：文件太小')
  const pdb = getStruct(PDB_HEADER, buf.subarray(0, 78))
  // 'BOOKMOBI' is two 4-byte fields: type 'BOOK' + creator 'MOBI'. Plain PalmDOC
  // text files carry 'TEXtREAd' instead and are readable the same way.
  if (pdb.type !== 'BOOK') throw new Error('不是有效的 MOBI：缺少 BOOKMOBI 标记')
  if (pdb.creator !== 'MOBI' && pdb.creator !== 'TEXt') {
    throw new Error(`不是有效的 MOBI：未识别的 PDB 类型 ${pdb.type}${pdb.creator}`)
  }

  const offsets = []
  for (let i = 0; i < pdb.numRecords; i++) {
    offsets.push(buf.readUInt32BE(78 + i * 8))
  }
  const loadRecord = (index) => {
    const start = offsets[index]
    if (start === undefined) throw new RangeError(`MOBI 记录越界：${index}`)
    const end = offsets[index + 1] ?? buf.length
    return buf.subarray(start, end)
  }

  const record0 = loadRecord(0)
  const palmdoc = getStruct(PALMDOC_HEADER, record0)
  const mobi = getStruct(MOBI_HEADER, record0)
  if (mobi.magic !== 'MOBI') throw new Error('不是有效的 MOBI：缺少 MOBI 头')
  const exth = mobi.exthFlag & 0b100_0000 ? getExth(record0.subarray(mobi.length + 16), mobi.encoding) : null

  const isCombo = exth?.boundary !== undefined && exth.boundary < 0xffffffff
  if (mobi.version >= 8 && !isCombo) {
    throw new Error('这是 KF8/AZW3 格式，暂不支持解析。请用 Calibre 转成 EPUB（或旧版 MOBI）后再导入。')
  }
  if (palmdoc.encryption) throw new Error('这本 MOBI 有 DRM 加密，无法解析。')

  const decoder = new TextDecoder(ENCODINGS[mobi.encoding] ?? 'utf-8')
  const decompress =
    palmdoc.compression === 1
      ? (f) => f
      : palmdoc.compression === 2
        ? decompressPalmDOC
        : palmdoc.compression === 17480
          ? makeHuffcdic(loadRecord, mobi)
          : null
  if (!decompress) throw new Error(`不支持的 MOBI 压缩方式：${palmdoc.compression}`)

  const multibyte = mobi.trailingFlags & 1
  const numTrailing = countBitsSet(mobi.trailingFlags >>> 1)
  const stripTrailing = (array) => {
    let out = array
    for (let i = 0; i < numTrailing; i++) out = out.subarray(0, out.length - getVarLenFromEnd(out))
    if (multibyte) out = out.subarray(0, out.length - ((out[out.length - 1] & 0b11) + 1))
    return out
  }

  const chunks = []
  for (let i = 0; i < palmdoc.numTextRecords; i++) {
    chunks.push(decompress(stripTrailing(new Uint8Array(loadRecord(i + 1)))))
  }
  let total = 0
  for (const chunk of chunks) total += chunk.length
  const all = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    all.set(chunk, at)
    at += chunk.length
  }
  // `filepos` are byte offsets, so decode the whole stream at once
  const html = decoder.decode(all)

  const pieces = html.split(PAGEBREAK)
  const sections = []
  for (const piece of pieces) {
    const title =
      (/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(piece)?.[1] ?? '')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60) || ''
    const text = htmlToText(piece)
    if (text.length < 2) continue
    sections.push({ title, text })
  }

  if (sections.length === 0) throw new Error('这本 MOBI 没有解析出正文')
  const title = (exth?.title ?? '').trim() || decoder.decode(record0.subarray(mobi.titleOffset, mobi.titleOffset + mobi.titleLength)).replace(/\0+$/, '').trim()
  return {
    title: title || '未命名',
    author: (exth?.creator ?? '').trim(),
    language: exth?.language ?? 'zh',
    sections,
  }
}
