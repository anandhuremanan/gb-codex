import * as assert from "assert";
import * as http from "http";
import * as vscode from "vscode";
import { matchesGlob, parseSkill } from "../skills/frontmatter";
import { SkillRegistry, autoAttachHint, renderCatalog } from "../skills/registry";
import { MAX_CATALOG_SKILLS, MAX_DESCRIPTION_CHARS, SkillMeta } from "../skills/types";
import { toolSets, toolsFor } from "../agent/tools";
import { createSkillTool } from "../agent/tools/skill";
import { ToolContext } from "../agent/tools/types";
import { SnapshotStore } from "../agent/snapshots";
import { SessionController } from "../session/controller";
import { SessionStore } from "../session/store";
import { TranscriptItem } from "../agent/transcript";

const root = () => vscode.workspace.workspaceFolders![0].uri;
const enc = new TextEncoder();

function fakeSkill(name: string, autoAttach: string[] = []): SkillMeta {
  return {
    name,
    description: `Does ${name} things. Use when the task mentions ${name}.`,
    source: "project",
    dir: `/skills/${name}`,
    file: `/skills/${name}/SKILL.md`,
    origin: ".gbs/skills",
    autoAttach,
    warnings: [],
    valid: true,
  };
}

suite("Skills: parsing and catalog", () => {
  test("front matter: fields, lists, and limits", () => {
    const ok = parseSkill(
      [
        "---",
        "name: gbs-component-library",
        'description: "Builds UI with the GBS component library. Use when touching UI in apps that import @gbs/ui."',
        "autoAttach:",
        '  - "src/**/*.tsx"',
        "  - src/**/*.jsx",
        "---",
        "",
        "# Body",
        "Rules go here.",
      ].join("\n"),
    );
    assert.strictEqual(ok.name, "gbs-component-library");
    assert.match(ok.description!, /^Builds UI/);
    assert.deepStrictEqual(ok.autoAttach, ["src/**/*.tsx", "src/**/*.jsx"]);
    assert.strictEqual(ok.body, "# Body\nRules go here.");
    assert.deepStrictEqual(ok.warnings, []);

    assert.deepStrictEqual(parseSkill('---\nname: a-b\ndescription: d\nautoAttach: ["x/*.ts", "y/*.ts"]\n---\nbody').autoAttach, [
      "x/*.ts",
      "y/*.ts",
    ]);

    const noMatter = parseSkill("# Just markdown");
    assert.strictEqual(noMatter.name, undefined);
    assert.ok(noMatter.warnings[0].includes("front matter"));

    const badName = parseSkill("---\nname: Not Valid\ndescription: d\n---\nbody");
    assert.strictEqual(badName.name, undefined);
    assert.ok(badName.warnings.some((w) => w.includes("lowercase")));

    const longDescription = parseSkill(`---\nname: a\ndescription: ${"x".repeat(400)}\n---\nbody`);
    assert.strictEqual(longDescription.description!.length, MAX_DESCRIPTION_CHARS);
    assert.ok(longDescription.warnings.some((w) => w.includes("every request")));

    assert.ok(parseSkill(`---\nname: a\ndescription: d\n---\n${"line\n".repeat(600)}`).warnings.some((w) => w.includes("500 lines")));
  });

  test("autoAttach globs", () => {
    assert.ok(matchesGlob("src/**/*.tsx", "src/components/Button.tsx"));
    assert.ok(matchesGlob("src/**/*.tsx", "src/Button.tsx"));
    assert.ok(matchesGlob("**/*.py", "services/api/main.py"));
    assert.ok(matchesGlob("src/components/*.ts", "src/components/index.ts"));
    assert.ok(!matchesGlob("src/components/*.ts", "src/components/deep/index.ts"));
    assert.ok(!matchesGlob("src/**/*.tsx", "test/Button.tsx"));
    assert.ok(matchesGlob("src/**/*.tsx", "src\\components\\Button.tsx"), "windows separators");
  });

  test("catalog stays small, caps, and prioritises the open file's skills", () => {
    assert.strictEqual(renderCatalog([]).text, "", "no skills means no prompt section at all");
    assert.strictEqual(renderCatalog([{ ...fakeSkill("broken"), valid: false }]).text, "");

    const eight = renderCatalog([1, 2, 3, 4, 5, 6, 7, 8].map((i) => fakeSkill(`skill-${i}`)));
    assert.ok(eight.text.startsWith("# Skills"));
    assert.ok(eight.approxTokens < 300, `catalog should stay small, got ${eight.approxTokens}`);

    const many = renderCatalog(Array.from({ length: 20 }, (_, i) => fakeSkill(`skill-${i}`)));
    assert.strictEqual((many.text.match(/^- /gm) || []).length, MAX_CATALOG_SKILLS);
    assert.ok(many.text.includes("8 more skill(s)"));

    const ordered = renderCatalog(
      [...Array.from({ length: 14 }, (_, i) => fakeSkill(`filler-${i}`)), fakeSkill("ui-kit", ["src/**/*.tsx"])],
      "src/components/Button.tsx",
    );
    assert.ok(
      ordered.text.split("\n").findIndex((l) => l.includes("ui-kit")) < 4,
      "a skill matching the open file must survive the cap",
    );

    assert.match(autoAttachHint([fakeSkill("ui-kit", ["src/**/*.tsx"])], "src/App.tsx"), /Relevant skill\(s\).*ui-kit/);
    assert.strictEqual(autoAttachHint([fakeSkill("ui-kit", ["src/**/*.tsx"])], "docs/readme.md"), "");
    assert.strictEqual(autoAttachHint([fakeSkill("ui-kit", ["src/**/*.tsx"])], undefined), "");
  });

  test("the skill tool only exists when there are usable skills", () => {
    assert.strictEqual(toolsFor("main").length, toolSets.main.length, "no skills: identical tool schemas");
    assert.strictEqual(toolsFor("main", () => []).length, toolSets.main.length);
    assert.strictEqual(toolsFor("main", () => [{ ...fakeSkill("x"), valid: false }]).length, toolSets.main.length);
    const withSkills = toolsFor("main", () => [fakeSkill("x")]);
    assert.strictEqual(withSkills.length, toolSets.main.length + 1);
    assert.strictEqual(withSkills[withSkills.length - 1].name, "skill");
  });
});

