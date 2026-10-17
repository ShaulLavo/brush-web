// Adapted from bun-wasm web/src/crypto-host.js at 8d3d416aa9cb23718ed3487a33d0b06e8e373672.
// Local adaptations: runtime peer imports; browser-shell worker URLs and terminal transport where noted.
const methods = [
  "generateKey",
  "importKey",
  "exportKey",
  "sign",
  "verify",
  "encrypt",
  "decrypt",
  "deriveBits",
  "deriveKey",
  "wrapKey",
  "unwrapKey",
];
const aesNames = new Set(["AES-GCM", "AES-CBC", "AES-CTR", "AES-KW"]);
const nameOf = (algorithm) =>
  typeof algorithm === "string" ? algorithm.toUpperCase() : algorithm?.name?.toUpperCase();
export function installHostCrypto(provider, Key, c, native) {
  if (!provider) return;
  const original = Object.fromEntries(methods.map((name) => [name, provider[name]]));
  const host = Object.fromEntries(methods.map((name) => [name, original[name].bind(provider)]));
  const capabilities = new Map();
  let kwJwkCapability;
  const ownKey = (key) => c.isKey(key) && !c.record(key).nativeKey;
  const dummy = c.makeKey({ name: "AES-GCM", length: 192 }, "secret", true, ["encrypt"], {
    kty: "oct",
    k: c.encode(new Uint8Array(24)),
  });
  Object.setPrototypeOf(Object.getPrototypeOf(dummy), Key.prototype);
  function supports192(name) {
    if (!capabilities.has(name)) {
      const usages = name === "AES-KW" ? ["wrapKey"] : ["encrypt"];
      capabilities.set(
        name,
        host.importKey("raw", new Uint8Array(24), name, true, usages).then(
          () => true,
          (error) => {
            if (["OperationError", "NotSupportedError"].includes(error.name)) return false;
            throw error;
          },
        ),
      );
    }
    return capabilities.get(name);
  }
  function supportsKwJwk() {
    if (!kwJwkCapability) {
      kwJwkCapability = Promise.all([
        host.importKey("raw", new Uint8Array(16), "AES-KW", false, ["wrapKey"]),
        host.importKey("raw", new Uint8Array(16), { name: "HMAC", hash: "SHA-256" }, true, [
          "sign",
        ]),
      ])
        .then(([wrapping, key]) => host.wrapKey("jwk", key, wrapping, { name: "AES-KW" }))
        .then(
          () => true,
          (error) => {
            if (["OperationError", "DataError", "NotSupportedError"].includes(error.name))
              return false;
            throw error;
          },
        );
    }
    return kwJwkCapability;
  }
  function candidateKey(key) {
    if (!ownKey(key)) return false;
    const a = c.record(key).algorithm;
    return aesNames.has(a.name) && a.length === 192;
  }
  async function fallbackKey(key) {
    return candidateKey(key) && !(await supports192(c.record(key).algorithm.name));
  }
  function snapshot(a) {
    if (!a || typeof a !== "object") return a;
    const out = { ...a };
    for (const field of ["iv", "counter", "additionalData", "label", "salt", "info"])
      if (out[field] !== undefined) out[field] = c.buffer(out[field]);
    return out;
  }
  function rawSize(format, data) {
    if (format === "raw") return data.byteLength;
    if (format === "jwk" && typeof data?.k === "string") return c.decode(data.k).length;
    return 0;
  }
  async function importKey(format, data, a, extractable, usages) {
    const name = nameOf(a);
    if (!aesNames.has(name) || rawSize(format, data) !== 24)
      return host.importKey(format, data, a, extractable, usages);
    const saved = format === "jwk" ? { ...data } : c.buffer(data),
      params = snapshot(a),
      policy = Array.from(usages);
    return (await supports192(name))
      ? host.importKey(format, saved, params, extractable, policy)
      : c.importKey(format, saved, params, extractable, policy);
  }
  async function exportKey(format, key) {
    if (!candidateKey(key)) return host.exportKey(format, key);
    format = String(format);
    return (await fallbackKey(key)) ? c.exportKey(format, key) : host.exportKey(format, key);
  }
  function bytesFor(format, data, a) {
    let bytes = format === "jwk" ? native.utf8Encode(JSON.stringify(data)) : new Uint8Array(data);
    if (format === "jwk" && nameOf(a) === "AES-KW") {
      const padded = new Uint8Array(Math.ceil(bytes.length / 8) * 8).fill(32);
      padded.set(bytes);
      bytes = padded;
    }
    return bytes;
  }
  function keyData(format, bytes) {
    if (format !== "jwk") return bytes;
    try {
      return JSON.parse(native.utf8Decode(new Uint8Array(bytes), true));
    } catch {
      throw new DOMException("Invalid wrapped JWK", "DataError");
    }
  }
  async function keyOperation(operation, a, key, input) {
    if (!candidateKey(key)) return host[operation](a, key, ...input);
    const params = snapshot(a),
      bytes = input.map((value) => c.buffer(value));
    if (!(await fallbackKey(key))) return host[operation](params, key, ...bytes);
    if (operation === "sign") return c.signVerify("sign", params, key, bytes[0]);
    if (operation === "verify") return c.signVerify("verify", params, key, bytes[1], bytes[0]);
    return c.crypt(operation, params, key, bytes[0]);
  }
  const bridge = {
    async generateKey(a, extractable, usages) {
      const name = nameOf(a);
      if (!aesNames.has(name) || a.length !== 192) return host.generateKey(a, extractable, usages);
      const params = snapshot(a),
        policy = Array.from(usages);
      return (await supports192(name))
        ? host.generateKey(params, extractable, policy)
        : c.generate(params, extractable, policy);
    },
    importKey,
    exportKey,
    sign: (a, key, data) => keyOperation("sign", a, key, [data]),
    verify: (a, key, signature, data) => keyOperation("verify", a, key, [signature, data]),
    encrypt: (a, key, data) => keyOperation("encrypt", a, key, [data]),
    decrypt: (a, key, data) => keyOperation("decrypt", a, key, [data]),
    async deriveBits(a, key, length) {
      if (!candidateKey(key)) return host.deriveBits(a, key, length);
      const params = snapshot(a);
      return (await fallbackKey(key))
        ? c.deriveBits(params, key, length)
        : host.deriveBits(params, key, length);
    },
    async deriveKey(a, key, target, extractable, usages) {
      const name = nameOf(target);
      if (!candidateKey(key) && (!aesNames.has(name) || target.length !== 192))
        return host.deriveKey(a, key, target, extractable, usages);
      a = snapshot(a);
      target = snapshot(target);
      usages = Array.from(usages);
      if (await fallbackKey(key)) {
        const normalized = c.algorithm(target);
        if (normalized.name === "HMAC" && !normalized.hash)
          throw new TypeError("Algorithm hash is required");
        return c.deriveBits(a, key, normalized.length || 0, "deriveKey");
      }
      if (!aesNames.has(name) || target.length !== 192 || (await supports192(name)))
        return host.deriveKey(a, key, target, extractable, usages);
      const carrier = await host.deriveKey(
        a,
        key,
        { name: "HMAC", hash: "SHA-256", length: 192 },
        true,
        ["sign"],
      );
      return c.importKey("raw", await host.exportKey("raw", carrier), target, extractable, usages);
    },
    async wrapKey(format, key, wrappingKey, a) {
      const kwJwk = format === "jwk" && nameOf(a) === "AES-KW";
      if (!candidateKey(key) && !candidateKey(wrappingKey) && !kwJwk)
        return host.wrapKey(format, key, wrappingKey, a);
      format = String(format);
      a = snapshot(a);
      const ownTarget = await fallbackKey(key),
        ownWrapping = await fallbackKey(wrappingKey);
      if (!ownTarget && !ownWrapping && (!kwJwk || (await supportsKwJwk())))
        return host.wrapKey(format, key, wrappingKey, a);
      const bytes = bytesFor(format, await exportKey(format, key), a);
      if (ownWrapping) return c.crypt("encrypt", a, wrappingKey, bytes, "wrapKey");
      const carrier = await host.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, true, [
        "sign",
      ]);
      return host.wrapKey("raw", carrier, wrappingKey, a);
    },
    async unwrapKey(format, wrapped, key, a, target, extractable, usages) {
      if (!candidateKey(key) && !aesNames.has(nameOf(target)))
        return host.unwrapKey(format, wrapped, key, a, target, extractable, usages);
      format = String(format);
      wrapped = c.buffer(wrapped);
      a = snapshot(a);
      target = snapshot(target);
      usages = Array.from(usages);
      if (await fallbackKey(key))
        return importKey(
          format,
          keyData(format, c.crypt("decrypt", a, key, wrapped, "unwrapKey")),
          target,
          extractable,
          usages,
        );
      try {
        return await host.unwrapKey(format, wrapped, key, a, target, extractable, usages);
      } catch (error) {
        const name = nameOf(target);
        if (
          !aesNames.has(name) ||
          !["OperationError", "NotSupportedError"].includes(error.name) ||
          (await supports192(name))
        )
          throw error;
        const carrier = await host.unwrapKey(
          "raw",
          wrapped,
          key,
          a,
          { name: "HMAC", hash: "SHA-256" },
          true,
          ["sign"],
        );
        const data = keyData(format, await host.exportKey("raw", carrier));
        if (rawSize(format, data) !== 24) throw error;
        return c.importKey(format, data, target, extractable, usages);
      }
    },
  };
  for (const name of methods) {
    const wrapper = {
      [name](...args) {
        return Reflect.apply(this === provider ? bridge[name] : original[name], this, args);
      },
    }[name];
    Object.defineProperty(wrapper, "length", { value: original[name].length });
    Object.defineProperty(provider, name, { value: wrapper, writable: true, configurable: true });
  }
}
