import { test, expect, type Page } from "@playwright/test";

test.setTimeout(60000);
test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => console.error("RUNTIME_PAGE_ERROR", error.message));
  page.on("console", (message) => {
    if (message.type() === "error") console.error("RUNTIME_CONSOLE", message.text());
  });
});
test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus) {
    console.error(
      "RUNTIME_FAILURE",
      JSON.stringify(
        await page.evaluate(() => ({
          lines: window.brushWeb?.readLines(),
          snapshot: window.brushWeb?.snapshot(),
          runtime: window.brushWeb?.runtimeSnapshot(),
        })),
      ),
    );
  }
});
async function ready(page: Page) {
  await expect.poll(() => page.evaluate(() => window.brushWeb?.snapshot().state)).toBe("ready");
}
async function open(page: Page) {
  await page.goto("/?test=1&renderer=canvas&engine=own-shell");
  await ready(page);
  expect(await page.evaluate(() => window.brushWeb?.snapshot().engine)).toBe("own-shell");
  await page.locator("textarea").focus();
  return page.workers().length;
}
async function command(page: Page, source: string) {
  await page.keyboard.insertText(source);
  await page.keyboard.press("Enter");
}
async function output(page: Page, expected: string) {
  await expect
    .poll(() => page.evaluate(() => window.brushWeb?.readLines().map((line) => line.trim())))
    .toContain(expected);
}
async function file(page: Page, path: string, source: string) {
  await command(page, `printf '%s' '${source.replaceAll("'", "'\\''")}' > ${path}`);
  await ready(page);
}

test("Brush remains the default engine", async ({ page }) => {
  await page.goto("/?test=1&renderer=canvas");
  await ready(page);
  expect(await page.evaluate(() => window.brushWeb?.snapshot().engine)).toBe("brush");
});

test("an always-ready background shell loop cannot starve a foreground command", async ({
  page,
}) => {
  const baseline = await open(page);
  await command(page, "while :; do :; done & echo FOREGROUND_FAIR");
  await output(page, "FOREGROUND_FAIR");
  await ready(page);
  await command(page, "kill %1; wait; echo BACKGROUND_REAPED");
  await output(page, "BACKGROUND_REAPED");
  await ready(page);
  await expect.poll(() => page.workers().length).toBe(baseline);
});

test("Ctrl+C interrupts executing shell WASM without killing an independent background Bun", async ({
  page,
}) => {
  const baseline = await open(page);
  await command(
    page,
    'bun -e \'console.log("BACKGROUND_ALIVE"); setInterval(()=>console.log("BACKGROUND_TICK"),250)\' &',
  );
  await output(page, "BACKGROUND_ALIVE");
  await ready(page);
  await command(page, "while :; do :; done");
  await expect.poll(() => page.evaluate(() => window.brushWeb?.snapshot().state)).toBe("running");
  await page.keyboard.press("Control+c");
  await ready(page);
  await command(page, "echo CPU_STATUS:$?");
  await output(page, "CPU_STATUS:130");
  // Background child remains live until the job is explicitly killed from the next command.
  expect(page.workers().length).toBeGreaterThan(baseline);
  await command(page, "kill %1; wait; echo CPU_BACKGROUND_REAPED");
  await output(page, "CPU_BACKGROUND_REAPED");
  await ready(page);
  await expect.poll(() => page.workers().length).toBe(baseline);
});

test("nonstandard inherited descriptors share file offsets and redirected stdout", async ({
  page,
}) => {
  await open(page);
  await file(page, "descriptor-data", "shared-offset");
  await command(
    page,
    `exec 4< descriptor-data; bun -e 'const f=require("node:fs");const b=Buffer.alloc(6);f.readSync(4,b,0,6,null);f.writeSync(3,"FD3:"+b.toString()+"\\n")' 3>&1; bun -e 'console.log("FD4:"+require("node:fs").readFileSync(4,"utf8"))'`,
  );
  await output(page, "FD3:shared");
  await output(page, "FD4:-offset");
  await ready(page);
});

