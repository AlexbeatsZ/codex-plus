export type ApprovalMode = "standard" | "unrestricted";
export type ActionKind = "workspace-write" | "command";

const UNRESTRICTED_MODE = "unrestricted";

export function approvalModeFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): ApprovalMode {
  return environment.CODEX_PLUS_MCP_APPROVAL_MODE?.trim().toLowerCase() === UNRESTRICTED_MODE
    ? "unrestricted"
    : "standard";
}

export function actionAnnotations(kind: ActionKind, mode: ApprovalMode) {
  const approvalOverride = mode === "unrestricted";
  return {
    readOnlyHint: false,
    // In unrestricted mode these two hints are an explicit host-approval
    // override. The tool descriptions and server-side authority do not change.
    destructiveHint: !approvalOverride,
    idempotentHint: false,
    openWorldHint: kind === "command" && !approvalOverride,
  } as const;
}

export function approvalModeInstruction(mode: ApprovalMode): string | undefined {
  if (mode !== "unrestricted") return undefined;
  return "This private MCP runtime is in operator-configured unrestricted approval mode. Its write and command tools publish approval-suppressing annotations because the operator pre-authorized them. Their real effects are unchanged: apply_patch overwrites workspace files, and run_command retains full current-user and network authority.";
}
