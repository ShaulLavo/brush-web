// Adapted from bun-wasm web/src/native-stream-state.ts at 8d3d416aa9cb23718ed3487a33d0b06e8e373672.
// Local adaptations: runtime peer imports; browser-shell worker URLs and terminal transport where noted.
const closedKey = Symbol.for("nodejs.webstream.isClosedPromise");
const errorKey = Symbol.for("nodejs.webstream.controllerErrorFunction");
const NativeAbortController = globalThis.AbortController;
const NativeAbortSignal = globalThis.AbortSignal;
const Native = {
  ReadableStream,
  WritableStream,
  TransformStream,
  ReadableStreamDefaultReader,
  ReadableStreamBYOBReader,
  WritableStreamDefaultWriter,
  ReadableStreamDefaultController,
  ReadableByteStreamController,
  WritableStreamDefaultController,
  TransformStreamDefaultController,
};
type Kind = "readable" | "writable" | "transform";
type Timer = ReturnType<typeof setTimeout>;
type Session = { alive: boolean; values: Set<WeakRef<Completion>>; timers: Set<Timer> };
type Group = {
  kind: Kind;
  controller: object | null;
  error: ((reason: unknown) => void) | null;
  pending: unknown[];
  barriers: Set<Promise<unknown>>;
  values: Completion[];
  notification?: { owner: Session; id?: Timer } | null;
};
type Completion = {
  stream: WeakRef<object>;
  readable: boolean;
  group?: Group;
  promise: Promise<void>;
  fulfill: () => void;
  fail: (error: unknown) => void;
  watching: boolean;
  done: boolean;
  queued: boolean;
  handle: WeakRef<object> | null;
  session?: Session;
  weak: WeakRef<Completion>;
  observation?: { error: unknown; failed: boolean };
};
type Observer =
  | { value: Completion; observed: false }
  | {
      value: Completion;
      observed: true;
      promise: Promise<void>;
      ignore: boolean;
    };
const apply = Reflect.apply;
const NativePromise = Promise;
const controllerErrors = {
  readable: Native.ReadableStreamDefaultController.prototype.error,
  bytes: Native.ReadableByteStreamController.prototype.error,
  writable: Native.WritableStreamDefaultController.prototype.error,
  transform: Native.TransformStreamDefaultController.prototype.error,
};
const resolve = Promise.resolve.bind(Promise);
const reject = Promise.reject.bind(Promise);
function then<T>(
  promise: Promise<T>,
  success?: (value: T) => unknown,
  failure?: (error: unknown) => unknown,
) {
  return apply(NativePromise.prototype.then, promise, [success, failure]);
}
const enqueue = globalThis.queueMicrotask.bind(globalThis);
const timeout = globalThis.setTimeout.bind(globalThis);
const clear = globalThis.clearTimeout.bind(globalThis);
const records = new WeakMap<object, Completion>();
const controllers = new WeakMap<object, Group>();
const handles = new WeakMap<object, Observer>();
const pending = new Set<WeakRef<Completion>>();
let timer: Timer | undefined;
let constructors:
  | Pick<typeof globalThis, "ReadableStream" | "WritableStream" | "TransformStream">
  | undefined;
let session: Session | undefined;
function getter(prototype: object, name: string): () => unknown {
  const get = Object.getOwnPropertyDescriptor(prototype, name)?.get;
  if (!get) throw new TypeError(`Native stream getter missing: ${name}`);
  return get;
}
const readableLocked = getter(Native.ReadableStream.prototype, "locked");
const writableLocked = getter(Native.WritableStream.prototype, "locked");
const read = Native.ReadableStream.prototype.getReader;
const write = Native.WritableStream.prototype.getWriter;
const readerClosed = getter(Native.ReadableStreamDefaultReader.prototype, "closed");
const byobClosed = getter(Native.ReadableStreamBYOBReader.prototype, "closed");
const writerClosed = getter(Native.WritableStreamDefaultWriter.prototype, "closed");
const releaseReader = Native.ReadableStreamDefaultReader.prototype.releaseLock;
const releaseWriter = Native.WritableStreamDefaultWriter.prototype.releaseLock;

