/**
 * Minimal ZIP reader — just enough for EPUB containers.
 *
 * An EPUB is a ZIP; the Host needs the raw XHTML of every spine item, so the
 * only dependency-free way to get it is to read the archive ourselves. Only
 * stored (method 0) and deflated (method 8) entries are common in EPUBs, and
 * both are handled by node:zlib. ZIP64 end records are parsed when present
 * because any book with embedded fonts can cross the 4 GiB field limits.
 */

import zlib from 'node:zlib'

const EOCD_SIG = 0x06054b50
const ZIP64_LOCATOR_SIG = 0x07064b50
const ZIP64_EOCD_SIG = 0x06064b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

/**
 * @param {Buffer} buf
 * @returns {{ entries: Map<string, { method: number, compressedSize: number, size: number, localOffset: number }>, comment: string }}
 */
export function readCentralDirectory(buf) {
  // The end-of-central-directory record sits at the tail, after an optional
  // comment of up to 64 KiB.
  let eocd = -1
  const minStart = Math.max(0, buf.length - 66000)
  for (let i = buf.length - 22; i >= minStart; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的 EPUB/ZIP：找不到中央目录')

  let count = buf.readUInt16LE(eocd + 10)
  let cdOffset = buf.readUInt32LE(eocd + 16)
  const commentLen = buf.readUInt16LE(eocd + 20)
  const comment = commentLen ? buf.toString('utf8', eocd + 22, eocd + 22 + commentLen) : ''

  if (count === 0xffff || cdOffset === 0xffffffff) {
    const locator = eocd - 20
    if (locator >= 0 && buf.readUInt32LE(locator) === ZIP64_LOCATOR_SIG) {
      const z64 = Number(buf.readBigUInt64LE(locator + 8))
      if (z64 >= 0 && z64 + 56 <= buf.length && buf.readUInt32LE(z64) === ZIP64_EOCD_SIG) {
        count = Number(buf.readBigUInt64LE(z64 + 32))
        cdOffset = Number(buf.readBigUInt64LE(z64 + 48))
      }
    }
  }

  /** @type {Map<string, { method: number, compressedSize: number, size: number, localOffset: number }>} */
  const entries = new Map()
  let offset = cdOffset
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CENTRAL_SIG) break
    const method = buf.readUInt16LE(offset + 10)
    const compressedSize = buf.readUInt32LE(offset + 20)
    const size = buf.readUInt32LE(offset + 24)
    const nameLen = buf.readUInt16LE(offset + 28)
    const extraLen = buf.readUInt16LE(offset + 30)
    const entryCommentLen = buf.readUInt16LE(offset + 32)
    const localOffset = buf.readUInt32LE(offset + 42)
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen)
    entries.set(name, { method, compressedSize, size, localOffset })
    offset += 46 + nameLen + extraLen + entryCommentLen
  }
  return { entries, comment }
}

/**
 * Expand one entry to its bytes.
 * @param {Buffer} buf
 * @param {{ method: number, compressedSize: number, size: number, localOffset: number }} entry
 * @returns {Buffer}
 */
export function readEntry(buf, entry) {
  const local = entry.localOffset
  if (local + 30 > buf.length || buf.readUInt32LE(local) !== LOCAL_SIG) {
    throw new Error('ZIP 条目损坏：本地头签名不符')
  }
  const nameLen = buf.readUInt16LE(local + 26)
  const extraLen = buf.readUInt16LE(local + 28)
  const start = local + 30 + nameLen + extraLen
  const raw = buf.subarray(start, start + entry.compressedSize)
  if (entry.method === 0) return Buffer.from(raw)
  if (entry.method === 8) return zlib.inflateRawSync(raw)
  throw new Error(`不支持的 ZIP 压缩方式：${entry.method}`)
}

/**
 * Read every entry into a name→Buffer map (EPUBs are small enough).
 * @param {Buffer} buf
 * @returns {Map<string, Buffer>}
 */
export function readZip(buf) {
  const { entries } = readCentralDirectory(buf)
  /** @type {Map<string, Buffer>} */
  const files = new Map()
  for (const [name, entry] of entries) {
    if (name.endsWith('/')) continue
    files.set(name, readEntry(buf, entry))
  }
  return files
}

/**
 * Read one entry by name without expanding the rest.
 * @param {Buffer} buf
 * @param {string} name
 * @returns {Buffer | null}
 */
export function readZipFile(buf, name) {
  const { entries } = readCentralDirectory(buf)
  const entry = entries.get(name)
  if (!entry) return null
  return readEntry(buf, entry)
}
