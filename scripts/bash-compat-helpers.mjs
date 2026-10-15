// Oils spec tests call two small Python 2 helpers. Every engine gets the same behavior:
// bash runs these files, and the in-process engines register equivalent builtins.

/** Formats arguments like Python 2's `print(sys.argv[1:])`. */
export function pythonList(args) {
  return `[${args.map((arg) => pythonRepr(Buffer.from(arg, "utf8"))).join(", ")}]\n`;
}

function pythonRepr(bytes) {
  const quote = bytes.includes(0x27) && !bytes.includes(0x22) ? '"' : "'";
  let text = quote;
  for (const byte of bytes) {
    if (byte === 0x5c) text += "\\\\";
    else if (byte === 0x0a) text += "\\n";
    else if (byte === 0x0d) text += "\\r";
    else if (byte === 0x09) text += "\\t";
    else if (byte === 0x27 && quote === "'") text += "\\'";
    else if (byte >= 0x20 && byte < 0x7f) text += String.fromCharCode(byte);
    else text += `\\x${byte.toString(16).padStart(2, "0")}`;
  }
  return text + quote;
}

export const pythonHelpers = {
  "argv.py": `#!/usr/bin/env python3
import os, sys
def r(b):
    q = '"' if b"'" in b and b'"' not in b else "'"
    out = q
    for c in b:
        if c == 0x5c: out += "\\\\\\\\"
        elif c == 0x0a: out += "\\\\n"
        elif c == 0x0d: out += "\\\\r"
        elif c == 0x09: out += "\\\\t"
        elif c == 0x27 and q == "'": out += "\\\\'"
        elif 0x20 <= c < 0x7f: out += chr(c)
        else: out += "\\\\x%02x" % c
    return out + q
sys.stdout.write("[" + ", ".join(r(os.fsencode(a)) for a in sys.argv[1:]) + "]\\n")
`,
  "printenv.py": `#!/usr/bin/env python3
import os, sys
for name in sys.argv[1:]:
    value = os.environb.get(os.fsencode(name))
    sys.stdout.buffer.write((value if value is not None else b"None") + b"\\n")
`,
};