function record(stream: object, readable: boolean, group?: Group): Completion {
  let value = records.get(stream);
  if (value) {
    if (group) value.group = group;
    return value;
  }
  apply(readable ? readableLocked : writableLocked, stream, []);
  let fulfill!: () => void, fail!: (error: unknown) => void;
  const promise = new NativePromise<void>((a, b) => {
    fulfill = a;
    fail = b;
  });
  then(promise, undefined, () => {});
  value = {
    stream: new WeakRef(stream),
    readable,
    group,
    promise,
    fulfill,
    fail,
    watching: false,
    done: false,
    queued: false,
    handle: null,
    session,
    get weak(): WeakRef<Completion> {
      return weak;
    },
  };
  const weak: WeakRef<Completion> = new WeakRef(value);
  records.set(stream, value);
  return value;
}
function closed(handle: object, readable: boolean): Promise<void> {
  const byob =
    readable &&
    Object.prototype.isPrototypeOf.call(Native.ReadableStreamBYOBReader.prototype, handle);
  const promise = apply(readable ? (byob ? byobClosed : readerClosed) : writerClosed, handle, []);
  if (!(promise instanceof NativePromise)) throw new TypeError("Native closed promise missing");
  return promise;
}
function active(value: Completion) {
  return value.watching && !value.done && value.session?.alive;
}
function settle(value: Completion, error?: unknown, failed = false) {
  if (!active(value)) return;
  if (!value.readable && value.group?.barriers.size) {
    value.observation = { error, failed };
    return;
  }
  value.done = true;
  pending.delete(value.weak);
  if (failed) value.fail(error);
  else value.fulfill();
  for (const peer of value.group?.values ?? []) if (peer !== value) request(peer);
}
function poll(value: Completion) {
  pending.add(value.weak);
  if (timer !== undefined) return;
  timer = timeout(() => {
    timer = undefined;
    const values = Array.from(pending);
    pending.clear();
    for (const weak of values) {
      const value = weak.deref();
      if (value) request(value);
    }
  }, 16);
}
function observeHandle(value: Completion, handle: object) {
  const old = handles.get(handle);
  if (old?.observed) return;
  const promise = closed(handle, value.readable);
  const observer: Observer = { value, promise, ignore: false, observed: true };
  handles.set(handle, observer);
  then(
    promise,
    () => {
      if (!observer.ignore) settle(value);
    },
    (error) => {
      if (!observer.ignore) settle(value, error, true);
    },
  );
}
function probe(value: Completion) {
  if (!active(value)) return;
  if (value.observation) {
    settle(value, value.observation.error, value.observation.failed);
    return;
  }
  const stream = value.stream.deref();
  if (!stream) return;
  const locked = apply(value.readable ? readableLocked : writableLocked, stream, []);
  if (locked) {
    const handle = value.handle?.deref();
    if (handle) observeHandle(value, handle);
    else poll(value);
    return;
  }
  const handle = apply(value.readable ? read : write, stream, []);
  const promise = closed(handle, value.readable);
  apply(value.readable ? releaseReader : releaseWriter, handle, []);
  // Releasing a pending closed promise rejects that promise; releasing a settled
  // one replaces it. Observe only the original, already-terminal promise.
  if (closed(handle, value.readable) !== promise) {
    then(
      promise,
      () => settle(value),
      (error) => settle(value, error, true),
    );
  } else {
    then(promise, undefined, () => {});
    if (!value.group?.controller) poll(value);
  }
}
function request(value: Completion) {
  if (!active(value) || value.queued) return;
  value.queued = true;
  enqueue(() => {
    value.queued = false;
    probe(value);
  });
}
function watch(value: Completion) {
  for (const peer of value.group?.values ?? [value]) {
    peer.watching = true;
    peer.session = session;
    session?.values.add(peer.weak);
    request(peer);
  }
  return value;
}
function captureController(group: Group, controller: object) {
  group.controller = controller;
  const bytes =
    group.kind === "readable" &&
    Object.prototype.isPrototypeOf.call(Native.ReadableByteStreamController.prototype, controller);
  const error = controllerErrors[bytes ? "bytes" : group.kind];
  group.error = (reason) => {
    apply(error, controller, [reason]);
    notify(group);
  };
  controllers.set(controller, group);
  for (const reason of group.pending) group.error(reason);
  group.pending.length = 0;
}
function notify(group: Group) {
  const owner = group.values.find(active)?.session;
  if (!owner || group.notification?.owner.alive) return;
  const notification: NonNullable<Group["notification"]> = { owner };
  group.notification = notification;
  notification.id = timeout(() => {
    if (notification.id !== undefined) owner.timers.delete(notification.id);
    if (group.notification === notification) group.notification = null;
    for (const value of group.values) request(value);
  }, 0);
  owner.timers.add(notification.id);
}
function algorithm(group: Group, key: PropertyKey, source: object, callback: Function | undefined) {
  return function (...args: unknown[]) {
    if (key === "start") {
      const controller = args[0];
      if (typeof controller !== "object" || controller === null)
        throw new TypeError("Native controller missing");
      captureController(group, controller);
    }
    let result;
    try {
      result = callback === undefined ? undefined : apply(callback, source, args);
    } catch (error) {
      if (key === "start") throw error;
      result = reject(error);
    }
    const promise = resolve(result);
    const barrier = key === "abort" && group.kind === "writable";
    if (barrier) group.barriers.add(promise);
    const complete = () => {
      if (barrier) group.barriers.delete(promise);
      notify(group);
    };
    then(promise, complete, complete);
    return promise;
  };
}
function dictionary(input: unknown, methods: readonly PropertyKey[], group: Group) {
  const source = input === undefined ? {} : input;
  if (source === null || (typeof source !== "object" && typeof source !== "function"))
    return source;
  return new Proxy(
    {},
    {
      has(target, key) {
        return key === "start" || Reflect.has(source, key);
      },
      ownKeys() {
        const keys = Reflect.ownKeys(source);
        return keys.includes("start") ? keys : keys.concat(["start"]);
      },
      getOwnPropertyDescriptor(target, key) {
        if (key !== "start" && !Reflect.getOwnPropertyDescriptor(source, key)) return undefined;
        return { configurable: true, enumerable: true, writable: true, value: undefined };
      },
      get(target, key) {
        const method = Reflect.get(source, key, source);
        if (
          !methods.includes(key) ||
          (method === undefined && key !== "start") ||
          (method !== undefined && typeof method !== "function")
        )
          return method;
        return algorithm(group, key, source, method);
      },
    },
  );
}
function linkConstructor(Ctor: { prototype: object }, wrapper: Function) {
  const descriptor = Object.getOwnPropertyDescriptor(Ctor.prototype, "constructor");
  if (descriptor)
    Object.defineProperty(
      Ctor.prototype,
      "constructor",
      Object.assign({}, descriptor, { value: wrapper }),
    );
}
function construct<
  T extends typeof ReadableStream | typeof WritableStream | typeof TransformStream,