test("an inherited fd 3 does not replace the filesystem root preopen", async ({ page }) => {
  await open(page);
  await file(page, "preopen-data", "ROOT_PREOPEN_OK");
  await command(page, `bun -e 'console.log(await Bun.file("preopen-data").text())' 3>&1`);
  await output(page, "ROOT_PREOPEN_OK");
  await ready(page);
});

test("the registered shell program can run as a child without owning the root terminal", async ({
  page,
}) => {
  const baseline = await open(page);
  await command(page, `/programs/shell-engine.wasm -c 'echo CHILD_SHELL_OK'`);
  await output(page, "CHILD_SHELL_OK");
  await ready(page);
  await expect.poll(() => page.workers().length).toBe(baseline);
});

test("nested Bun stdin inheritance retains the generic parent's pipe", async ({ page }) => {
  const baseline = await open(page);
  await file(page, "stdin-reader.ts", 'console.log("NESTED_STDIN:"+await Bun.stdin.text())');
  await file(
    page,
    "stdin-parent.ts",
    'const child=Bun.spawn(["bun","run","stdin-reader.ts"],{stdin:"inherit",stdout:"inherit",stderr:"inherit"});await child.exited',
  );
  await command(page, "printf payload | bun run stdin-parent.ts");
  await output(page, "NESTED_STDIN:payload");
  await ready(page);
  await expect.poll(() => page.workers().length).toBe(baseline);
});

test("a guest that handles EPIPE keeps its own exit status", async ({ page }) => {
  const baseline = await open(page);
  await file(
    page,
    "epipe.ts",
    'const fs=require("node:fs");try{for(;;)fs.writeSync(1,"first\\n")}catch(e){if(e.code==="EPIPE")process.exit(23);throw e}',
  );
  await command(
    page,
    `set -o pipefail; bun run epipe.ts | { IFS= read -r line; echo "$line"; }; printf 'HANDLED:%s:%s\\n' "$?" "\${PIPESTATUS[*]}"`,
  );
  await output(page, "first");
  await output(page, "HANDLED:23:23 0");
  await ready(page);
  await expect.poll(() => page.workers().length).toBe(baseline);
});

test("a background Bun server streams while the next command can kill and wait for its job", async ({
  page,
}) => {
  const baseline = await open(page);
  await file(
    page,
    "dev.ts",
    'console.log("DEV_READY");setInterval(()=>console.log("DEV_STREAM"),250)',
  );
  await command(page, "bun run dev.ts &");
  await output(page, "DEV_READY");
  await ready(page);
  await output(page, "DEV_STREAM");
  await command(page, "echo NEXT_COMMAND");
  await output(page, "NEXT_COMMAND");
  await ready(page);
  await command(page, "kill %1; wait; echo DEV_REAPED");
  await output(page, "DEV_REAPED");
  await ready(page);
  await expect.poll(() => page.workers().length).toBe(baseline);
});

test("Ctrl+C confirms foreground descendants while preserving another background job", async ({
  page,
}) => {
  test.fixme(
    true,
    "Known runtime failure: step 7b must move Bun.spawn descendants into the shared process directory before whole-job interruption can reach them.",
  );
  const baseline = await open(page);
  await file(page, "descendant.ts", 'console.log("DESCENDANT_READY");for(;;)await Bun.sleep(100)');
  await file(
    page,
    "parent.ts",
    'const child=Bun.spawn(["bun","run","descendant.ts"],{stdin:"ignore",stdout:"inherit",stderr:"inherit"});console.log("PARENT_READY");await child.exited',
  );
  await command(page, "bun -e 'console.log(\"INDEPENDENT_READY\");for(;;)await Bun.sleep(100)' &");
  await output(page, "INDEPENDENT_READY");
  await ready(page);
  await command(page, "bun run parent.ts");
  await output(page, "PARENT_READY");
  await output(page, "DESCENDANT_READY");
  await expect.poll(() => page.workers().length).toBe(baseline + 3);
  await page.keyboard.press("Control+c");
  await ready(page);
  // The prompt is forbidden until all foreground descendants have exited.
  expect(page.workers().length).toBe(baseline + 1);
  await command(page, "echo DESCENDANT_STATUS:$?; kill %1; wait; echo DESCENDANTS_REAPED");
  await output(page, "DESCENDANT_STATUS:130");
  await output(page, "DESCENDANTS_REAPED");
  await ready(page);
  await expect.poll(() => page.workers().length).toBe(baseline);
});