// ─── Discovery and the skill tool against the real filesystem ────────────────

const SKILL_BODY = `---
name: demo-skill
description: Demonstrates skills in tests. Use when the task mentions demo-skill.
autoAttach:
  - "src/**/*.ts"
---

# Demo skill

Always call the widget factory instead of constructing widgets directly.

Details: see references/deep.md
`;

async function writeFixtureSkills(): Promise<void> {
  const dir = vscode.Uri.joinPath(root(), ".gbs", "skills", "demo-skill");
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(dir, "references"));
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, "SKILL.md"), enc.encode(SKILL_BODY));
  await vscode.workspace.fs.writeFile(
    vscode.Uri.joinPath(dir, "references", "deep.md"),
    enc.encode("# Deep reference\nThe widget factory lives in src/widgets/factory.ts."),
  );
  // A skill without front matter must be ignored rather than break discovery.
  const broken = vscode.Uri.joinPath(root(), ".gbs", "skills", "broken-skill");
  await vscode.workspace.fs.createDirectory(broken);
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(broken, "SKILL.md"), enc.encode("# no front matter"));
}

async function removeFixtureSkills(): Promise<void> {
  await vscode.workspace.fs.delete(vscode.Uri.joinPath(root(), ".gbs"), { recursive: true, useTrash: false });
}

