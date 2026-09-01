import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { Config } from "../config.js";
import { loadProjects, projectTitle } from "../projects.js";
import { FsVaultClient } from "../vault/client.js";
import {
  AmbiguousProjectError,
  findProject,
  formatContext,
  getProjectContext,
  ProjectNotFoundError,
} from "./get_project_context.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const config: Config = {
  vaultPath: path.join(REPO, "test-vault"),
  projectsFolder: "PROJETS",
  projectTag: "claude/project",
};
const vault = new FsVaultClient(config.vaultPath, { writableFolder: config.projectsFolder });

test("un titre exact remonte le bon projet", async () => {
  const contexte = await getProjectContext(vault, config, "Serveur domotique");

  assert.equal(contexte.title, "Serveur domotique");
  assert.equal(contexte.path, "PROJETS/Serveur domotique.md");
});

test("la correspondance ignore casse, accents et espaces superflus", async () => {
  for (const requete of ["serveur domotique", "SERVEUR  DOMOTIQUE", "  Serveur Domotique  "]) {
    const contexte = await getProjectContext(vault, config, requete);
    assert.equal(contexte.title, "Serveur domotique", `échec pour « ${requete} »`);
  }
});

test("un titre partiel suffit", async () => {
  const contexte = await getProjectContext(vault, config, "domotique");
  assert.equal(contexte.title, "Serveur domotique");
});

test("le frontmatter est renvoyé en entier, clés perso comprises", async () => {
  const { frontmatter } = await getProjectContext(vault, config, "Serveur domotique");

  assert.equal(frontmatter["progress"], "60%");
  assert.equal(frontmatter["session_count"], 3);
  assert.deepEqual(frontmatter["open_issues"], [
    "Le capteur de température du salon décroche toutes les 48h",
    "Pas encore de stratégie de sauvegarde de la config",
  ]);
  // Clé hors schéma ajoutée à la main dans le vault.
  assert.equal(frontmatter["budget"], "230 €");
});

test("les quatre sections de contexte sont extraites, sans le journal", async () => {
  const { sections } = await getProjectContext(vault, config, "Serveur domotique");

  assert.deepEqual(Object.keys(sections).sort(), [
    "architecture",
    "decisions",
    "questions",
    "vision",
  ]);
  assert.match(sections["vision"]!, /sans dépendre d'un cloud/);
  assert.match(sections["decisions"]!, /\[2026-08-28\] Les automatisations vivent en YAML/);
  assert.match(sections["questions"]!, /Node-RED/);
});

test("le journal des sessions n'est jamais renvoyé", async () => {
  const contexte = await getProjectContext(vault, config, "Serveur domotique");
  const rendu = formatContext(contexte);

  assert.ok(!("journal" in contexte.sections));
  assert.ok(!rendu.includes("Session 2 — 2026-07-19"));
  assert.ok(!rendu.includes("Réception du dongle"));
});

test("le séparateur de fin de section est retiré du texte extrait", async () => {
  const { sections } = await getProjectContext(vault, config, "Serveur domotique");

  for (const [cle, texte] of Object.entries(sections)) {
    assert.ok(!texte.trimEnd().endsWith("---"), `séparateur résiduel dans « ${cle} »`);
  }
});

test("un bloc de code contenant un titre ne tronque pas l'architecture", async () => {
  const { sections } = await getProjectContext(vault, config, "Serveur domotique");

  // Le schéma ASCII et le tableau doivent être là tous les deux.
  assert.match(sections["architecture"]!, /Zigbee2MQTT → MQTT → Home Assistant/);
  assert.match(sections["architecture"]!, /Node-RED\s*\|/);
  assert.match(sections["architecture"]!, /à migrer sur SSD/);
});

test("une section absente est omise plutôt que renvoyée vide", async () => {
  const { sections } = await getProjectContext(vault, config, "Bot Discord club escalade");

  for (const texte of Object.values(sections)) {
    assert.ok(texte.trim().length > 0);
  }
});

test("un titre inconnu lève une erreur qui liste les projets suivis", async () => {
  await assert.rejects(
    () => getProjectContext(vault, config, "Projet fantôme"),
    (error: unknown) => {
      assert.ok(error instanceof ProjectNotFoundError);
      assert.match(error.message, /Projet fantôme/);
      assert.match(error.message, /Serveur domotique/);
      return true;
    },
  );
});

test("une note non suivie reste introuvable", async () => {
  // Dans le dossier projets mais sans le tag.
  await assert.rejects(() => getProjectContext(vault, config, "Veille IA"), ProjectNotFoundError);
});

test("un titre ambigu est signalé avec les candidats", () => {
  const projets = [
    { path: "a.md", data: { title: "Serveur domotique" }, note: { body: "" } },
    { path: "b.md", data: { title: "Serveur de jeu" }, note: { body: "" } },
  ] as unknown as Parameters<typeof findProject>[0];

  assert.throws(
    () => findProject(projets, "serveur"),
    (error: unknown) => {
      assert.ok(error instanceof AmbiguousProjectError);
      assert.deepEqual(error.matches, ["Serveur domotique", "Serveur de jeu"]);
      assert.match(error.message, /Préciser le titre exact/);
      return true;
    },
  );
});

test("une requête de moins de 3 caractères n'ouvre pas la recherche approximative", async () => {
  const projets = await loadProjects(vault, config);

  // « e » est une sous-chaîne des trois titres : sans le seuil, ce serait une ambiguïté.
  for (const requete of ["e", "se", "  b  "]) {
    assert.throws(
      () => findProject(projets, requete),
      (error: unknown) => {
        assert.ok(error instanceof ProjectNotFoundError, `« ${requete} » ne doit pas accrocher`);
        assert.match(error.message, /au moins 3 caractères/);
        return true;
      },
    );
  }
});

test("le seuil ne bride pas la correspondance exacte sur un titre court", () => {
  const projets = [
    { path: "a.md", data: { title: "IA" }, note: { body: "" } },
    { path: "b.md", data: { title: "Serveur domotique" }, note: { body: "" } },
  ] as unknown as Parameters<typeof findProject>[0];

  assert.equal(findProject(projets, "IA").data["title"], "IA");
  assert.equal(findProject(projets, "ia").data["title"], "IA");
});

test("à 3 caractères la recherche approximative reprend", async () => {
  const projets = await loadProjects(vault, config);
  assert.equal(projectTitle(findProject(projets, "bot")), "Bot Discord club escalade");
});

test("un titre exact l'emporte sur un projet dont il est le préfixe", () => {
  const projets = [
    { path: "a.md", data: { title: "Bot" }, note: { body: "" } },
    { path: "b.md", data: { title: "Bot Discord" }, note: { body: "" } },
  ] as unknown as Parameters<typeof findProject>[0];

  assert.equal(findProject(projets, "Bot").data["title"], "Bot");
  assert.equal(findProject(projets, "Bot Discord").data["title"], "Bot Discord");
});

test("le rendu met en avant la prochaine étape et cite le chemin", async () => {
  const rendu = formatContext(await getProjectContext(vault, config, "Serveur domotique"));

  assert.match(rendu, /^# Serveur domotique/);
  assert.match(rendu, /en cours · 60% · Phase 2 — Automatisations/);
  assert.match(rendu, /\*\*Prochaine étape : Écrire l'automatisation/);
  assert.match(rendu, /Dernière session : 2026-08-28 \(3 au total\)/);
  assert.match(rendu, /`PROJETS\/Serveur domotique\.md`/);
  assert.match(rendu, /Problèmes ouverts[\s\S]*capteur de température/);
  assert.match(rendu, /Stack[\s\S]*Home Assistant/);
});
