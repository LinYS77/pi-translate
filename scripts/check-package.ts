import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const root = fileURLToPath(new URL("../", import.meta.url));
const staging = await mkdtemp(join(tmpdir(), "pi-translate-package-"));

try {
  // Pack exactly what npm will publish, without invoking lifecycle scripts recursively.
  const npm = process.env.npm_execpath;
  assert.ok(npm, "Run through npm run test:package");
  const [packed] = JSON.parse(
    execFileSync(
      process.execPath,
      [
        npm,
        "pack",
        "--ignore-scripts",
        "--dry-run=false", // Outer npm publish --dry-run must still produce a testable archive.
        "--json",
        "--pack-destination",
        staging,
      ],
      { cwd: root, encoding: "utf8" },
    ),
  );
  assert.equal(packed.name, "@linys77/pi-translate");
  const allowed =
    /^(src\/[^/]+\.ts|docs\/behavior\.md|package\.json|README(?:\.zh-CN)?\.md|LICENSE)$/;
  for (const { path } of packed.files)
    assert.match(path, allowed, `Unexpected published file: ${path}`);
  for (const path of [
    "LICENSE",
    "README.md",
    "README.zh-CN.md",
    "docs/behavior.md",
    "package.json",
  ]) {
    assert.ok(
      packed.files.some((file: { path: string }) => file.path === path),
      `Missing published file: ${path}`,
    );
  }

  execFileSync("tar", ["-xzf", join(staging, packed.filename), "-C", staging]);
  const directory = join(staging, "package");
  const manifest = JSON.parse(
    await readFile(join(directory, "package.json"), "utf8"),
  );
  assert.equal(manifest.name, packed.name);
  assert.equal(manifest.version, packed.version);
  assert.equal(manifest.publishConfig.access, "public");
  assert.equal(
    manifest.dependencies,
    undefined,
    "Pi supplies the runtime dependencies",
  );
  assert.ok(manifest.keywords.includes("pi-package"));
  assert.deepEqual(manifest.peerDependencies, {
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
  });

  const paths = manifest.pi.extensions.map((path: string) => {
    const extension = resolve(directory, path);
    assert.ok(
      extension.startsWith(join(directory, "src") + sep),
      "Extension must be inside the package",
    );
    return extension;
  });
  const loader = new DefaultResourceLoader({
    cwd: staging,
    agentDir: staging,
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
    additionalExtensionPaths: paths,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const extension = loaded.extensions[0];
  assert.deepEqual([...extension.commands.keys()], ["translate"]);
  assert.deepEqual([...extension.shortcuts.keys()], ["alt+t"]);
  assert.ok(extension.handlers.has("agent_settled"));
  assert.ok(extension.entryRenderers?.has("pi-translate.output"));
  console.log(
    `Package verified: ${packed.name}@${packed.version}, ${packed.files.length} files, ${(packed.size / 1024).toFixed(1)} KiB. Actual tarball loads in Pi.`,
  );
} finally {
  await rm(staging, { recursive: true, force: true });
}