function toolContext(): ToolContext {
  return {
    signal: new AbortController().signal,
    state: { readVersions: new Map(), loadedSkills: new Set() },
    itemId: "test",
    fileChanged: () => undefined,
    host: {
      config: {} as never,
      setTodos: () => undefined,
      runSubagent: async () => "",
      recordFileChange: () => "snap",
      updateItem: () => undefined,
      createProvider: () => {
        throw new Error("not used");
      },
    },
  };
}

suite("Skills: discovery and loading", () => {
  suiteSetup(writeFixtureSkills);
  suiteTeardown(removeFixtureSkills);

  test("finds project skills and ignores invalid ones", async () => {
    const skills = await new SkillRegistry().list({ projectSkillsAllowed: true });
    const demo = skills.find((s) => s.name === "demo-skill");
    assert.ok(demo, `demo-skill not found in ${skills.map((s) => s.name).join(", ")}`);
    assert.strictEqual(demo.source, "project");
    assert.deepStrictEqual(demo.autoAttach, ["src/**/*.ts"]);
    const broken = skills.find((s) => s.name === "broken-skill");
    assert.ok(broken && !broken.valid, "invalid skills are listed but not usable");
    assert.strictEqual(renderCatalog(skills).text.includes("broken-skill"), false);
  });

  test("project skills are hidden until the workspace is allowed", async () => {
    const skills = await new SkillRegistry().list({ projectSkillsAllowed: false });
    assert.strictEqual(skills.length, 0);
  });

  test("the skill tool loads instructions, resources, and refuses escapes", async () => {
    const skills = await new SkillRegistry().list({ projectSkillsAllowed: true });
    const tool = createSkillTool(() => skills);
    const ctx = toolContext();

    const body = await tool.execute({ name: "demo-skill" }, ctx);
    assert.ok(body.content.includes("widget factory"), body.content);
    assert.ok(body.content.includes("repository"), "repo skills are labelled as untrusted input");

    const again = await tool.execute({ name: "demo-skill" }, ctx);
    assert.ok(again.content.includes("already loaded"), "a skill is not paid for twice");

    const resource = await tool.execute({ name: "demo-skill", resource: "references/deep.md" }, ctx);
    assert.ok(resource.content.includes("factory.ts"), resource.content);

    for (const bad of ["../../../secret.txt", "/etc/passwd", "references/../../../x"]) {
      const escaped = await tool.execute({ name: "demo-skill", resource: bad }, ctx);
      assert.ok(escaped.isError, `escape not blocked: ${bad}`);
    }
    const missing = await tool.execute({ name: "nope" }, ctx);
    assert.ok(missing.isError && missing.content.includes("Unknown skill"));
  });
});

// ─── End-to-end through the controller ──────────────────────────────────────

function createController(skillsAllowed: boolean | undefined) {
  const memento = new Map<string, unknown>();
  if (skillsAllowed !== undefined) {
    memento.set("gbsAgent.skillsAllowed", skillsAllowed);
  }
  const state = {
    get: (key: string, fallback?: unknown) => (memento.has(key) ? memento.get(key) : fallback),
    update: async (key: string, value: unknown) => void memento.set(key, value),
    keys: () => [...memento.keys()],
  } as unknown as vscode.Memento;
  const context = {
    secrets: { get: async () => undefined, store: async () => undefined },
    workspaceState: state,
  } as unknown as vscode.ExtensionContext;
  const controller = new SessionController(context, new SessionStore(state), new SnapshotStore(), vscode.window.createOutputChannel("Skills Test"));
  const posts: any[] = [];
  controller.attachView({ post: (m) => posts.push(m), isVisible: () => true, reveal: () => undefined });
  return { controller, posts };
}

