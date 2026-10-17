import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";

// Upstream acceptance copied from /work/reports/browser-shell-research.
// Runtime owns a persistent filesystem worker as well as the guest shell.
const baselineWorkers = new WeakMap<Page, number>();

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => console.error("RUNTIME_PAGE_ERROR", error.message));
  page.on("console", (message) => {
    if (message.type() === "error") console.error("RUNTIME_CONSOLE", message.text());
  });
});
test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus) {
    if ((await page.evaluate(() => window.brushWeb?.snapshot().state)) === "ready") {
      await page.locator("textarea").focus();
      await page.keyboard.insertText(`printf '\\r\\nRUNTIME_STATUS:%s\\r\\n' "$?"`);
      await page.keyboard.press("Enter");
      await page
        .waitForFunction(
          () => window.brushWeb?.readLines().some((line) => /RUNTIME_STATUS:\d+/.test(line)),
          undefined,
          { timeout: 2000 },
        )
        .catch(() => {});
    }
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
  baselineWorkers.set(page, page.workers().length);
  await page.locator("textarea").focus();
}
async function command(page: Page, text: string) {
  await page.keyboard.insertText(text);
  await page.keyboard.press("Enter");
}
async function output(page: Page, text: string) {
  await expect
    .poll(() => page.evaluate(() => window.brushWeb?.readLines().map((line) => line.trim())))
    .toContain(text);
}
async function file(page: Page, path: string, source: string) {
  await command(page, `printf '%s' '${source.replaceAll("'", "'\\''")}' > ${path}`);
  await ready(page);
}

test("pipeline forwards ticker lines while the producer is running", async ({ page }, info) => {
  await open(page);
  await file(
    page,
    "ticker.ts",
    'for(let i=0;i<3;i++){console.log("tick "+i); await Bun.sleep(500)} await Bun.sleep(30000)',
  );
  await command(page, "bun run ticker.ts | grep tick");
  await output(page, "tick 0");
  expect(await page.evaluate(() => window.brushWeb?.snapshot().state)).toBe("running");
  await output(page, "tick 1");
  await output(page, "tick 2");
  await page.screenshot({ path: info.outputPath("live-pipeline.png") });
  await page.keyboard.press("Control+c");
  await ready(page);
  await expect.poll(() => page.workers().length).toBe(baselineWorkers.get(page));
  await command(page, "echo INTERRUPT:$?");
  await output(page, "INTERRUPT:130");
});

for (const [name, producer, consumer, expected] of [
  [
    "builtin to bun",
    "seq 1 400000",
    `bun -e 'const b=await Bun.stdin.text(); console.log("COUNT:"+b.length+":"+b.split("\\n").length)'`,
    "COUNT:2688895:400001",
  ],
  [
    "bun to builtin",
    `bun -e 'process.stdout.write("x".repeat(2097169))'`,
    'cat > complete; bun -e \'console.log("COUNT:"+require("node:fs").readFileSync("complete").length)\'',
    "COUNT:2097169",
  ],
  [
    "bun to bun",
    `bun -e 'for(let i=0;i<513;i++)process.stdout.write(new Uint8Array(8192).fill(i%251))'`,
    `bun -e 'const b=new Uint8Array(await Bun.stdin.arrayBuffer()); console.log("COUNT:"+b.length+":"+b.every((v,i)=>v===Math.floor(i/8192)%251))'`,
    "COUNT:4202496:true",
  ],
  [
    "builtin to builtin",
    "seq 1 400000",
    'cat > complete; bun -e \'const b=require("node:fs").readFileSync("complete","utf8"); console.log("COUNT:"+b.length+":"+b.split("\\n").length)\'',
    "COUNT:2688895:400001",
  ],
]) {
  test(`pipeline streams complete output above 1 MiB, ${name}`, async ({ page }) => {
    await open(page);
    await command(page, `${producer} | ${consumer}`);
    await output(page, expected);
    await ready(page);
    await expect.poll(() => page.workers().length).toBe(baselineWorkers.get(page));
  });
}

