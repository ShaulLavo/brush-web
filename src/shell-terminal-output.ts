// Original own-shell terminal presentation. Descriptor and pipe traffic stays byte-exact;
// only the final terminal attachment applies the TTY's output newline discipline.
export class TerminalNewlines {
  private previousCR = false;

  write(bytes: Uint8Array, output: (bytes: Uint8Array) => void): void {
    // At most twice one bridge drain, independent of guest output volume. Never decode
    // guest bytes: incomplete UTF-8, NUL and non-UTF-8 data belong to the terminal parser.
    const buffer = new Uint8Array(Math.min(32768, Math.max(2, bytes.length * 2)));
    let count = 0;
    const emit = (byte: number) => {
      buffer[count++] = byte;
      if (count === buffer.length) {
        output(buffer.slice());
        count = 0;
      }
    };
    for (const byte of bytes) {
      if (byte === 10 && !this.previousCR) emit(13);
      emit(byte);
      this.previousCR = byte === 13;
    }
    if (count) output(buffer.slice(0, count));
  }
}
