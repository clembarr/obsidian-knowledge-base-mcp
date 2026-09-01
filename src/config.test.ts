import assert from "node:assert/strict";
import { test } from "node:test";

import { ConfigError, loadConfig } from "./config.js";

test("VAULT_PATH est obligatoire et l'erreur est actionnable", () => {
  assert.throws(() => loadConfig({}), ConfigError);
  assert.throws(() => loadConfig({ VAULT_PATH: "   " }), /VAULT_PATH/);
});

test("le dossier projets et le tag ont des valeurs par défaut", () => {
  const config = loadConfig({ VAULT_PATH: "/vault" });

  assert.deepEqual(config, {
    vaultPath: "/vault",
    projectsFolder: "PROJETS",
    projectTag: "claude/project",
  });
});

test("dossier et tag sont surchargeables", () => {
  const config = loadConfig({
    VAULT_PATH: "/vault",
    VAULT_PROJECTS_FOLDER: "Projects",
    CLAUDE_PROJECT_TAG: "claude/conv",
  });

  assert.equal(config.projectsFolder, "Projects");
  assert.equal(config.projectTag, "claude/conv");
});

test("une valeur vide retombe sur le défaut plutôt que de casser", () => {
  const config = loadConfig({ VAULT_PATH: "/vault", VAULT_PROJECTS_FOLDER: "  " });
  assert.equal(config.projectsFolder, "PROJETS");
});