// These bounds cover the shell, descriptor transport and supervisor. The child
// program's deliberate read-all allocation is not a shell buffering budget.
test("an accumulating consumer cannot make the shell or transport buffer its input", async ({
  page,
}) => {
  const baselineWorkers = await open(page);
  const before = await page.evaluate(() => window.brushWeb!.runtimeSnapshot()!);
  const baseMemory = before.roots[0].memoryBytes;
  let peakShell = baseMemory;
  let peakPipes = 0;
  let peakSlots = before.roots[0].retainedSlots;
  await command(
    page,
    `seq 1 2000000 | bun -e 'await Bun.sleep(500);const b=await Bun.stdin.arrayBuffer();console.log("ACCUMULATED:"+b.byteLength)'`,
  );
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const sample = await page.evaluate(() => ({
      runtime: window.brushWeb!.runtimeSnapshot()!,
      done: window.brushWeb!.readLines().some((line) => line.trim() === "ACCUMULATED:14888896"),
    }));
    const root = sample.runtime.roots[0];
    peakShell = Math.max(peakShell, root.memoryBytes);
    peakPipes = Math.max(peakPipes, root.pipes);
    peakSlots = Math.max(peakSlots, root.retainedSlots);
    expect(sample.runtime.terminal.outputQueued).toBeLessThanOrEqual(
      sample.runtime.terminal.outputCapacity,
    );
    if (sample.done) break;
    await page.waitForTimeout(20);
  }
  await output(page, "ACCUMULATED:14888896");
  await ready(page);
  expect(peakShell - baseMemory).toBeLessThanOrEqual(8 * 1024 * 1024);
  expect(peakPipes).toBeLessThanOrEqual(2);
  expect(peakSlots - before.roots[0].retainedSlots).toBeLessThanOrEqual(1);
  await expect.poll(() => page.workers().length).toBe(baselineWorkers);
  await expect
    .poll(() => page.evaluate(() => window.brushWeb!.runtimeSnapshot()!.roots[0].pipes))
    .toBe(0);
});

test("a slow terminal applies backpressure without growing the shell or output queue", async ({
  page,
}) => {
  const baselineWorkers = await open(page);
  const before = await page.evaluate(() => {
    const terminal = window.brushWeb!.terminal!;
    const write = terminal.write.bind(terminal);
    terminal.write = (bytes) => {
      // Slow the actual downstream consumer; workers continue producing off-thread.
      const until = performance.now() + 12;
      while (performance.now() < until) {
        /* synchronous terminal work */
      }
      return write(bytes);
    };
    return window.brushWeb!.runtimeSnapshot()!;
  });
  let peakQueue = 0;
  let peakShell = before.roots[0].memoryBytes;
  await command(
    page,
    `bun -e 'for(let i=0;i<512;i++)process.stdout.write("x".repeat(8191)+"\\n");console.log("SLOW_TERMINAL_DONE")'`,
  );
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const sample = await page.evaluate(() => ({
      runtime: window.brushWeb!.runtimeSnapshot()!,
      done: window.brushWeb!.readLines().some((line) => line.trim() === "SLOW_TERMINAL_DONE"),
    }));
    peakQueue = Math.max(peakQueue, sample.runtime.terminal.outputQueued);
    peakShell = Math.max(peakShell, sample.runtime.roots[0].memoryBytes);
    expect(sample.runtime.terminal.outputQueued).toBeLessThanOrEqual(262144);
    if (sample.done) break;
    await page.waitForTimeout(20);
  }
  await output(page, "SLOW_TERMINAL_DONE");
  await ready(page);
  expect(peakQueue).toBeGreaterThan(0);
  expect(peakShell - before.roots[0].memoryBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
  await expect.poll(() => page.workers().length).toBe(baselineWorkers);
});
