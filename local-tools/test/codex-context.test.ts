import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { CodexContextSync } from "../src/codex-context.js";
import { WorkspaceRegistry } from "../src/workspaces.js";
import { makeAgentTemp } from "./support.js";

test("Codex context sync layers AGENTS files and progressively loads skill resources", async () => {
  const temporary = await makeAgentTemp("codex-context-sync");
  try {
    const codexHome = path.join(temporary.directory, ".codex");
    const workspaceRoot = path.join(temporary.directory, "workspace");
    const nested = path.join(workspaceRoot, "src");
    const userSkill = path.join(codexHome, "skills", "sample-skill");
    const explicitSkill = path.join(codexHome, "skills", "explicit-skill");
    const linkedSkill = path.join(temporary.directory, "linked-skill-source");
    const projectSkill = path.join(workspaceRoot, ".agents", "skills", "project-skill");
    await Promise.all([
      mkdir(nested, { recursive: true }),
      mkdir(path.join(userSkill, "references"), { recursive: true }),
      mkdir(path.join(explicitSkill, "agents"), { recursive: true }),
      mkdir(linkedSkill, { recursive: true }),
      mkdir(projectSkill, { recursive: true }),
    ]);

    await Promise.all([
      writeFile(path.join(codexHome, "AGENTS.md"), "global guidance", "utf8"),
      writeFile(path.join(workspaceRoot, "AGENTS.md"), "root guidance", "utf8"),
      writeFile(path.join(nested, "AGENTS.md"), "ignored nested guidance", "utf8"),
      writeFile(path.join(nested, "AGENTS.override.md"), "nested override", "utf8"),
      writeFile(
        path.join(userSkill, "SKILL.md"),
        "---\nname: sample-skill\ndescription: Load sample workflows only when requested.\n---\n\nRead references/details.md when details are needed.\n",
        "utf8",
      ),
      writeFile(path.join(userSkill, "references", "details.md"), "line one\nline two\n", "utf8"),
      writeFile(
        path.join(explicitSkill, "SKILL.md"),
        "---\nname: explicit-skill\ndescription: Run only when explicitly named.\n---\n\nExplicit instructions.\n",
        "utf8",
      ),
      writeFile(path.join(explicitSkill, "agents", "openai.yaml"), "policy:\n  allow_implicit_invocation: false\n", "utf8"),
      writeFile(
        path.join(linkedSkill, "SKILL.md"),
        "---\nname: linked-skill\ndescription: Skill discovered through a directory link.\n---\n\nLinked instructions.\n",
        "utf8",
      ),
      writeFile(
        path.join(projectSkill, "SKILL.md"),
        "---\nname: project-skill\ndescription: Project-scoped workflow.\n---\n\nProject instructions.\n",
        "utf8",
      ),
    ]);
    await symlink(linkedSkill, path.join(codexHome, "skills", "linked-skill"), process.platform === "win32" ? "junction" : "dir");

    const registry = new WorkspaceRegistry([workspaceRoot]);
    const workspace = registry.workspaces[0].id;
    const context = new CodexContextSync(registry, { codexHome, extraSkillRoots: [] });

    const instructions = context.loadInstructions(workspace, "src");
    assert.deepEqual(instructions.sources.map((source) => source.content), [
      "global guidance",
      "root guidance",
      "nested override",
    ]);
    assert.doesNotMatch(instructions.combined, /ignored nested guidance/);
    assert.match(instructions.boundary, /private runtime inputs/);

    const initializationInstructions = context.initializationInstructions();
    assert.match(initializationInstructions, /global guidance/);
    assert.match(initializationInstructions, /root guidance/);
    assert.doesNotMatch(initializationInstructions, /nested override/);
    assert.match(initializationInstructions, /mandatory operating instructions/);

    const skills = context.listSkills(workspace, "src");
    assert.deepEqual(skills.map((skill) => skill.name).sort(), ["explicit-skill", "linked-skill", "project-skill", "sample-skill"]);
    assert.equal(skills.find((skill) => skill.name === "explicit-skill")?.implicitInvocation, false);
    assert.equal(skills.find((skill) => skill.name === "project-skill")?.scope, "project");

    const loaded = context.loadSkill("sample-skill", workspace, "src");
    assert.match(loaded.instructions, /Read references\/details\.md/);
    assert.deepEqual(loaded.resources.map((resource) => resource.path), ["references/details.md"]);

    const resource = context.readSkillResource("sample-skill", "references/details.md", 2, 1, workspace, "src");
    assert.equal(resource.format, "text");
    assert.equal(resource.text, "line two");
    assert.throws(
      () => context.readSkillResource("sample-skill", "../outside.md", 1, 10, workspace, "src"),
      /Invalid or missing skill resource/,
    );

    const triggerSummary = context.triggerSummary();
    assert.match(triggerSummary, /sample-skill/);
    assert.doesNotMatch(triggerSummary, /explicit-skill:/);
  } finally {
    await temporary.cleanup();
  }
});
