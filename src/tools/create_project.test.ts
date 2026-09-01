import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import type { Config } from "../config.js";
import { FsVaultClient } from "../vault/client.js";
import { VaultPathError } from "../vault/client.js";
import { getProjectContext } from "./get_project_context.js";
import { listProjects } from "./list_projects.js";
import {
  createProject,
  fileNameFor,
  formatCreated,
  InvalidTitleError,
  ProjectExistsError,
  today,
} from "./create_project.js";

/** Les tests d'écriture travaillent sur un vault jetable, jamais sur test-vault. */
const bacs: string[] = [];

async function bacASable(): Promise<{ vault: FsVaultClient; config: Config }> {
  const racine = await mkdtemp(path.join(tmpdir(), "obsidian-mcp-"));
  bacs.push(racine);
  const config: Config = {
    vaultPath: racine,
    projectsFolder: "PROJETS",
    projectTag: "claude/project",
  };
  return { vault: new FsVaultClient(racine, { writableFolder: config.projectsFolder }), config };
}

after(async () => {
  await Promise.all(bacs.map((racine) => rm(racine, { recursive: true, force: true })));
});

const LE_JOUR = new Date(2026, 8, 1); // 1er septembre 2026, heure locale

test("today formate en YYYY-MM-DD sans décalage de fuseau", () => {
  // Une date construite en local ne doit pas basculer la veille via UTC.
  assert.equal(today(new Date(2026, 0, 1)), "2026-01-01");
  assert.equal(today(new Date(2026, 11, 31)), "2026-12-31");
});

test("la note est créée dans le dossier projets et devient immédiatement suivie", async () => {
  const { vault, config } = await bacASable();

  const projet = await createProject(
    vault,
    config,
    { title: "Serre connectée", summary: "Arrosage automatique du potager.", stack: ["ESP32"] },
    LE_JOUR,
  );

  assert.equal(projet.path, "PROJETS/Serre connectée.md");
  assert.equal(projet.created, "2026-09-01");

  const suivis = await listProjects(vault, config);
  assert.deepEqual(
    suivis.map((entree) => entree.title),
    ["Serre connectée"],
  );
});

test("le frontmatter est initialisé avec les valeurs fournies", async () => {
  const { vault, config } = await bacASable();
  await createProject(
    vault,
    config,
    {
      title: "Serre connectée",
      summary: "Arrosage automatique du potager.",
      stack: ["ESP32", "MQTT"],
      next_step: "Choisir les capteurs d'humidité",
    },
    LE_JOUR,
  );

  const { frontmatter } = await getProjectContext(vault, config, "Serre connectée");

  assert.equal(frontmatter["title"], "Serre connectée");
  assert.equal(frontmatter["status"], "idée");
  assert.equal(frontmatter["created"], "2026-09-01");
  assert.equal(frontmatter["last_session"], "2026-09-01");
  assert.equal(frontmatter["progress"], "0%");
  assert.equal(frontmatter["session_count"], 0);
  assert.equal(frontmatter["summary"], "Arrosage automatique du potager.");
  assert.equal(frontmatter["next_step"], "Choisir les capteurs d'humidité");
  assert.deepEqual(frontmatter["stack"], ["ESP32", "MQTT"]);
  assert.deepEqual(frontmatter["open_issues"], []);
  assert.deepEqual(frontmatter["resolved_issues"], []);
});

test("sans next_step fourni, un texte d'amorce est posé plutôt qu'un champ vide", async () => {
  const { vault, config } = await bacASable();
  await createProject(vault, config, { title: "Serre", summary: "Potager." }, LE_JOUR);

  const { frontmatter } = await getProjectContext(vault, config, "Serre");
  assert.equal(frontmatter["next_step"], "Définir la première étape");
});

