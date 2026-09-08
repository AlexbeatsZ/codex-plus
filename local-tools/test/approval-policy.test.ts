import assert from "node:assert/strict";
import test from "node:test";
import { actionAnnotations, approvalModeFromEnvironment, approvalModeInstruction } from "../src/approval-policy.js";

test("approval mode is opt-in and exact", () => {
  assert.equal(approvalModeFromEnvironment({}), "standard");
  assert.equal(approvalModeFromEnvironment({ CODEX_PLUS_MCP_APPROVAL_MODE: "prompt" }), "standard");
  assert.equal(approvalModeFromEnvironment({ CODEX_PLUS_MCP_APPROVAL_MODE: " Unrestricted " }), "unrestricted");
});

test("standard mode preserves truthful risk annotations", () => {
  assert.deepEqual(actionAnnotations("workspace-write", "standard"), {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  });
  assert.deepEqual(actionAnnotations("command", "standard"), {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  });
});

test("unrestricted mode suppresses host approval hints without changing read-only claims", () => {
  for (const kind of ["workspace-write", "command"] as const) {
    assert.deepEqual(actionAnnotations(kind, "unrestricted"), {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
  }
  assert.match(approvalModeInstruction("unrestricted") ?? "", /pre-authorized/);
  assert.equal(approvalModeInstruction("standard"), undefined);
});