async function withMockOllama(responder: (body: any) => object[], run: (requests: any[]) => Promise<void>) {
  const requests: any[] = [];
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (d) => (data += d));
    req.on("end", () => {
      const body = JSON.parse(data);
      requests.push(body);
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      for (const chunk of responder(body)) {
        res.write(JSON.stringify(chunk) + "\n");
      }
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const config = vscode.workspace.getConfiguration("gbsAgent");
  await config.update("provider", "ollama", vscode.ConfigurationTarget.Global);
  await config.update("ollama.baseUrl", `http://127.0.0.1:${port}`, vscode.ConfigurationTarget.Global);
  await config.update("model", "mock-model", vscode.ConfigurationTarget.Global);
  try {
    await run(requests);
  } finally {
    server.close();
  }
}

const say = (text: string) => [{ message: { role: "assistant", content: text } }, { done: true, prompt_eval_count: 100, eval_count: 10 }];
const call = (name: string, args: object) => [
  { message: { role: "assistant", content: "", tool_calls: [{ function: { name, arguments: args } }] } },
  { done: true, prompt_eval_count: 100, eval_count: 10 },
];

async function waitForIdle(posts: any[], timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const last = [...posts].reverse().find((p) => p.type === "running");
    if (last && last.running === false) {
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("agent did not finish in time");
}

function transcript(posts: any[]): TranscriptItem[] {
  const items = new Map<string, TranscriptItem>();
  for (const p of posts) {
    if (p.type === "init") {
      p.items.forEach((i: TranscriptItem) => items.set(i.id, i));
    }
    if (p.type === "patch") {
      p.items.forEach((i: TranscriptItem) => items.set(i.id, JSON.parse(JSON.stringify(i))));
      p.removed.forEach((id: string) => items.delete(id));
    }
  }
  return [...items.values()];
}

suite("Skills: end-to-end", () => {
  suiteSetup(writeFixtureSkills);
  suiteTeardown(removeFixtureSkills);

  test("catalog reaches the model and the agent can load the skill", async () => {
    await withMockOllama(
      (body) => (body.messages.some((m: any) => m.role === "tool") ? say("Done.") : call("skill", { name: "demo-skill" })),
      async (requests) => {
        const { controller, posts } = createController(true);
        await controller.handleMessage({ type: "ready" });
        await controller.handleMessage({ type: "send", text: "build a widget", includeEditor: false });
        await waitForIdle(posts);

        const system = requests[0].messages[0].content;
        assert.ok(system.includes("# Skills"), "catalog missing from the system prompt");
        assert.ok(system.includes("demo-skill"), system.slice(-400));
        assert.ok(!system.includes("broken-skill"), "invalid skills must not reach the prompt");
        assert.ok(requests[0].tools.some((t: any) => t.function.name === "skill"), "skill tool missing");
        // The catalog must not blow up the prompt.
        assert.ok(system.length < 8000, `system prompt grew to ${system.length} chars`);

        const toolResult = requests[1].messages.find((m: any) => m.role === "tool");
        assert.ok(toolResult.content.includes("widget factory"), "skill body was not returned to the model");
        assert.strictEqual(requests[0].messages[0].content, requests[1].messages[0].content, "system prompt must stay stable");

        const item = transcript(posts).find((i) => i.kind === "tool" && i.name === "skill");
        assert.ok(item && item.kind === "tool" && item.status === "done" && item.title === "demo-skill");
        controller.dispose();
      },
    );
  });

  test("a workspace whose skills are not allowed sends the original prompt and tools", async () => {
    await withMockOllama(
      () => say("Nothing to do."),
      async (requests) => {
        const { controller, posts } = createController(false);
        await controller.handleMessage({ type: "ready" });
        await controller.handleMessage({ type: "send", text: "hello", includeEditor: false });
        await waitForIdle(posts);

        const system = requests[0].messages[0].content;
        assert.ok(!system.includes("# Skills"), "no catalog without permission");
        assert.strictEqual(requests[0].tools.length, toolSets.main.length, "tool schemas unchanged");
        assert.ok(!requests[0].tools.some((t: any) => t.function.name === "skill"));
        controller.dispose();
      },
    );
  });
});