test("pipeline Ctrl+C stops every stage and its children", async ({ page }) => {
  await open(page);
  await file(
    page,
    "endless.ts",
    'console.error("PRODUCER_READY"); while(true)process.stdout.write("tick\\n")',
  );
  await file(
    page,
    "read.ts",
    'const fs=require("node:fs"), b=new Uint8Array(8192); console.error("CONSUMER_READY"); let n; while((n=fs.readSync(0,b,0,b.length,null))>0)process.stdout.write(b.subarray(0,n))',
  );
  await command(
    page,
    "export KEEP=kept; bun run endless.ts | bun run read.ts | grep unmatched; echo BAD_AFTER_INTERRUPT",
  );
  await output(page, "PRODUCER_READY");
  await output(page, "CONSUMER_READY");
  await expect
    .poll(() => page.workers().length)
    .toBeGreaterThanOrEqual(baselineWorkers.get(page)! + 2);
  await page.keyboard.press("Control+c");
  await ready(page);
  await expect.poll(() => page.workers().length).toBe(baselineWorkers.get(page));
  await command(page, "echo STATUS:$?:$KEEP");
  await output(page, "STATUS:130:kept");
});

const statusCases = [
  "false | true",
  "true | false",
  "false | false | true",
  "set -o pipefail; false | true",
  "set -o pipefail; true | false | true",
  "set -o pipefail; (exit 7) | (exit 3) | true",
  "! false | true",
];
for (const pipeline of statusCases) {
  test(`pipeline status matches bash, ${pipeline}`, async ({ page }) => {
    const text = `${pipeline}; printf 'STATUS:%s:%s\\n' "$?" "\${PIPESTATUS[*]}"`;
    const expected = execFileSync("bash", ["--noprofile", "--norc", "-c", text], {
      encoding: "utf8",
    }).trim();
    await open(page);
    await command(page, text);
    await output(page, expected);
    await ready(page);
  });
}

test("early downstream exit finishes a yielding Bun producer with EPIPE status", async ({
  page,
}) => {
  await open(page);
  // Native Bun 1.4.2 and Node 26.7.0 ignore SIGPIPE: a tight write loop
  // never yields to its deferred EPIPE handler. A real ticker yields, then exits
  // 1 for unhandled EPIPE (not 141); the native fake producer covers SIGPIPE.
  await file(page, "endless.ts", 'setInterval(()=>process.stdout.write("first\\n"),1)');
  await command(
    page,
    `set -o pipefail; bun run endless.ts | { IFS= read -r line; echo "$line"; }; printf 'STATUS:%s:%s\\n' "$?" "\${PIPESTATUS[*]}"`,
  );
  await output(page, "first");
  await output(page, "STATUS:1:1 0");
  await ready(page);
  await expect.poll(() => page.workers().length).toBe(baselineWorkers.get(page));
});

test("pipeline stages inherit functions, unexported variables, cwd and redirections", async ({
  page,
}) => {
  await open(page);
  await command(
    page,
    "mkdir nested; cd nested; secret=retained; f() { printf '%s\\n' \"$secret:$PWD:$1\"; }; f value | cat > result; cat result",
  );
  await output(page, "retained:/home/guest/nested:value");
  await ready(page);
});

test("slow downstream applies bounded backpressure", async ({ page }) => {
  await open(page);
  await file(
    page,
    "producer.ts",
    'const b=new Uint8Array(65536).fill(97); for(let i=0;i<80;i++){process.stdout.write(b); console.error("WRITTEN:"+i)}',
  );
  await file(
    page,
    "slow.ts",
    'console.error("READER_WAITING"); await Bun.sleep(2000); const b=await Bun.stdin.arrayBuffer(); console.log("DRAINED:"+b.byteLength)',
  );
  await command(page, "bun run producer.ts | bun run slow.ts");
  await output(page, "READER_WAITING");
  await page.waitForTimeout(200);
  const lines = await page.evaluate(() => window.brushWeb?.readLines().map((line) => line.trim()));
  expect(lines).not.toContain("WRITTEN:79");
  expect(await page.evaluate(() => window.brushWeb?.snapshot().state)).toBe("running");
  await output(page, "DRAINED:5242880");
  await ready(page);
  await expect.poll(() => page.workers().length).toBe(baselineWorkers.get(page));
});
