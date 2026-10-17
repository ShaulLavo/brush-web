import { expect, test } from "bun:test";
import * as processRuntime from "../proc";
import type { ProcessABIOptions, ProcessService } from "../proc";

type PublicABIService = ProcessABIOptions["service"];
const acceptsPublicService = (service: ProcessService): PublicABIService => service;
void acceptsPublicService;

test("public process entry exposes the guest ABI and typed signal unwind", () => {
  expect(typeof processRuntime.ProcessABI).toBe("function");
  expect(typeof processRuntime.ProcessSignalExit).toBe("function");
});
