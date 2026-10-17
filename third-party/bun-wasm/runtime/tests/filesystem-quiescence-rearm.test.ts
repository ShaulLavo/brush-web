import { expect, test } from "bun:test";
import { FilesystemClient, FilesystemService, MemoryBackend, createFilesystemConnection, revokeFilesystem } from "../fs";

for (const entrants of [1, 3]) test(`session cleanup rearms after ${entrants} rejected entrants race quiescence callbacks`, async () => {
  const backend = new MemoryBackend();
  const service = new FilesystemService(backend);
  const connection = createFilesystemConnection();
  service.connect(connection.server);
  const client = new FilesystemClient(connection.client);
  const sections = new Int32Array(connection.client.sections);
  const sweep = service.sweep.bind(service);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await client.asyncCall("writeFile", ["/held"], new TextEncoder().encode("held pages"));
    const root = await client.asyncCall("preopen", ["/"]);
    const path = await client.asyncCall("resolve", [root, "held"]);
    await client.asyncCall("retain", [path.node]);
    await client.asyncCall("remove", ["/held"]);
    expect(service.resources().usedBytes).toBeGreaterThan(0);
    let finished!: () => void;
    const closed = new Promise<void>(resolve => { finished = resolve; });
    let sweeps = 0, remaining = entrants;
    service.sweep = () => {
      sweeps++;
      if (sweeps > 1 && remaining > 0) {
        remaining--;
        // A later enter() increments before checking revocation. The first waiter has
        // already proved zero, but close() now sees this transient admission count.
        Atomics.add(sections, 0, 1);
        queueMicrotask(() => {
          Atomics.sub(sections, 0, 1);
          Atomics.notify(sections, 0);
        });
      }
      sweep();
      if (!service.resources().clients) finished();
    };
    Atomics.store(sections, 0, 1);
    revokeFilesystem(connection.client);
    service.sweep();
    expect(service.resources().clients).toBe(1);
    Atomics.store(sections, 0, 0);
    Atomics.notify(sections, 0);
    await Promise.race([closed, new Promise<void>(resolve => { timer = setTimeout(resolve, 500); })]);
    expect(Atomics.load(sections, 0)).toBe(0);
    expect(remaining).toBe(0);
    expect(service.resources()).toMatchObject({ clients: 0, retained: 0, capabilityBytes: 0, usedBytes: 0 });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    service.sweep = sweep;
    Atomics.store(sections, 0, 0);
    Atomics.notify(sections, 0);
    client.dispose();
    service.dispose();
  }
});