>(Ctor: T, kind: Kind, methods: readonly PropertyKey[]): T {
  let wrapper: T;
  wrapper = new Proxy(Ctor, {
    construct(target, args, newTarget) {
      const group: Group = {
        kind,
        controller: null,
        error: null,
        pending: [],
        barriers: new Set(),
        values: [],
      };
      args[0] = dictionary(args[0], methods, group);
      const stream = Reflect.construct(target, args, newTarget === wrapper ? target : newTarget);
      if (kind === "transform")
        group.values = [
          record(stream.readable, true, group),
          record(stream.writable, false, group),
        ];
      else group.values = [record(stream, kind === "readable", group)];
      if (group.controller) controllers.set(group.controller, group);
      return stream;
    },
  });
  return wrapper;
}
function method(
  prototype: object,
  name: PropertyKey,
  after: (self: object, args: unknown[], result: unknown) => void,
) {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
  if (!descriptor?.value) return;
  const original = descriptor.value;
  const wrapped = function (this: object, ...args: unknown[]) {
    const result = apply(original, this, args);
    after(this, args, result);
    return result;
  };
  Object.defineProperties(wrapped, {
    name: { value: original.name },
    length: { value: original.length },
  });
  Object.defineProperty(prototype, name, Object.assign({}, descriptor, { value: wrapped }));
  return wrapped;
}
function controllerMethods(Ctor: { prototype: object }, names: readonly string[]) {
  for (const name of names)
    method(Ctor.prototype, name, (controller) => {
      const group = controllers.get(controller);
      if (group) notify(group);
    });
}
function handleMethods(Ctor: { prototype: object }, readable: boolean) {
  method(Ctor.prototype, "releaseLock", (handle) => {
    const observer = handles.get(handle);
    if (!observer?.observed) return;
    observer.ignore = closed(handle, readable) === observer.promise;
    const value = observer.value;
    if (value.handle?.deref() === handle) value.handle = null;
    request(value);
  });
}
function nativePipeTo(stream: object, destination: unknown, options: unknown, original: Function) {
  if (options === null || typeof options !== "object")
    return apply(original, stream, [destination, options]);
  const signal = Reflect.get(options, "signal");
  if (signal === undefined || signal instanceof NativeAbortSignal)
    return apply(original, stream, [destination, options]);
  if (
    typeof signal !== "object" ||
    signal === null ||
    typeof Reflect.get(signal, "addEventListener") !== "function"
  )
    return apply(original, stream, [destination, options]);
  const controller = new NativeAbortController();
  const removeEventListener = Reflect.get(signal, "removeEventListener");
  const abort = () => controller.abort(Reflect.get(signal, "reason"));
  let attached = false;
  const cleanup = () => {
    if (!attached || typeof removeEventListener !== "function") return;
    Reflect.apply(removeEventListener, signal, ["abort", abort, { once: true }]);
    attached = false;
  };
  if (Reflect.get(signal, "aborted")) abort();
  else {
    Reflect.apply(Reflect.get(signal, "addEventListener"), signal, [
      "abort",
      abort,
      { once: true },
    ]);
    attached = true;
  }
  let result;
  try {
    result = apply(original, stream, [
      destination,
      Object.assign({}, options, { signal: controller.signal }),
    ]);
  } catch (error) {
    cleanup();
    throw error;
  }
  if (result && typeof result.then === "function")
    Reflect.apply(result.then, result, [cleanup, cleanup]);
  return result;
}

