import { test, expect, type Page } from "@playwright/test";

async function open(page: Page) {
  await page.goto("/?test=1&renderer=canvas");
  await ready(page);
  await page.locator("textarea").focus();
}
async function ready(page: Page) {
  await expect.poll(() => page.evaluate(() => window.brushWeb?.snapshot().state)).toBe("ready");
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
function script(path: string, source: string) {
  return `printf '%s' '${source.replaceAll("'", "'\\''")}' > ${path}`;
}

test("external bun streams before exit", async ({ page }) => {
  await open(page);
  await command(
    page,
    script(
      "x.ts",
      'console.log("STREAM_FIRST"); await Bun.sleep(2000); console.log("STREAM_LAST");',
    ),
  );
  await ready(page);
  await command(page, "bun run x.ts");
  await output(page, "STREAM_FIRST");
  expect(await page.evaluate(() => window.brushWeb?.snapshot().state)).toBe("running");
  expect(
    await page.evaluate(() => window.brushWeb?.readLines().map((line) => line.trim())),
  ).not.toContain("STREAM_LAST");
  await output(page, "STREAM_LAST");
  await ready(page);
});

test("external bun executes through normal command lookup", async ({ page }) => {
  await open(page);
  await command(page, `bun -e 'console.log("EXTERNAL_OK")'`);
  await output(page, "EXTERNAL_OK");
  await ready(page);
});

test("external pipes preserve binary bytes, EOF, and backpressure in both directions", async ({
  page,
}) => {
  await open(page);
  await command(
    page,
    script(
      "read.ts",
      'const data = new Uint8Array(await Bun.stdin.arrayBuffer()); console.log("BYTES:" + Array.from(data));',
    ),
  );
  await ready(page);
  await command(page, `printf 'hi\\000\\377\\r\\n' | bun run read.ts`);
  await output(page, "BYTES:104,105,0,255,13,10");
  await ready(page);
  await command(
    page,
    `bun -e 'process.stdout.write(new Uint8Array([0,255,13,10,97]))' | cat > binary; bun -e 'console.log("OUTPUT:" + Array.from(require("node:fs").readFileSync("binary")))'`,
  );
  await output(page, "OUTPUT:0,255,13,10,97");
  await ready(page);
  await command(page, `bun -e 'process.stdout.write("foo\\nbar\\nfoo two\\n")' | grep foo`);
  await output(page, "foo");
  await output(page, "foo two");
  await ready(page);
  await command(
    page,
    `bun -e 'process.stdout.write(new Uint8Array(180000).fill(97)); process.stderr.write("ERR_OK\\n")' | bun -e 'const b=new Uint8Array(await Bun.stdin.arrayBuffer()); console.log("LARGE:" + b.length + ":" + b.every(x=>x===97))'`,
  );
  await output(page, "ERR_OK");
  await output(page, "LARGE:180000:true");
  await ready(page);
});

test("external status controls lists, pipelines and explicit command", async ({ page }) => {
  await open(page);
  await command(page, script("fail.ts", "process.exit(7);"));
  await ready(page);
  await command(
    page,
    `bun run fail.ts; echo STATUS:$?; bun run fail.ts && echo BAD_AND; bun run fail.ts || echo OR_OK; command /bin/bun -e 'console.log("COMMAND_OK")'`,
  );
  await output(page, "STATUS:7");
  await output(page, "OR_OK");
  await output(page, "COMMAND_OK");
  expect(
    await page.evaluate(() => window.brushWeb?.readLines().map((line) => line.trim())),
  ).not.toContain("BAD_AND");
  await ready(page);
  await command(page, `set -o pipefail; echo hi | bun run fail.ts; echo PIPE_STATUS:$?`);
  await output(page, "PIPE_STATUS:7");
});

test("Ctrl+C kills a busy external worker with status 130 and preserves the shell", async ({
  page,
}) => {
  await open(page);
  await command(
    page,
    script("long.ts", 'console.log("CHILD_STARTED"); Bun.sleepSync(1); while (true) {}'),
  );
  await ready(page);
  await command(page, "export KEEP=retained; bun run long.ts; echo BAD_AFTER_INTERRUPT");
  await expect.poll(() => page.workers().length).toBe(2);
  await expect.poll(() => page.evaluate(() => window.brushWeb?.snapshot().state)).toBe("running");
  await page.keyboard.press("Control+c");
  await ready(page);
  await command(page, `echo INTERRUPT:$?:$KEEP; bun -e 'console.log("NEXT_CHILD_OK")'`);
  await output(page, "INTERRUPT:130:retained");
  await output(page, "NEXT_CHILD_OK");
  expect(
    await page.evaluate(() => window.brushWeb?.readLines().map((line) => line.trim())),
  ).not.toContain("BAD_AFTER_INTERRUPT");
  await ready(page);
});

test("child files merge after nonzero exit, with cwd and exported environment", async ({
  page,
}) => {
  await open(page);
  await command(
    page,
    "mkdir demo; cd demo; export TEST_VALUE=from-shell; printf source > input; printf remove > deleted",
  );
  await ready(page);
  await command(
    page,
    `bun -e 'const fs=require("node:fs"); console.log("CONTEXT:"+process.cwd()+":"+process.env.TEST_VALUE); fs.writeFileSync("output", fs.readFileSync("input")); fs.unlinkSync("deleted"); fs.mkdirSync("nested"); fs.writeFileSync("nested/new", "created"); process.exit(9)' > captured; echo FILE_STATUS:$?; cat captured; cat output; echo; cat nested/new; echo; test ! -e deleted && echo DELETE_OK`,
  );
  await output(page, "FILE_STATUS:9");
  await output(page, "CONTEXT:/home/guest/demo:from-shell");
  await output(page, "source");
  await output(page, "created");
  await output(page, "DELETE_OK");
  await ready(page);
  await command(
    page,
    `printf appended >> output; bun -e 'console.log("MERGED:"+require("node:fs").readFileSync("output","utf8"))'`,
  );
  await output(page, "MERGED:sourceappended");
});

test("external terminal stdin receives a canonical line and EOF", async ({ page }) => {
  await open(page);
  await command(
    page,
    `bun -e 'console.log("INPUT_READY"); Bun.sleepSync(1); console.log("INPUT:"+(await Bun.stdin.text()).trim())'`,
  );
  await expect.poll(() => page.workers().length).toBe(2);
  await command(page, "typed line");
  await page.keyboard.press("Control+d");
  await output(page, "INPUT:typed line");
  await ready(page);
});

test("unregistered files fail with 126 and leave the command host usable", async ({ page }) => {
  await open(page);
  await command(
    page,
    `printf invalid > fake; ./fake; echo UNREGISTERED:$?; bun -e 'console.log("AFTER_ERROR_OK")'`,
  );
  await output(page, "UNREGISTERED:126");
  await output(page, "AFTER_ERROR_OK");
  await ready(page);
  await expect.poll(() => page.workers().length).toBe(1);
});

test("session restart terminates a running child worker", async ({ page }) => {
  await open(page);
  await command(page, `bun -e 'console.log("RESTART_CHILD"); Bun.sleepSync(1); while(true){}'`);
  await expect.poll(() => page.workers().length).toBe(2);
  expect(page.workers().length).toBe(2);
  await page.evaluate(() => window.brushWeb?.restart());
  await ready(page);
  await expect.poll(() => page.workers().length).toBe(1);
  await page.locator("textarea").focus();
  await command(page, `bun -e 'console.log("RESTART_OK")'`);
  await output(page, "RESTART_OK");
  await ready(page);
  await expect.poll(() => page.workers().length).toBe(1);
});

test("redirected stdout and stderr retain the child's write order", async ({ page }) => {
  await open(page);
  await command(
    page,
    `bun -e 'process.stdout.write("a"); process.stderr.write("b"); process.stdout.write("c")' > ordered 2>&1; bun -e 'console.log("ORDER:"+require("node:fs").readFileSync("ordered","utf8"))'`,
  );
  await output(page, "ORDER:abc");
  await ready(page);
});

test("child stdio reports pipes rather than terminal devices", async ({ page }) => {
  await open(page);
  await command(
    page,
    `bun -e 'console.log("TTY:"+Boolean(process.stdin.isTTY)+":"+Boolean(process.stdout.isTTY)+":"+Boolean(process.stderr.isTTY))' | cat`,
  );
  await output(page, "TTY:false:false:false");
  await ready(page);
});
