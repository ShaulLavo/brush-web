import { expect, test, type Page } from "@playwright/test";
import { BaselineOutput } from "../src/baseline-output";
import { createBaselineShell } from "../src/baseline-session";
import type { BaselineState } from "../src/baseline-session";

const commands = ["echo", "printf", "alias", "mkdir", "sleep"] satisfies Parameters<
  typeof createBaselineShell
>[0]["commands"];

function shell(state: BaselineState) {
  return createBaselineShell({ state, commands });
}

function signal() {
  return new AbortController().signal;
}

test("public API isolated mode keeps stock shell semantics", async () => {
  const baseline = shell("isolated");
  await baseline.exec("export CARRY=value; mkdir child; cd child; false", signal());
  const result = await baseline.exec('printf "%s:%s:%s\\n" "$CARRY" "$PWD" "$?"', signal());
  expect(result.stdout).toBe(":/home/web:0\n");
  expect(baseline.cwd).toBe("/home/web");
  expect(await baseline.fs.stat("/home/web/child")).toMatchObject({ isDirectory: true });
});

test("public API carry mode transfers scalar cwd and alias data only", async () => {
  const baseline = shell("carry");
  const first = await baseline.exec(
    "mkdir child; cd child; export CARRY=value; values=(one two); greet(){ echo hello; }; alias wave='echo alias'; false",
    signal(),
  );
  expect(first.exitCode).toBe(1);
  const result = await baseline.exec(
    'printf "carry:%s:%s:%s\\n" "$CARRY" "$PWD" "$?"; printf "array:%s\\n" "${values[0]}"; alias wave; type greet',
    signal(),
  );
  expect(result.stdout).toContain("carry:value:/home/web/child:0\n");
  expect(result.stdout).toContain("array:\n");
  expect(result.stdout).toContain("alias wave='echo alias'\n");
  expect(result.stderr).toContain("greet: not found");
  expect(baseline.cwd).toBe("/home/web/child");
});

test("public API aborted execution keeps the previous completed carry projection", async () => {
  const baseline = shell("carry");
  await baseline.exec("export CARRY=kept", signal());
  const cancelled = new AbortController();
  cancelled.abort();
  await baseline.exec("export CARRY=discarded", cancelled.signal);
  const result = await baseline.exec('printf "%s\\n" "$CARRY"', signal());
  expect(result.stdout).toBe("kept\n");
});

test("completed output matches UTF-8 and CRLF bytes across bounded chunk boundaries", () => {
  const fixtures = [
    { stdout: "out\n", stderr: "err\n" },
    { stdout: "out\r", stderr: "\nerr\n" },
    { stdout: "x\ud83d", stderr: "\ude00\n" },
    { stdout: "x".repeat(8191) + "\r\ny\n", stderr: "\n" },
    { stdout: "x".repeat(8191) + "😀\n", stderr: "\x1b[31m世界\x1b[0m\n" },
    { stdout: "\ud800x\udc00", stderr: "\n" },
    { stdout: "©❤👩‍💻👍🏽\n".repeat(20000), stderr: "last\n" },
  ];
  for (const fixture of fixtures) {
    const chunks: Uint8Array[] = [];
    const output = new BaselineOutput((bytes) => {
      expect(bytes.length).toBeLessThanOrEqual(32768);
      chunks.push(bytes.slice());
      return bytes.length;
    });
    output.result(fixture.stdout, fixture.stderr);
    const actual = Buffer.concat(chunks);
    const expected = new TextEncoder().encode(
      (fixture.stdout + fixture.stderr).replace(/\r?\n/g, "\r\n"),
    );
    expect(actual).toEqual(Buffer.from(expected));
  }
});

test("completed output stops after transport rejects a chunk", () => {
  let writes = 0;
  const output = new BaselineOutput(() => {
    writes++;
    return 0;
  });
  output.result("out\n".repeat(30000), "err\n");
  expect(writes).toBe(1);
});

async function open(page: Page, state: BaselineState) {
  await page.goto(`/?test=1&renderer=canvas&engine=just-bash&baselineState=${state}`);
  await expect.poll(() => page.evaluate(() => window.brushWeb?.snapshot().state)).toBe("ready");
  await page.locator("textarea").focus();
}

async function command(page: Page, text: string) {
  await page.keyboard.insertText(text);
  await page.keyboard.press("Enter");
}

async function output(page: Page, expected: string) {
  await expect
    .poll(() => page.evaluate(() => window.brushWeb?.readLines().map((line) => line.trim())))
    .toContain(expected);
}

test("browser carry mode displays its contract and tracks cwd in the prompt", async ({ page }) => {
  await open(page, "carry");
  await expect(page.locator(".baseline-note")).toContainText("carry");
  await command(page, "mkdir carried; cd carried; export CARRY=kept; alias wave='echo alias'");
  await command(page, 'printf "carry:%s:%s\\n" "$CARRY" "$PWD"; alias wave');
  await output(page, "carry:kept:/home/web/carried");
  await output(page, "alias wave='echo alias'");
  await expect
    .poll(() => page.evaluate(() => window.brushWeb?.visibleLines().join("\n")))
    .toContain("just-bash:/home/web/carried$ ");
});

test("browser carry mode recovers previous values after cooperative cancellation", async ({
  page,
}) => {
  await open(page, "carry");
  await command(page, "export KEEP=completed");
  await command(page, "KEEP=inflight; while :; do :; done");
  await expect.poll(() => page.evaluate(() => window.brushWeb?.snapshot().state)).toBe("running");
  await page.keyboard.press("Control+c");
  await command(page, 'printf "recovered:%s\\n" "$KEEP"');
  await output(page, "recovered:completed");
  await expect.poll(() => page.evaluate(() => window.brushWeb?.snapshot().state)).toBe("ready");
});

test("browser carry mode redraws a wrapped command after terminal reflow", async ({ page }) => {
  await open(page, "carry");
  const first = "mkdir carried; cd carried; export CARRY=kept; alias wave='echo alias'";
  await page.keyboard.insertText(first);
  await expect
    .poll(() => page.evaluate(() => window.brushWeb?.visibleLines().join("\n")))
    .toContain("alias wave='echo alias'");
  await page.setViewportSize({ width: 620, height: 700 });
  await expect.poll(() => page.evaluate(() => window.brushWeb?.snapshot().cols)).toBeLessThan(90);
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await command(page, 'printf "reflow:%s:%s\\n" "$CARRY" "$PWD"; alias wave');
  await output(page, "reflow:kept:/home/web/carried");
  await output(page, "alias wave='echo alias'");
});