function streamMethods(Ctor: typeof ReadableStream | typeof WritableStream, readable: boolean) {
  const prototype = Ctor.prototype;
  Object.defineProperty(prototype, closedKey, {
    configurable: true,
    get() {
      return watch(record(this, readable));
    },
  });
  Object.defineProperty(prototype, errorKey, {
    configurable: true,
    get() {
      const value = record(this, readable);
      return (reason: unknown) => {
        const group = value.group;
        if (!group)
          throw new Error(
            "Cannot error an opaque stream created outside the runtime's native construction bridge",
          );
        if (group.error) group.error(reason);
        else group.pending.push(reason);
      };
    },
  });
  method(prototype, readable ? "getReader" : "getWriter", (stream, args, handle) => {
    if (typeof handle !== "object" || handle === null)
      throw new TypeError("Native stream handle missing");
    const value = record(stream, readable);
    value.handle = new WeakRef(handle);
    handles.set(handle, { value, observed: false });
    if (active(value)) observeHandle(value, handle);
  });
  if (readable) {
    const values = Reflect.get(prototype, "values");
    const alias = Object.getOwnPropertyDescriptor(prototype, Symbol.asyncIterator);
    const wrapped = method(prototype, "values", (stream) => request(record(stream, true)));
    if (alias?.value === values)
      Object.defineProperty(
        prototype,
        Symbol.asyncIterator,
        Object.assign({}, alias, { value: wrapped }),
      );
    else method(prototype, Symbol.asyncIterator, (stream) => request(record(stream, true)));
  }
  for (const name of readable ? ["cancel", "pipeThrough"] : ["abort", "close"])
    method(prototype, name, (stream) => request(record(stream, readable)));
  if (readable) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "pipeTo");
    if (descriptor?.value) {
      const original = descriptor.value;
      const wrapped = function (this: object, destination: unknown, options?: unknown) {
        const result = nativePipeTo(this, destination, options, original);
        request(record(this, true));
        return result;
      };
      Object.defineProperties(wrapped, {
        name: { value: original.name },
        length: { value: original.length },
      });
      Object.defineProperty(prototype, "pipeTo", Object.assign({}, descriptor, { value: wrapped }));
    }
  }
}

export function installNativeStreamState() {
  if (!constructors) {
    if (closedKey in Native.ReadableStream.prototype) return () => {};
    // Native hosts may assign own hooks during construction. Publish writable
    // capability slots for the guest's prototype check, never getter-only hooks
    // that would prevent those assignments. Each instance keeps its native state.
    if (
      closedKey in
      new Native.ReadableStream({
        start(controller) {
          controller.close();
        },
      })
    ) {
      for (const Ctor of [Native.ReadableStream, Native.WritableStream]) {
        for (const key of [closedKey, errorKey]) {
          if (!(key in Ctor.prototype))
            Object.defineProperty(Ctor.prototype, key, {
              configurable: true,
              writable: true,
              value: undefined,
            });
        }
      }
      return () => {};
    }
  }
  if (!constructors) {
    streamMethods(Native.ReadableStream, true);
    streamMethods(Native.WritableStream, false);
    handleMethods(Native.ReadableStreamDefaultReader, true);
    handleMethods(Native.ReadableStreamBYOBReader, true);
    handleMethods(Native.WritableStreamDefaultWriter, false);
    controllerMethods(Native.ReadableStreamDefaultController, ["close", "error", "enqueue"]);
    controllerMethods(Native.ReadableByteStreamController, ["close", "error", "enqueue"]);
    controllerMethods(Native.WritableStreamDefaultController, ["error"]);
    controllerMethods(Native.TransformStreamDefaultController, ["error", "terminate", "enqueue"]);
    const readable = construct(Native.ReadableStream, "readable", ["start", "pull", "cancel"]);
    const writable = construct(Native.WritableStream, "writable", [
      "start",
      "write",
      "close",
      "abort",
    ]);
    const transform = construct(Native.TransformStream, "transform", [
      "start",
      "transform",
      "flush",
      "cancel",
    ]);
    linkConstructor(Native.ReadableStream, readable);
    linkConstructor(Native.WritableStream, writable);
    linkConstructor(Native.TransformStream, transform);
    constructors = {
      ReadableStream: readable,
      WritableStream: writable,
      TransformStream: transform,
    };
  }
  session = { alive: true, values: new Set(), timers: new Set() };
  const own = session;
  Object.assign(globalThis, constructors);
  return () => {
    own.alive = false;
    for (const id of own.timers) clear(id);
    own.timers.clear();
    for (const weak of own.values) pending.delete(weak);
    if (!pending.size && timer !== undefined) {
      clear(timer);
      timer = undefined;
    }
  };
}
