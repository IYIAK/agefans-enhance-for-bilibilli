/**
 * B 站弹幕分段 DmSegMobileReply 的最小 protobuf 编解码。
 *
 * schema 来自播放器 bundle（bilibili.community.service.dm.v1）：
 *   message DmSegMobileReply {
 *     repeated DanmakuElem elems = 1;
 *     repeated DmColorful colorfulSrc = 5;
 *   }
 *   message DanmakuElem {
 *     int32 stime = 2;      // 出现时间，毫秒
 *     int32 mode = 3;       // 1-3 滚动，4 底部，5 顶部，6 逆向，7 高级，8 代码，9 BAS
 *     int32 size = 4;       // 字号 18/25/36
 *     uint32 color = 5;     // RGB888
 *     string uhash = 6;
 *     string text = 7;
 *     int64 date = 8;
 *     int32 weight = 9;
 *     string action = 10;
 *     int32 pool = 11;
 *     string dmid = 12;
 *     int32 attr = 13;
 *     string animation = 22;
 *     int64 oid = 26;
 *     int32 dmFrom = 27;
 *   }
 *
 * 合并方式：protobuf 允许 repeated 字段在字节流里拼接，因此直接在原响应
 * 末尾追加 field 1 的记录即可，B 站播放器用 protobufjs decode 时会拿到更多 elems。
 * 这里不依赖 protobufjs：播放器只在自己的 bundle 里内置了 schema，页面全局没有。
 */

const WIRE_VARINT = 0
const WIRE_FIXED64 = 1
const WIRE_LEN = 2
const WIRE_FIXED32 = 5

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export interface NativeElem {
  /** 出现时间（毫秒） */
  timeMs: number
  mode: number
  /** RGB888 */
  color: number
  text: string
  dmid: string
}

export interface InjectElem {
  timeMs: number
  mode: number
  color: number
  text: string
  dmid: string
  oid?: number
}

interface VarintResult {
  value: number
  next: number
}

/** 读取一个 varint；超出安全整数范围的 64 位值会损失精度，这里只用于时间/颜色等小字段 */
function readVarint(buf: Uint8Array, pos: number): VarintResult | undefined {
  let value = 0
  let factor = 1
  let p = pos

  while (p < buf.length) {
    const byte = buf[p++]
    value += (byte & 0x7f) * factor
    if ((byte & 0x80) === 0) return { value, next: p }
    factor *= 128
    if (factor > 2 ** 56) return { value, next: p }
  }

  return undefined
}

function skipField(buf: Uint8Array, pos: number, wire: number): number | undefined {
  if (wire === WIRE_VARINT) return readVarint(buf, pos)?.next
  if (wire === WIRE_FIXED64) return pos + 8 <= buf.length ? pos + 8 : undefined
  if (wire === WIRE_FIXED32) return pos + 4 <= buf.length ? pos + 4 : undefined
  if (wire === WIRE_LEN) {
    const len = readVarint(buf, pos)
    if (!len) return undefined
    const end = len.next + len.value
    return end <= buf.length ? end : undefined
  }
  // group / 未知类型：无法安全跳过
  return undefined
}

function decodeElem(buf: Uint8Array): NativeElem {
  let pos = 0
  let timeMs = 0
  let mode = 1
  let color = 0xffffff
  let text = ''
  let dmid = ''

  while (pos < buf.length) {
    const key = readVarint(buf, pos)
    if (!key) break
    pos = key.next
    const field = Math.floor(key.value / 8)
    const wire = key.value % 8

    if (wire === WIRE_LEN) {
      const len = readVarint(buf, pos)
      if (!len) break
      const start = len.next
      const end = start + len.value
      if (end > buf.length) break

      if (field === 7) text = decoder.decode(buf.subarray(start, end))
      else if (field === 12) dmid = decoder.decode(buf.subarray(start, end))

      pos = end
      continue
    }

    if (wire === WIRE_VARINT) {
      const val = readVarint(buf, pos)
      if (!val) break
      pos = val.next
      if (field === 2) timeMs = val.value
      else if (field === 3) mode = val.value
      else if (field === 5) color = val.value
      continue
    }

    const next = skipField(buf, pos, wire)
    if (next === undefined) break
    pos = next
  }

  return { timeMs, mode, color, text, dmid }
}

/** 一条原生弹幕：保留原始字节，重新拼装时原样写回，未建模的字段不会丢 */
export interface ReplyRecord {
  /** DanmakuElem 的载荷（不含 field 1 的 tag 与长度头） */
  body: Uint8Array
  elem: NativeElem
}

export interface DecodedReply {
  records: ReplyRecord[]
  /** elems 之外的顶层字段（colorfulSrc 等），原样保留 */
  others: Uint8Array[]
}

/**
 * 拆开一个分段响应。
 *
 * 只解析需要判断的字段，但每条弹幕的原始字节都留着 —— 过滤原生弹幕时要重建
 * 响应，重新编码会丢掉 weight/attr/animation/colorful 这些没建模的字段。
 */
