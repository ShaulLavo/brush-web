// Adapted from bun-wasm web/src/crypto-inputs.js at 8d3d416aa9cb23718ed3487a33d0b06e8e373672.
// Local adaptations: runtime peer imports; browser-shell worker URLs and terminal transport where noted.
const dataArguments = {
  digest: [1],
  importKey: [1],
  sign: [2],
  verify: [2, 3],
  encrypt: [2],
  decrypt: [2],
  unwrapKey: [1],
};
const parameterArguments = {
  generateKey: 0,
  encrypt: 0,
  decrypt: 0,
  deriveBits: 0,
  deriveKey: 0,
  wrapKey: 3,
  unwrapKey: 3,
};
const parameterBuffers = {
  "AES-GCM": ["iv", "additionalData"],
  "AES-CBC": ["iv"],
  "AES-CTR": ["counter"],
  "RSA-OAEP": ["label"],
  HKDF: ["salt", "info"],
  PBKDF2: ["salt"],
};
const oversized = (value) =>
  (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) && value.byteLength > 0x7fffffff;
export function oversizedCryptoInput(operation, args) {
  if ((dataArguments[operation] || []).some((index) => oversized(args[index]))) return true;
  const parameters = args[parameterArguments[operation]];
  if (!parameters || typeof parameters !== "object" || typeof parameters.name !== "string")
    return false;
  const name = parameters.name.toUpperCase();
  const fields =
    operation === "generateKey"
      ? name.startsWith("RSA")
        ? ["publicExponent"]
        : []
      : parameterBuffers[name] || [];
  return fields.some((field) => oversized(parameters[field]));
}
