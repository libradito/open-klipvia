/**
 * A zip writer with no dependency and no compression.
 *
 * Everything we bundle is already compressed — video, audio, PNG — so STORE is
 * the right method, and it lets the file bytes stream straight from disk into
 * the archive without ever holding a whole media file in memory. Sizes are
 * known up front, so no data descriptors; no ZIP64, so the archive is capped
 * at 4 GB and refused beyond.
 */

import { stat } from 'node:fs/promises'

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

async function crc32OfFile(path: string): Promise<number> {
  let crc = 0xffffffff
  for await (const chunk of Bun.file(path).stream()) {
    for (let i = 0; i < chunk.length; i++) crc = CRC_TABLE[(crc ^ chunk[i]!) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** MS-DOS time and date words, the only timestamp format a zip must carry. */
function dosStamp(d: Date): { time: number; date: number } {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return { time, date }
}

export interface ZipEntry {
  /** Absolute path on disk. */
  path: string
  /** Name inside the archive. */
  name: string
}

export const ZIP_MAX_BYTES = 4 * 1024 * 1024 * 1024 - 1024 * 1024

export async function writeStoreZip(entries: ZipEntry[], outPath: string): Promise<{ size: number; count: number }> {
  const items: Array<ZipEntry & { size: number; mtime: Date }> = []
  let total = 0
  for (const e of entries) {
    const st = await stat(e.path)
    items.push({ ...e, size: st.size, mtime: st.mtime })
    total += st.size
  }
  if (total > ZIP_MAX_BYTES) throw new Error('the bundle would exceed 4 GB; export fewer parts or skip the zip')

  const sink = Bun.file(outPath).writer()
  let offset = 0
  const central: Buffer[] = []

  for (const item of items) {
    const name = Buffer.from(item.name, 'utf8')
    const crc = await crc32OfFile(item.path)
    const { time, date } = dosStamp(item.mtime)

    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed: 2.0
    local.writeUInt16LE(0x0800, 6) // flags: UTF-8 names
    local.writeUInt16LE(0, 8) // method: store
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(item.size, 18)
    local.writeUInt32LE(item.size, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    name.copy(local, 30)
    sink.write(local)

    for await (const chunk of Bun.file(item.path).stream()) {
      sink.write(chunk)
      await sink.flush()
    }

    const cd = Buffer.alloc(46 + name.length)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(0x031e, 4) // made by: Unix, 3.0 — Finder shows sane permissions
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0x0800, 8)
    cd.writeUInt16LE(0, 10)
    cd.writeUInt16LE(time, 12)
    cd.writeUInt16LE(date, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(item.size, 20)
    cd.writeUInt32LE(item.size, 24)
    cd.writeUInt16LE(name.length, 28)
    cd.writeUInt16LE(0, 30) // extra
    cd.writeUInt16LE(0, 32) // comment
    cd.writeUInt16LE(0, 34) // disk
    cd.writeUInt16LE(0, 36) // internal attrs
    cd.writeUInt32LE((0o100644 << 16) >>> 0, 38) // external attrs: -rw-r--r--
    cd.writeUInt32LE(offset, 42)
    name.copy(cd, 46)
    central.push(cd)

    offset += local.length + item.size
  }

  const cdStart = offset
  let cdSize = 0
  for (const cd of central) {
    sink.write(cd)
    cdSize += cd.length
  }
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(items.length, 8)
  end.writeUInt16LE(items.length, 10)
  end.writeUInt32LE(cdSize, 12)
  end.writeUInt32LE(cdStart, 16)
  end.writeUInt16LE(0, 20)
  sink.write(end)
  await sink.end()

  return { size: cdStart + cdSize + 22, count: items.length }
}
