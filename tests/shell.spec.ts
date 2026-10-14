import { test, expect, type Page } from "@playwright/test";
async function open(page: Page, engine = "brush") {
  await page.goto(`/?test=1&renderer=canvas&engine=${engine}`);
  await expect.poll(() => page.evaluate(() => window.brushWeb?.snapshot().state)).toBe("ready");
  await page.locator("textarea").focus();
}
async function lines(page: Page) {
  return page.evaluate(() => window.brushWeb?.readLines().map((line) => line.trim()) ?? []);
}
async function command(page: Page, text: string) {
  await page.keyboard.insertText(text);
  await page.keyboard.press("Enter");
}
async function output(page: Page, text: string) {
  await expect.poll(() => lines(page)).toContain(text);
}

for (const engine of ["brush", "just-bash"]) {
  test(`${engine} cost profiling preserves output and publishes a coherent timeline`, async ({
    page,
  }) => {
    await page.goto(`/?test=1&renderer=canvas&engine=${engine}&profile=1&trace=1`);
    await expect.poll(() => page.evaluate(() => window.brushWeb?.snapshot().state)).toBe("ready");
    await page.locator("textarea").focus();
    await command(page, "seq 10000 > cost-note; cat cost-note; echo COST_DONE");
    await output(page, "COST_DONE");
    await expect
      .poll(() => page.evaluate(() => window.brushWeb?.metrics()?.lastExecution?.sequence))
      .toBe(1);
    const metrics = await page.evaluate(() => window.brushWeb?.metrics());
    const profile = metrics?.lastExecution;
    if (!metrics || !profile) throw new Error("Worker profile was not published");
    expect(profile.finishedAt - profile.startedAt).toBeGreaterThanOrEqual(profile.elapsedMs - 0.1);
    expect(profile.firstOutputAt).toBeGreaterThanOrEqual(profile.startedAt);
    expect(profile.lastOutputAt).toBeLessThanOrEqual(profile.finishedAt);
    expect(profile.ringCopyBytes).toBeGreaterThan(58900);
    expect(profile.normalizeMs).toBeGreaterThanOrEqual(0);
    expect(metrics.deliveries.length).toBeGreaterThan(1);
    expect(metrics.frames.length).toBeGreaterThan(0);
    expect(metrics.traceDropped).toBe(0);
    if (engine === "brush") {
      expect(profile.wasiCalls).toBeGreaterThan(0);
      expect(profile.browserCalls).toBeGreaterThan(0);
      expect(profile.hostCopyBytes).toBeGreaterThan(48000);
    } else {
      expect(profile.wasiCalls).toBe(0);
      expect(profile.baselineExecMs).toBeGreaterThan(0);
    }
    await page.goto(`/?test=1&renderer=canvas&engine=${engine}&profile=phase`);
    await expect.poll(() => page.evaluate(() => window.brushWeb?.snapshot().state)).toBe("ready");
    await page.locator("textarea").focus();
    await command(page, "echo PHASE_DONE");
    await output(page, "PHASE_DONE");
    await expect
      .poll(() => page.evaluate(() => window.brushWeb?.metrics()?.lastExecution?.sequence))
      .toBe(1);
    const phase = await page.evaluate(() => window.brushWeb?.metrics()?.lastExecution);
    expect(phase?.elapsedMs).toBeGreaterThan(0);
    expect(phase?.browserCalls).toBe(0);
    expect(phase?.wasiCalls).toBe(0);
    expect(phase?.ringCopyBytes).toBe(0);
  });
}

test("Brush executes real shell state, pipelines, files and command substitution", async ({
  page,
}) => {
  await open(page);
  await command(
    page,
    `export COLOR=violet; greet() { printf 'hello %s\\n' "$1"; }; alias wave='greet alias'; mkdir demo; cd demo; printf 'file-data\\n' > note`,
  );
  await command(
    page,
    `printf '%s:%s\\n' "$COLOR" "$PWD"; greet browser; wave; cat note | cat; printf 'sub:%s\\n' "$(printf nested)"`,
  );
  await output(page, "violet:/home/guest/demo");
  await output(page, "hello browser");
  await output(page, "hello alias");
  await output(page, "file-data");
  await output(page, "sub:nested");
  await command(page, "false");
  await command(page, `printf 'exit:%s\\n' "$?"`);
  await output(page, "exit:1");
  await command(page, "missing_browser_command");
  await command(page, `printf 'missing:%s\\n' "$?"`);
  await output(page, "missing:127");
});