export function decodeReply(buf: Uint8Array): DecodedReply {
  const records: ReplyRecord[] = []
  const others: Uint8Array[] = []
  let pos = 0

  while (pos < buf.length) {
    const start = pos
    const key = readVarint(buf, pos)
    if (!key) break
    pos = key.next
    const field = Math.floor(key.value / 8)
    const wire = key.value % 8

    if (wire === WIRE_LEN) {
      const len = readVarint(buf, pos)
      if (!len) break
      const bodyStart = len.next
      const end = bodyStart + len.value
      if (end > buf.length) break
      if (field === 1) {
        const body = buf.subarray(bodyStart, end)
        records.push({ body, elem: decodeElem(body) })
      } else {
        // 整段原样留着，包括 tag 和长度头
        others.push(buf.subarray(start, end))
      }
      pos = end
      continue
    }

    const next = skipField(buf, pos, wire)
    if (next === undefined) break
    others.push(buf.subarray(start, next))
    pos = next
  }

  return { records, others }
}

/** 解码一个分段响应里的原生弹幕（只取合并需要的字段） */
export function decodeElems(buf: Uint8Array): NativeElem[] {
  return decodeReply(buf).records.map((record) => record.elem)
}

class ByteWriter {
  private bytes: number[] = []

  varint(value: number) {
    let v = Math.max(0, Math.floor(value))
    while (v >= 128) {
      this.bytes.push((v % 128) + 128)
      v = Math.floor(v / 128)
    }
    this.bytes.push(v)
  }

  tag(field: number, wire: number) {
    this.varint(field * 8 + wire)
  }

  varintField(field: number, value: number) {
    this.tag(field, WIRE_VARINT)
    this.varint(value)
  }

  stringField(field: number, value: string) {
    const body = encoder.encode(value)
    this.tag(field, WIRE_LEN)
    this.varint(body.length)
    for (let i = 0; i < body.length; i++) this.bytes.push(body[i])
  }

  finish() {
    return Uint8Array.from(this.bytes)
  }
}

function encodeElem(elem: InjectElem): Uint8Array {
  const w = new ByteWriter()
  w.varintField(2, elem.timeMs)
  w.varintField(3, elem.mode)
  w.varintField(4, 25)
  w.varintField(5, elem.color)
  w.stringField(6, 'k-danmaku')
  w.stringField(7, elem.text)
  w.varintField(8, Math.floor(Date.now() / 1000))
  w.varintField(9, 10)
  w.varintField(11, 0)
  w.stringField(12, elem.dmid)
  if (elem.oid) w.varintField(26, elem.oid)
  return w.finish()
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

function wrapElemBody(body: Uint8Array): Uint8Array[] {
  const header = new ByteWriter()
  header.tag(1, WIRE_LEN)
  header.varint(body.length)
  return [header.finish(), body]
}

/** 把注入弹幕追加为 DmSegMobileReply.elems（field 1） */
export function appendElems(base: Uint8Array, elems: InjectElem[]): Uint8Array {
  if (!elems.length) return base
  const parts: Uint8Array[] = [base]
  for (const elem of elems) {
    parts.push(...wrapElemBody(encodeElem(elem)))
  }
  return concat(parts)
}

/**
 * 重建分段响应。
 *
 * 与 appendElems 的区别是保留哪些原生弹幕由调用方决定 —— 过滤器要对原生
 * 弹幕生效，就只能重建而不能追加。回调返回原始载荷表示原样写回，返回新载荷
 * 表示替换（合并相似弹幕时要改文字），返回 null 表示丢掉这条。
 */
export function rebuildReply(
  decoded: DecodedReply,
  bodyOf: (elem: NativeElem, index: number) => Uint8Array | null,
  inject: InjectElem[]
): Uint8Array {
  const parts: Uint8Array[] = []
  for (let i = 0; i < decoded.records.length; i++) {
    const record = decoded.records[i]
    const body = bodyOf(record.elem, i)
    if (!body) continue
    parts.push(...wrapElemBody(body))
  }
  for (const elem of inject) {
    parts.push(...wrapElemBody(encodeElem(elem)))
  }
  for (const other of decoded.others) parts.push(other)
  return concat(parts)
}

/**
 * 换掉一条原生记录的正文，其余字段按原字节拷贝。
 *
 * 合并相似弹幕时要在文字后面标出条数，但整体重新编码会丢掉没建模的字段，
 * 所以只重写 field 7，其他部分一个字节都不动。
 */
export function replaceElemText(body: Uint8Array, text: string): Uint8Array {
  const parts: Uint8Array[] = []
  let pos = 0

  while (pos < body.length) {
    const start = pos
    const key = readVarint(body, pos)
    if (!key) break
    pos = key.next
    const field = Math.floor(key.value / 8)
    const wire = key.value % 8

    let end: number | undefined
    if (wire === WIRE_LEN) {
      const len = readVarint(body, pos)
      if (!len) break
      end = len.next + len.value
      if (end > body.length) break
    } else {
      end = skipField(body, pos, wire)
      if (end === undefined) break
    }

    if (field === 7 && wire === WIRE_LEN) {
      const writer = new ByteWriter()
      writer.stringField(7, text)
      parts.push(writer.finish())
    } else {
      parts.push(body.subarray(start, end))
    }
    pos = end
  }

  return concat(parts)
}