test("le style et les commentaires du template survivent", async () => {
  const { vault, config } = await bacASable();
  const projet = await createProject(
    vault,
    config,
    { title: "Serre connectée", summary: "Arrosage automatique.", stack: ["ESP32"] },
    LE_JOUR,
  );
  const brut = await readFile(path.join(config.vaultPath, projet.path), "utf8");

  assert.match(brut, /# Identité du projet/); // commentaires YAML du template
  assert.match(brut, /# Suivi des problématiques/);
  assert.match(brut, /title: "Serre connectée"/); // guillemets conservés
  assert.match(brut, /tags: \[claude\/project\]/); // liste inline conservée
  assert.match(brut, /session_count: 0/); // scalaire nu conservé
  assert.match(brut, /^#claude\/project$/m); // tag en tête de corps
});

test("les placeholders du template sont retirés de la note créée", async () => {
  const { vault, config } = await bacASable();
  const projet = await createProject(
    vault,
    config,
    { title: "Serre connectée", summary: "Arrosage automatique." },
    LE_JOUR,
  );
  const brut = await readFile(path.join(config.vaultPath, projet.path), "utf8");

  assert.ok(!brut.includes("YYYY-MM-DD"), "aucune date placeholder ne doit subsister");
  assert.ok(!brut.includes("Nom du projet"));
  assert.ok(!brut.includes("### Session 1"));
  // Les titres de section, eux, restent tous en place.
  for (const titre of ["🎯 Vision", "✅ Décisions validées", "📋 Journal des sessions", "❓ Questions ouvertes"]) {
    assert.ok(brut.includes(`## ${titre}`), `section « ${titre} » manquante`);
  }
});

test("la section Vision est amorcée avec le résumé", async () => {
  const { vault, config } = await bacASable();
  await createProject(
    vault,
    config,
    { title: "Serre connectée", summary: "Arrosage automatique du potager." },
    LE_JOUR,
  );

  const { sections } = await getProjectContext(vault, config, "Serre connectée");
  assert.equal(sections["vision"], "> Arrosage automatique du potager.");
  // Les sections encore vides ne sont pas renvoyées comme du contexte.
  assert.ok(!("decisions" in sections));
  assert.ok(!("questions" in sections));
});

test("créer deux fois le même projet est refusé, casse comprise", async () => {
  const { vault, config } = await bacASable();
  await createProject(vault, config, { title: "Serre connectée", summary: "Potager." }, LE_JOUR);

  for (const doublon of ["Serre connectée", "serre CONNECTÉE"]) {
    await assert.rejects(
      () => createProject(vault, config, { title: doublon, summary: "Autre chose." }, LE_JOUR),
      (error: unknown) => {
        assert.ok(error instanceof ProjectExistsError);
        assert.match(error.message, /existe déjà/);
        assert.match(error.message, /get_project_context/);
        return true;
      },
    );
  }
});

test("le contenu d'une note existante n'est jamais écrasé", async () => {
  const { vault, config } = await bacASable();
  const projet = await createProject(
    vault,
    config,
    { title: "Serre connectée", summary: "Version d'origine." },
    LE_JOUR,
  );
  const avant = await readFile(path.join(config.vaultPath, projet.path), "utf8");

  await assert.rejects(
    () => createProject(vault, config, { title: "Serre connectée", summary: "Écrasement." }, LE_JOUR),
    ProjectExistsError,
  );

  const apres = await readFile(path.join(config.vaultPath, projet.path), "utf8");
  assert.equal(apres, avant);
});

test("les caractères interdits par Obsidian sont retirés du nom de fichier", () => {
  assert.equal(fileNameFor("Serre connectée"), "Serre connectée.md");
  assert.equal(fileNameFor('Budget: 2026/2027 ?'), "Budget 2026 2027.md");
  assert.equal(fileNameFor("  .cachée  "), "cachée.md");
});

test("un titre qui ne donne aucun nom de fichier est refusé", () => {
  for (const titre of ["///", "??", "   "]) {
    assert.throws(() => fileNameFor(titre), InvalidTitleError);
  }
});

test("un titre en forme de traversée de chemin reste confiné au dossier projets", async () => {
  const { vault, config } = await bacASable();

  const projet = await createProject(
    vault,
    config,
    { title: "../../.ssh/authorized_keys", summary: "Tentative." },
    LE_JOUR,
  );

  // Séparateurs remplacés, puis points et tirets de tête retirés : il ne reste
  // ni segment de remontée, ni nom de fichier caché.
  assert.equal(projet.path, "PROJETS/ssh authorized_keys.md");
  assert.ok(projet.path.startsWith("PROJETS/"));
  // Et le garde-fou du client refuse de toute façon toute sortie du dossier.
  assert.throws(() => vault.resolveWritable("../evasion.md"), VaultPathError);
});

test("un tag de vault personnalisé est posé dans le frontmatter", async () => {
  const { vault, config: base } = await bacASable();
  const config = { ...base, projectTag: "meta/suivi" };

  await createProject(vault, config, { title: "Serre", summary: "Potager." }, LE_JOUR);

  const suivis = await listProjects(vault, config);
  assert.deepEqual(
    suivis.map((entree) => entree.title),
    ["Serre"],
  );
});

test("le message de confirmation cite le fichier et la suite à donner", () => {
  const rendu = formatCreated({
    title: "Serre connectée",
    path: "PROJETS/Serre connectée.md",
    created: "2026-09-01",
  });

  assert.match(rendu, /« Serre connectée » créé/);
  assert.match(rendu, /`PROJETS\/Serre connectée\.md`/);
  assert.match(rendu, /append_session_summary/);
});

test("deux créations simultanées du même projet n'en produisent qu'une", async () => {
  const { vault, config } = await bacASable();

  // Les requêtes MCP sont servies en parallèle : le refus ne peut pas reposer
  // sur un exists() préalable, il doit venir de l'écriture elle-même.
  const resultats = await Promise.allSettled([
    createProject(vault, config, { title: "Serre", summary: "Première." }, LE_JOUR),
    createProject(vault, config, { title: "Serre", summary: "Seconde." }, LE_JOUR),
  ]);

  const reussies = resultats.filter((resultat) => resultat.status === "fulfilled");
  const refusees = resultats.filter((resultat) => resultat.status === "rejected");

  assert.equal(reussies.length, 1, "une seule création doit aboutir");
  assert.equal(refusees.length, 1);
  assert.ok((refusees[0] as PromiseRejectedResult).reason instanceof ProjectExistsError);

  const suivis = await listProjects(vault, config);
  assert.equal(suivis.length, 1);
});

test("aucun fichier temporaire ne subsiste après une création", async () => {
  const { vault, config } = await bacASable();
  await createProject(vault, config, { title: "Serre", summary: "Potager." }, LE_JOUR);

  const restes = await readdir(path.join(config.vaultPath, config.projectsFolder));
  assert.deepEqual(restes, ["Serre.md"]);
});
