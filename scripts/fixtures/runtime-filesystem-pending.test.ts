// Pending runtime capability, not passing filesystem/cancellation evidence.
// The runtime owner schedules asynchronous filesystem requests after directory
// recycling and step 7b (Bun subprocesses join the shared process service).
// Run locally with the admitted Bun test runner; these TODOs must become
// executable Rust/runtime tests when submit/take/cancel + poll kind 3 land.
import { test } from "bun:test";

// Deterministic fixture specification:
// - A fake filesystem service owns an unreleased open-request gate.
// - A shell background while-loop and a yielding independent counter stay ready.
// - Foreground `cat /held` submits once; take returns EAGAIN and registers kind3.
// - Drive 64 executor turns: foreground stays pending, counter advances, no task
//   calls poll itself, and the background job remains live.
// - Publish SIGINT and drive bounded turns WITHOUT releasing the service gate:
//   foreground must finish130, cancel exactly once, and remove its registration.
// - Deliver the delayed result after cancellation: no descriptor may transfer;
//   the host releases its reservation and descriptor count returns to baseline.
// - `printf alive` works afterwards; shutdown closes all owned jobs/descriptors.
// Runtime submit/take/cancel must throw if they enter blocking fs.call/wait;
// only the ProcessABI poll wait hook is permitted to wait.

test.todo("stalled filesystem open does not block ready background tasks or SIGINT cancellation");
test.todo(
  "cancelled filesystem open discards a late result without leaking its same-table descriptor",
);
test.todo(
  "filesystem success and ENOENT both wake kind3; success transfers exact bytes and last-close lifetime",
);
test.todo("completion-before-registration and completion-vs-cancel preserve one result owner");
test.todo("invalid filesystem result memory cannot transfer or leak a descriptor");