test("native cursor, Home/End, deletion, history and completion", async ({ page }) => {
  await open(page);
  await page.keyboard.insertText("echo eding");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.insertText("it");
  await page.keyboard.press("Home");
  await page.keyboard.press("End");
  await page.keyboard.press("Backspace");
  await page.keyboard.insertText("g");
  await page.keyboard.press("Enter");
  await output(page, "editing");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => (await lines(page)).filter((line) => line === "editing").length)
    .toBe(2);
  await command(page, `touch completion-file`);
  await page.keyboard.insertText("cat completion-f");
  await page.keyboard.press("Tab");
  await expect
    .poll(() => page.evaluate(() => window.brushWeb?.visibleLines().join("\n")))
    .toContain("completion-file");
  await page.keyboard.press("Control+c");
});

test("bracketed multiline paste waits for Enter; unicode remains intact", async ({ page }) => {
  await open(page);
  await page.locator("textarea").evaluate((node) => {
    const data = new DataTransfer();
    data.setData("text/plain", "printf 'paste-one\\n'\nprintf 'paste-two\\n'");
    node.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  await page.waitForTimeout(150);
  expect(await lines(page)).not.toContain("paste-one");
  await page.keyboard.press("Enter");
  await output(page, "paste-one");
  await output(page, "paste-two");
  await command(page, `printf '%s\\n' 'שלום 世界 😀 👩‍💻'`);
  await output(page, "שלום 世界 😀 👩‍💻");
});

test("Ctrl+C interrupts tight loops and stdin while retaining shell state", async ({ page }) => {
  await open(page);
  await command(page, "export KEEP=still-here");
  await command(page, "while :; do :; done");
  await expect.poll(() => page.evaluate(() => window.brushWeb?.snapshot().state)).toBe("running");
  await page.keyboard.press("Control+c");
  await expect.poll(() => page.evaluate(() => window.brushWeb?.snapshot().state)).toBe("ready");
  await command(page, `printf 'interrupt:%s:%s\\n' "$?" "$KEEP"`);
  await output(page, "interrupt:130:still-here");
  await command(page, 'read answer; printf "stdin:%s\\n" "$answer"');
  await expect.poll(() => page.evaluate(() => window.brushWeb?.snapshot().state)).toBe("running");
  await command(page, "typed-input");
  await output(page, "stdin:typed-input");
  await command(page, "cat");
  await page.keyboard.press("Control+c");
  await expect.poll(() => page.evaluate(() => window.brushWeb?.snapshot().state)).toBe("ready");
  await command(page, `printf 'recovered\\n'`);
  await output(page, "recovered");
});

test("resize editing and interactive key demo restore a usable prompt", async ({ page }) => {
  await open(page);
  await page.keyboard.insertText(`printf 'resized-edit\\n'`);
  await page.setViewportSize({ width: 620, height: 600 });
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await output(page, "resized-edit");
  await command(page, "keydemo");
  await expect
    .poll(() => page.evaluate(() => window.brushWeb?.visibleLines().join("\n")))
    .toContain("Brush browser key demo");
  const oldCols = await page.evaluate(() => window.brushWeb?.snapshot().cols);
  await page.setViewportSize({ width: 900, height: 700 });
  await expect.poll(() => page.evaluate(() => window.brushWeb?.snapshot().cols)).not.toBe(oldCols);
  const currentCols = await page.evaluate(() => window.brushWeb?.snapshot().cols);
  await expect
    .poll(() => page.evaluate(() => window.brushWeb?.visibleLines().join("\n")))
    .toContain(`Size: ${currentCols} columns`);
  await page.keyboard.press("ArrowLeft");
  await expect
    .poll(() => page.evaluate(() => window.brushWeb?.visibleLines().join("\n")))
    .toContain("1b 5b 44");
  await page.keyboard.press("q");
  await command(page, `printf 'demo-ended\\n'`);
  await output(page, "demo-ended");
});

test("bounded heavy streaming keeps the main thread responsive", async ({ page }) => {
  await open(page);
  await command(page, "seq 1000000");
  await page.waitForTimeout(250);
  const responsive = await page.evaluate(() => ({
    time: performance.now(),
    bytes: window.brushWeb?.metrics()?.outputBytes,
  }));
  expect(responsive.bytes).toBeGreaterThan(1000);
  await page.keyboard.press("Control+c");
  await expect.poll(() => page.evaluate(() => window.brushWeb?.snapshot().state)).toBe("ready");
  await command(page, `printf 'stream-ended\\n'`);
  await output(page, "stream-ended");
});

test("EOF closes session; worker failure is recoverable with Restart", async ({ page }) => {
  await open(page);
  await page.keyboard.press("Control+d");
  await expect.poll(() => page.evaluate(() => window.brushWeb?.snapshot().state)).toBe("exited");
  await page.getByRole("button", { name: "Restart", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.brushWeb?.snapshot().state)).toBe("ready");
  await page.evaluate(() => window.brushWeb?.crash());
  await expect.poll(() => page.evaluate(() => window.brushWeb?.snapshot().state)).toBe("failed");
  await page.getByRole("button", { name: "Restart session" }).click();
  await expect.poll(() => page.evaluate(() => window.brushWeb?.snapshot().state)).toBe("ready");
  await command(page, `printf 'fresh-worker\\n'`);
  await output(page, "fresh-worker");
});

for (const engine of ["brush", "just-bash"]) {
  test(`${engine} applicable common command fixture`, async ({ page }) => {
    await open(page, engine);
    await command(
      page,
      `mkdir -p fixtures; printf 'common-fixture\\n' > fixtures/note; cat fixtures/note | cat; printf 'sub:%s\\n' "$(echo nested)"`,
    );
    await output(page, "common-fixture");
    await output(page, "sub:nested");
  });
}

test("grapheme editing preserves combining marks and joined emoji", async ({ page }) => {
  await open(page);
  await page.keyboard.insertText("echo é👩‍💻👍🏽");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Delete");
  await page.keyboard.insertText("X");
  await page.keyboard.press("Enter");
  await output(page, "éX");
});

test("sleep, editing and TUI interruptions return to prompt", async ({ page }) => {
  await open(page);
  await page.keyboard.insertText("unfinished");
  await page.keyboard.press("Control+c");
  await command(page, "sleep 30");
  await expect.poll(() => page.evaluate(() => window.brushWeb?.snapshot().state)).toBe("running");
  await page.keyboard.press("Control+c");
  await expect.poll(() => page.evaluate(() => window.brushWeb?.snapshot().state)).toBe("ready");
  await command(page, "keydemo");
  await expect
    .poll(() => page.evaluate(() => window.brushWeb?.visibleLines().join("\n")))
    .toContain("Brush browser key demo");
  await page.keyboard.press("Control+c");
  await expect.poll(() => page.evaluate(() => window.brushWeb?.snapshot().state)).toBe("ready");
  await command(page, "echo tui-interrupted");
  await output(page, "tui-interrupted");
});

test("stderr and input EOF are byte streams; unsupported jobs fail clearly", async ({ page }) => {
  await open(page);
  await command(page, "echo stderr-stream >&2; cat");
  await output(page, "stderr-stream");
  await page.keyboard.press("Control+d");
  await expect.poll(() => page.evaluate(() => window.brushWeb?.snapshot().state)).toBe("ready");
  await command(page, "echo background &");
  await expect
    .poll(() => page.evaluate(() => window.brushWeb?.readLines().join("\n")))
    .toContain("operation not supported on this platform");
  await command(page, "echo status:$?");
  await expect.poll(() => lines(page)).toContain("status:1");
  await command(page, "echo after-eof");
  await output(page, "after-eof");
});

test("IME composition commits exactly once through Ghostty input", async ({ page }) => {
  await open(page);
  await page.keyboard.insertText("echo ");
  await page.locator("textarea").evaluate((node) => {
    if (!(node instanceof HTMLTextAreaElement)) throw new Error("Terminal input missing");
    node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    node.value = "世界";
    node.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        data: "世界",
        inputType: "insertCompositionText",
        isComposing: true,
      }),
    );
    node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "世界" }));
    node.value = "世界";
    node.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        data: "世界",
        inputType: "insertCompositionText",
        isComposing: false,
      }),
    );
  });
  await page.keyboard.press("Enter");
  await output(page, "世界");
  expect(await lines(page)).not.toContain("世界世界");
});

