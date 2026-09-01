import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { Config } from "../config.js";
import { FsVaultClient } from "../vault/client.js";
import { formatProjects, listProjects } from "./list_projects.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const config: Config = {
  vaultPath: path.join(REPO, "test-vault"),
  projectsFolder: "PROJETS",
  projectTag: "claude/project",
};
const vault = new FsVaultClient(config.vaultPath, { writableFolder: config.projectsFolder });

test("le double filtre dossier + tag est appliqué", async () => {
  const projets = await listProjects(vault, config);
  const titres = projets.map((projet) => projet.title);

  assert.deepEqual(titres.slice().sort(), [
    "Bot Discord club escalade",
    "Refonte portfolio",
    "Serveur domotique",
  ]);

  // Dans le dossier mais sans le tag.
  assert.ok(!titres.includes("Veille IA"));
  // Sans frontmatter du tout.
  assert.ok(!titres.some((titre) => titre.includes("Brouillon")));
  // Hors du dossier projets.
  assert.ok(!titres.some((titre) => titre.includes("Zigbee")));
  // Note chiffrée.
  assert.ok(!projets.some((projet) => projet.path.endsWith(".mdenc")));
});

test("un projet rangé en sous-dossier reste suivi", async () => {
  const projets = await listProjects(vault, config);
  const archive = projets.find((projet) => projet.title === "Refonte portfolio");

  assert.ok(archive, "le sous-dossier Archives doit être parcouru");
  assert.equal(archive.path, "PROJETS/Archives/Refonte portfolio.md");
  assert.equal(archive.status, "en pause");
});

test("les projets sortent du plus récemment travaillé au plus ancien", async () => {
  const projets = await listProjects(vault, config);

  assert.deepEqual(
    projets.map((projet) => projet.title),
    ["Bot Discord club escalade", "Serveur domotique", "Refonte portfolio"],
  );
});

test("chaque entrée porte les champs attendus", async () => {
  const projets = await listProjects(vault, config);
  const domotique = projets.find((projet) => projet.title === "Serveur domotique");

  assert.deepEqual(domotique, {
    title: "Serveur domotique",
    path: "PROJETS/Serveur domotique.md",
    status: "en cours",
    last_session: "2026-08-28",
    next_step: "Écrire l'automatisation de coupure du chauffe-eau en heures pleines",
    progress: "60%",
  });
});

test("un tag différent ne remonte aucun projet", async () => {
  const projets = await listProjects(vault, { ...config, projectTag: "claude/autre" });
  assert.deepEqual(projets, []);
});

test("le rendu texte reste compact et cite le chemin", async () => {
  const rendu = formatProjects(await listProjects(vault, config), config);

  assert.match(rendu, /^3 projets suivis\./);
  assert.match(rendu, /\*\*Serveur domotique\*\* — en cours · 60%/);
  assert.match(rendu, /prochaine étape : Écrire l'automatisation/);
  assert.match(rendu, /`PROJETS\/Archives\/Refonte portfolio\.md`/);
});

test("le message de liste vide explique le double filtre", () => {
  const rendu = formatProjects([], config);

  assert.match(rendu, /Aucun projet suivi dans « PROJETS »/);
  assert.match(rendu, /claude\/project/);
  assert.match(rendu, /create_project/);
});
