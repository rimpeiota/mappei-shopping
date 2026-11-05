export const MAX_MAIL_BYTES = 262144;
export const MAX_HEADER_BYTES = 32768;
export const MAX_UIDS = 100;
export const LOOKBACK_DAYS = 30;
const MAX_REPLY_BYTES = 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
type SocketLike = { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array>; close(): Promise<void> };
export class CollectorError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}
type Reply = { lines: string[]; literals: Uint8Array[] };
const quoted = (value: string) => {
  if (!value || value.length > 512 || /[\x00-\x1f\x7f]/u.test(value)) throw new CollectorError('invalid_configuration');
  return '"' + value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"') + '"';
};
function join(a: Uint8Array, b: Uint8Array): Uint8Array {
  const joined = new Uint8Array(a.length + b.length); joined.set(a); joined.set(b, a.length); return joined;
}

/** A bounded, sequential IMAP reader. It has no message-write commands. */
export class ReadOnlyImap {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private buffer: Uint8Array = new Uint8Array();
  private counter = 0;
  private closed = false;
  private readonly socket: SocketLike;
  private readonly deadline: number;
  constructor(socket: SocketLike, deadline = Date.now() + 180000) {
    this.socket = socket; this.deadline = deadline;
    this.reader = socket.readable.getReader(); this.writer = socket.writable.getWriter();
  }
  private async refill() {
    const remaining = Math.min(15000, this.deadline - Date.now());
    if (remaining <= 0) throw new CollectorError('imap_timeout');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const chunk = await Promise.race([
        this.reader.read(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new CollectorError('imap_timeout')), remaining); }),
      ]);
      if (chunk.done) throw new CollectorError('imap_closed');
      if (this.buffer.length + chunk.value.length > MAX_REPLY_BYTES) throw new CollectorError('imap_reply_too_large');
      this.buffer = join(this.buffer, chunk.value);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }
  private async line(): Promise<string> {
    while (true) {
      for (let index = 0; index < this.buffer.length - 1; index += 1) {
        if (this.buffer[index] === 13 && this.buffer[index + 1] === 10) {
          const value = decoder.decode(this.buffer.slice(0, index)); this.buffer = this.buffer.slice(index + 2); return value;
        }
      }
      if (this.buffer.length > MAX_HEADER_BYTES) throw new CollectorError('imap_line_too_large');
      await this.refill();
    }
  }
  private async exact(size: number): Promise<Uint8Array> {
    while (this.buffer.length < size) await this.refill();
    const value = this.buffer.slice(0, size); this.buffer = this.buffer.slice(size); return value;
  }
  private async command(command: string, literalLimit = MAX_HEADER_BYTES): Promise<Reply> {
    if (this.closed || Date.now() >= this.deadline) throw new CollectorError('imap_timeout');
    const tag = `M${++this.counter}`;
    await this.writer.write(encoder.encode(`${tag} ${command}\r\n`));
    const result: Reply = { lines: [], literals: [] };
    let received = 0;
    while (true) {
      const line = await this.line(); received += encoder.encode(line).length;
      if (received > MAX_REPLY_BYTES) throw new CollectorError('imap_reply_too_large');
      if (line.startsWith(`${tag} `)) {
        if (!new RegExp(`^${tag} OK(?: |$)`, 'u').test(line)) throw new CollectorError(command.startsWith('LOGIN ') ? 'imap_authentication_failed' : 'imap_command_failed');
        return result;
      }
      if (/^\* BYE(?: |$)/u.test(line)) throw new CollectorError('imap_closed');
      result.lines.push(line);
      const literal = line.match(/\{(\d+)\}$/u);
      if (literal) {
        const length = Number(literal[1]);
        if (!Number.isSafeInteger(length) || length > literalLimit || received + length > MAX_REPLY_BYTES) throw new CollectorError('imap_literal_too_large');
        result.literals.push(await this.exact(length)); received += length;
      }
      if (result.lines.length > 10000) throw new CollectorError('imap_reply_too_large');
    }
  }
  async login(account: string, password: string) {
    const greeting = await this.line();
    if (!/^\* OK(?: |$)/u.test(greeting)) throw new CollectorError('imap_greeting_failed');
    await this.command(`LOGIN ${quoted(account)} ${quoted(password)}`);
  }
  async examine(mailbox: string): Promise<string> {
    const reply = await this.command(`EXAMINE ${quoted(mailbox)}`);
    const validity = reply.lines.map(line => line.match(/\[UIDVALIDITY (\d+)\]/iu)?.[1]).find(Boolean);
    if (!validity) throw new CollectorError('imap_uidvalidity_missing');
    return validity;
  }
  async search(since: Date, afterUid: number): Promise<{ uids: number[]; limited: boolean }> {
    if (!Number.isSafeInteger(afterUid) || afterUid < 0) throw new CollectorError('invalid_cursor');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const date = `${since.getUTCDate()}-${months[since.getUTCMonth()]}-${since.getUTCFullYear()}`;
    const reply = await this.command(`UID SEARCH SINCE ${date} UID ${afterUid + 1}:*`);
    const uids = [...new Set(reply.lines.filter(line => /^\* SEARCH(?: |$)/u.test(line)).flatMap(line => line.slice(8).trim().split(/\s+/u)
      .filter(Boolean).map(Number)))].filter(uid => Number.isSafeInteger(uid) && uid > afterUid && uid <= 0xffffffff).sort((a, b) => a - b);
    return { uids: uids.slice(0, MAX_UIDS), limited: uids.length > MAX_UIDS };
  }
  /** Diagnostic paging is independent of the durable oldest-first collection cursor. */
  async searchRecent(since: Date, beforeUid = 0): Promise<{ uids: number[]; limited: boolean }> {
    if (!Number.isSafeInteger(beforeUid) || beforeUid < 0 || beforeUid > 0xffffffff || !Number.isFinite(since.getTime())) {
      throw new CollectorError('invalid_cursor');
    }
    if (beforeUid === 1) return { uids: [], limited: false };
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const date = `${since.getUTCDate()}-${months[since.getUTCMonth()]}-${since.getUTCFullYear()}`;
    const range = beforeUid > 0 ? `1:${beforeUid - 1}` : '1:*';
    const reply = await this.command(`UID SEARCH SINCE ${date} UID ${range}`);
    const uids = [...new Set(reply.lines.filter(line => /^\* SEARCH(?: |$)/u.test(line)).flatMap(line => line.slice(8).trim().split(/\s+/u)
      .filter(Boolean).map(Number)))].filter(uid => Number.isSafeInteger(uid) && uid > 0 && uid <= 0xffffffff && (!beforeUid || uid < beforeUid))
      .sort((a, b) => b - a);
    return { uids: uids.slice(0, MAX_UIDS), limited: uids.length > MAX_UIDS };
  }
  async headers(uid: number): Promise<{ bytes: Uint8Array; size: number; internalDate: number }> {
    this.validUid(uid);
    const reply = await this.command(`UID FETCH ${uid} (UID RFC822.SIZE INTERNALDATE BODY.PEEK[HEADER.FIELDS (FROM SUBJECT MESSAGE-ID DATE)])`);
    const text = reply.lines.join(' ');
    const size = Number(text.match(/RFC822\.SIZE (\d+)/iu)?.[1]);
    const internalDate = parseInternalDate(text.match(/INTERNALDATE "([^"]+)"/iu)?.[1] ?? '');
    if (!Number.isSafeInteger(size) || size < 0 || internalDate === null || reply.literals.length !== 1
      || !new RegExp(`\\bUID ${uid}(?: |\\))`, 'u').test(text)) throw new CollectorError('imap_metadata_invalid');
    return { bytes: reply.literals[0], size, internalDate };
  }
  async body(uid: number): Promise<Uint8Array> {
    this.validUid(uid);
    const reply = await this.command(`UID FETCH ${uid} (UID BODY.PEEK[])`, MAX_MAIL_BYTES);
    if (reply.literals.length !== 1 || !new RegExp(`\\bUID ${uid}(?: |\\))`, 'u').test(reply.lines.join(' '))) throw new CollectorError('imap_body_invalid');
    return reply.literals[0];
  }
  private validUid(uid: number) { if (!Number.isSafeInteger(uid) || uid <= 0 || uid > 0xffffffff) throw new CollectorError('invalid_cursor'); }
  async close() {
    this.closed = true;
    // Closing a read-only session never expunges messages and does not set Seen.
    await this.socket.close().catch(() => {});
    this.reader.releaseLock(); this.writer.releaseLock();
  }
}

export function parseInternalDate(value: string): number | null {
  const match = value.match(/^(\d{1,2})-([A-Z][a-z]{2})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/u);
  if (!match) return null;
  const month = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].indexOf(match[2]);
  const [day, year, hour, minute, second, zoneHour, zoneMinute] = [1,3,4,5,6,8,9].map(index => Number(match[index]));
  if (month < 0 || day < 1 || day > new Date(Date.UTC(year, month + 1, 0)).getUTCDate() || hour > 23 || minute > 59 || second > 59 || zoneHour > 23 || zoneMinute > 59) return null;
  return Date.UTC(year, month, day, hour, minute, second) - (match[7] === '+' ? 1 : -1) * (zoneHour * 60 + zoneMinute) * 60000;
}