test("unsupported terminal read modes fail; file byte and delimiter reads work", async ({
  page,
}) => {
  await open(page);
  await command(page, `read -n 1 value; echo read-status:$?`);
  await output(page, "read-status:1");
  await command(
    page,
    `printf 'abc:def\\n' > read-file; read -n 2 value < read-file; echo file-byte:$value; read -d : value < read-file; echo file-delim:$value`,
  );
  await output(page, "file-byte:ab");
  await output(page, "file-delim:abc");
});

test("missing WASM gives an actionable startup error and Restart recovers", async ({ page }) => {
  await page.route("**/brush/brush-browser.wasm", (route) => route.fulfill({ status: 404 }));
  await page.goto("/?test=1&renderer=canvas");
  await expect.poll(() => page.evaluate(() => window.brushWeb?.snapshot().state)).toBe("failed");
  await expect(page.getByRole("alert")).toContainText("Brush WASM fetch failed");
  await page.unroute("**/brush/brush-browser.wasm");
  await page.getByRole("button", { name: "Restart session" }).click();
  await expect.poll(() => page.evaluate(() => window.brushWeb?.snapshot().state)).toBe("ready");
  await command(page, "echo wasm-recovered");
  await output(page, "wasm-recovered");
});

test("long wrapped prompt survives resizing while editing and streaming", async ({ page }) => {
  await open(page);
  await command(page, `PS1='${"p".repeat(100)} $ '; echo long-prompt-ready`);
  await output(page, "long-prompt-ready");
  await page.keyboard.insertText("echo wrap-edited");
  await page.keyboard.press("ArrowLeft");
  await page.setViewportSize({ width: 580, height: 620 });
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await output(page, "wrap-edited");
  await command(page, "seq 1000000");
  await expect.poll(() => page.evaluate(() => window.brushWeb?.snapshot().state)).toBe("running");
  await page.setViewportSize({ width: 950, height: 700 });
  await page.keyboard.press("Control+c");
  await expect.poll(() => page.evaluate(() => window.brushWeb?.snapshot().state)).toBe("ready");
  await command(page, "echo resized-stream");
  await output(page, "resized-stream");
});

