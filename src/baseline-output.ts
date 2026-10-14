const CHUNK_UNITS = 8192;

export class BaselineOutput {
  private readonly encoder = new TextEncoder();
  private readonly buffer = new Uint8Array(32768);
  private previousCR = false;

  constructor(private readonly write: (bytes: Uint8Array) => number) {}

  result(stdout: string, stderr: string): void {
    this.previousCR = false;
    const boundary = stdout.charCodeAt(stdout.length - 1);
    const next = stderr.charCodeAt(0);
    if (isHighSurrogate(boundary) && next >= 0xdc00 && next <= 0xdfff) {
      if (!this.stream(stdout.slice(0, -1))) return;
      if (!this.stream(stdout.slice(-1) + stderr.slice(0, 1))) return;
      this.stream(stderr.slice(1));
      return;
    }
    if (!this.stream(stdout)) return;
    this.stream(stderr);
  }

  private stream(text: string): boolean {
    let offset = 0;
    while (offset < text.length) {
      let end = Math.min(text.length, offset + CHUNK_UNITS);
      if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end--;
      const chunk = text.slice(offset, end);
      let normalized = chunk.replace(/\r?\n/g, "\r\n");
      if (this.previousCR && chunk.startsWith("\n")) normalized = normalized.slice(1);
      const encoded = this.encoder.encodeInto(normalized, this.buffer);
      const bytes = this.buffer.subarray(0, encoded.written);
      if (this.write(bytes) !== bytes.length) return false;
      this.previousCR = chunk.endsWith("\r");
      offset = end;
    }
    return true;
  }
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
