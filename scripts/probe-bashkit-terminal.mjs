import { readFile, writeFile } from "node:fs/promises";
import { initBashkit, Terminal } from "../.sources/bashkit/pkg/index.js";

const root = new URL("../", import.meta.url);
const pins = JSON.parse(await readFile(new URL("sources.lock.json", root), "utf8"));
await initBashkit(await readFile(new URL(".sources/bashkit/pkg/bashkit_wasm_bg.wasm", root)));
const term = new Terminal({
  rows: 40,
  cols: 120,
  profile: "interactive",
  maxCommands: 10000000,
  maxLoopIterations: 10000000,
  maxMemory: 33554432,
  timeoutMs: 60000,
});
const cases = [];
async function run(id, input) {
  term.send(input);
  const status = await term.runUntilIdle();
  cases.push({
    id,
    status,
    output: new TextDecoder().decode(term.takeOutput()),
    screen: term.screenText(),
  });
}
await run(
  "inventory",
  "compgen -b > /tmp/builtins; compgen -c > /tmp/commands; ls /usr/bin > /tmp/tools\r",
);
const names = (path) => term.fs().readFile(path).trim().split(/\s+/);
const inventory = {
  bashBuiltins: names("/tmp/builtins"),
  commandCompletions: names("/tmp/commands"),
  virtualExecutables: names("/tmp/tools"),
};
await run(
  "repeat-files",
  "for ((R=0;R<20;R++)); do seq 10000 > /tmp/source; cat /tmp/source | cat > /tmp/copy; mapfile -t rows < /tmp/copy; echo FILE:$R:${#rows[@]}; done\r",
);
await run("bracketed-paste", "\x1b[200~echo PASTE_ONE\necho PASTE_TWO\x1b[201~");
await writeFile(
  new URL("docs/evidence/bashkit-native-node-probe.json", root),
  JSON.stringify(
    {
      revision: pins.bashkitTerminal.revision,
      runtime: process.version,
      scope:
        "Real source WASM under Node. Capability inspection only; no browser or performance claim.",
      inventory,
      cases,
    },
    null,
    2,
  ) + "\n",
);
process.stdout.write(
  `Recorded ${inventory.bashBuiltins.length} Bash builtin names and ${inventory.virtualExecutables.length} virtual executable names. Inspect individual tool behavior before claiming complete flag support.\n`,
);