test("canonical stdin backspace erases joined emoji cells without corruption", async ({ page }) => {
  await open(page);
  await command(page, "read answer; echo canonical:$answer");
  await expect.poll(() => page.evaluate(() => window.brushWeb?.snapshot().state)).toBe("running");
  await page.keyboard.insertText("👩‍💻👍🏽");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await command(page, "ok");
  await output(page, "canonical:ok");
  expect((await lines(page)).join("\n")).not.toContain("👩");
  expect((await lines(page)).join("\n")).not.toContain("👍");
});

test("canonical deletion of text presentation symbols preserves preceding ASCII", async ({
  page,
}) => {
  await open(page);
  await command(page, "read answer; echo symbol:$answer");
  await expect.poll(() => page.evaluate(() => window.brushWeb?.snapshot().state)).toBe("running");
  await page.keyboard.insertText("ab©");
  await page.keyboard.press("Backspace");
  await page.keyboard.insertText("❤");
  await page.keyboard.press("Backspace");
  await page.keyboard.insertText("x");
  await expect.poll(() => lines(page)).toContain("abx");
  await page.keyboard.press("Enter");
  await output(page, "symbol:abx");
});

test("bulk file reads retain shared descriptor positions and decode Unicode", async ({ page }) => {
  await open(page);
  await command(
    page,
    `printf 'first\\nsecond\\n' > partial; { mapfile -n 1 -t rows; read -r next; echo limited:$next; } < partial`,
  );
  await output(page, "limited:second");
  await command(
    page,
    `printf 'first\\n\\003tail\\n' > control-file; { mapfile -t rows; read -r next; echo after-control:$next; } < control-file`,
  );
  await output(page, "after-control:tail");
  await command(
    page,
    "printf 'שלום\\n世界\\n' > unicode-file; mapfile -t rows < unicode-file; echo unicode:${rows[0]}:${rows[1]}",
  );
  await output(page, "unicode:שלום:世界");
});
