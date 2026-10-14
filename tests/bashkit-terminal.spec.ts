import { test, expect, type Page } from "@playwright/test";

async function open(page: Page, presentation = "frame") {
  await page.goto(
    `/?test=1&renderer=canvas&engine=bashkit-terminal&profile=phase&trace=1&presentation=${presentation}`,
  );
  await expect.poll(() => page.evaluate(() => window.brushWeb?.snapshot().state)).toBe("ready");
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

test("native Bashkit keeps state and reads live input through Ghostty", async ({ page }) => {
  await open(page);
  await command(page, "export KEEP=kept; greet(){ echo hello; }; mkdir data; cd data; false");
  await output(page, "$");
  await command(page, 'printf "STATE:%s:%s:%s\\n" "$?" "$KEEP" "$PWD"; greet');
  await output(page, "STATE:1:kept:/home/user/data");
  await output(page, "hello");
  await command(page, 'read -p "Name? " NAME; echo "READ:$NAME"');
  await expect
    .poll(() => page.evaluate(() => window.brushWeb?.visibleLines().join("\n")))
    .toContain("Name? ");
  await command(page, "界😀é");
  await output(page, "READ:界😀é");
  await command(
    page,
    "printf 'pear\\napple\\npear\\n' > words; grep pear words | sort | uniq -c; awk 'END {print \"AWK:\" NR}' words; sed 's/pear/PEAR/' words",
  );
  await output(page, "AWK:3");
  await output(page, "PEAR");
});

test("native editing, history and safe rejection of multiline paste", async ({ page }) => {
  await open(page, "immediate");
  await page.keyboard.insertText("echo eding");
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowLeft");
  await page.keyboard.insertText("it");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await output(page, "editing");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Home");
  await page.keyboard.press("Delete");
  await page.keyboard.insertText("e");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await output(page, "editing");
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData("text/plain", "echo ACCIDENTAL\necho EXECUTION");
    document
      .querySelector("textarea")
      ?.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
  });
  await expect(page.locator(".warning-banner")).toContainText("cannot safely paste");
  expect(await page.evaluate(() => window.brushWeb?.readLines().join("\n"))).not.toContain(
    "ACCIDENTAL",
  );
  expect(
    await page.evaluate(() => window.brushWeb?.metrics()?.inputLatenciesMs.length),
  ).toBeGreaterThan(0);
});

test("native streaming and sleep interruption preserve the session", async ({ page }) => {
  await open(page);
  await command(page, "export KEEP=kept; echo STREAM_BEGIN; sleep 30; echo STREAM_END");
  await output(page, "STREAM_BEGIN");
  await page.keyboard.press("Control+c");
  await expect.poll(() => page.evaluate(() => window.brushWeb?.snapshot().state)).toBe("ready");
  await command(page, 'echo "AFTER:$?:$KEEP"');
  await output(page, "AFTER:130:kept");
  expect(
    await page.evaluate(() => window.brushWeb?.readLines().map((line) => line.trim())),
  ).not.toContain("STREAM_END");
});

test("native vi uses alternate screen, resizes and saves a VFS file", async ({ page }) => {
  await open(page);
  await command(page, "vi /tmp/note");
  await page.keyboard.insertText("ihello from vi");
  await page.setViewportSize({ width: 820, height: 720 });
  await page.keyboard.press("Escape");
  await command(page, ":wq");
  await command(page, "cat /tmp/note");
  await output(page, "hello from vi");
  await command(page, "echo $COLUMNS");
  await output(page, String(await page.evaluate(() => window.brushWeb?.snapshot().cols)));
});

test("native CPU work still delays Ctrl+C delivery", async ({ page }) => {
  await open(page);
  await command(page, "COUNT=0; while ((COUNT<200000)); do ((COUNT++)); done");
  await expect.poll(() => page.evaluate(() => window.brushWeb?.snapshot().state)).toBe("running");
  await page.keyboard.press("Control+c");
  await expect.poll(() => page.evaluate(() => window.brushWeb?.snapshot().state)).toBe("ready");
  await command(page, "echo COUNT:$COUNT");
  await output(page, "COUNT:200000");
  await page.evaluate(() => window.brushWeb?.crash());
  await expect(page.getByRole("alert")).toContainText("Worker stopped");
  await page.getByRole("button", { name: "Restart session" }).click();
  await expect.poll(() => page.evaluate(() => window.brushWeb?.snapshot().state)).toBe("ready");
  await page.locator("textarea").focus();
  await page.keyboard.press("Control+d");
  await expect.poll(() => page.evaluate(() => window.brushWeb?.snapshot().state)).toBe("exited");
});
