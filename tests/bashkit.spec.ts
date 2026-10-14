import { test, expect, type Page } from "@playwright/test";
async function open(page: Page) {
  await page.goto("/?test=1&renderer=canvas&engine=bashkit&profile=phase&trace=1");
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

test("published Bashkit runs in the worker and retains state and Unix tools", async ({ page }) => {
  await open(page);
  await expect(page.locator(".baseline-note")).toContainText("Experimental");
  await command(
    page,
    "export KEEP=kept; greet(){ echo hello; }; alias wave='echo alias'; mkdir data; cd data; values=(one two); false",
  );
  await command(
    page,
    'printf "STATE:%s:%s:%s:%s\\n" "$?" "$KEEP" "$PWD" "${values[1]}"; greet; wave',
  );
  await output(page, "STATE:0:kept:/home/user/data:two");
  await output(page, "hello");
  await output(page, "alias");
  await command(
    page,
    `printf 'pear\\napple\\npear\\n' > words; grep pear words | sort | uniq -c; awk 'END {print "AWK:" NR}' words; sed 's/pear/PEAR/' words; jq -n '{ok:true}'`,
  );
  await output(page, "AWK:3");
  await output(page, "PEAR");
  await expect
    .poll(() => page.evaluate(() => window.brushWeb?.readLines().join("\n")))
    .toContain('"ok": true');
  await command(
    page,
    "seq 10000 > numbers; cat numbers | cat > copy; mapfile -t rows < copy; echo FILE:${#rows[@]}:${rows[0]}:${rows[9999]}",
  );
  await output(page, "FILE:10000:1:10000");
  expect(await page.evaluate(() => window.brushWeb?.metrics()?.wasmBytes)).toBeGreaterThan(1000000);
});

test("Bashkit adapter editing supports keyboard, safe paste and Unicode", async ({ page }) => {
  await open(page);
  await page.keyboard.insertText("echo eding");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.insertText("it");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await output(page, "editing");
  await page.keyboard.insertText("gre");
  await page.keyboard.press("Tab");
  await page.keyboard.insertText("completion-ok <<< completion-ok");
  await page.keyboard.press("Enter");
  await output(page, "completion-ok");
  await command(page, 'echo "界😀é"');
  await output(page, "界😀é");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => window.brushWeb?.snapshot().state)).toBe("ready");
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData("text/plain", "export PASTED=yes\necho PASTE_DONE");
    document
      .querySelector("textarea")
      ?.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
  });
  await page.waitForTimeout(100);
  expect(
    await page.evaluate(() =>
      window.brushWeb?.readLines().some((line) => line.trim() === "PASTE_DONE"),
    ),
  ).toBe(false);
  await page.keyboard.press("Enter");
  await output(page, "PASTE_DONE");
});

test("stock Bashkit CPU work completes before queued Ctrl+C can run", async ({ page }) => {
  await open(page);
  await command(page, "COUNT=0; while ((COUNT<200000)); do ((COUNT++)); done");
  await expect.poll(() => page.evaluate(() => window.brushWeb?.snapshot().state)).toBe("running");
  await page.keyboard.press("Control+c");
  await expect.poll(() => page.evaluate(() => window.brushWeb?.snapshot().state)).toBe("ready");
  await command(page, "echo COUNT:$COUNT");
  await output(page, "COUNT:200000");
});
