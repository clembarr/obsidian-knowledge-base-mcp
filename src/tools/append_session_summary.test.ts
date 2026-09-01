import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import type { Config } from "../config.js";
import { FsVaultClient } from "../vault/client.js";
import { appendSessionSummary, formatRecorded } from "./append_session_summary.js";
import { createProject } from "./create_project.js";
import { getProjectContext, ProjectNotFoundError } from "./get_project_context.js";
import { listProjects } from "./list_projects.js";

const bacs: string[] = [];
const LE_JOUR = new Date(2026, 8, 1);

/** Un vault jetable contenant un projet fraîchement créé. */
async function projetNeuf(): Promise<{ vault: FsVaultClient; config: Config; notePath: string }> {
  const racine = await mkdtemp(path.join(tmpdir(), "obsidian-mcp-"));
  bacs.push(racine);
  const config: Config = { vaultPath: racine, projectsFolder: "PROJETS", projectTag: "claude/project" };
  const vault = new FsVaultClient(racine, { writableFolder: config.projectsFolder });

  const projet = await createProject(
    vault,
    config,
    { title: "Serre connectée", summary: "Arrosage automatique du potager.", stack: ["ESP32"] },
    LE_JOUR,
  );
  return { vault, config, notePath: path.join(racine, projet.path) };
}

after(async () => {
  await Promise.all(bacs.map((racine) => rm(racine, { recursive: true, force: true })));
});

const BILAN = {
  discussed: "Choix du protocole radio et câblage du premier capteur.",
  new_decisions: ["LoRa plutôt que Wi-Fi pour la portée"],
  resolved_issues: [],
  open_issues: ["L'étanchéité du boîtier n'est pas validée"],
  open_questions: ["Faut-il une batterie tampon ?"],
  next_step: "Souder le capteur d'humidité",
  progress: "20%",
  current_phase: "Phase 2 — Prototype",
};

test("le frontmatter porte le nouvel état après un bilan", async () => {
  const { vault, config } = await projetNeuf();
  await appendSessionSummary(vault, config, "Serre connectée", BILAN, LE_JOUR);

  const { frontmatter } = await getProjectContext(vault, config, "Serre connectée");
  assert.equal(frontmatter["last_session"], "2026-09-01");
  assert.equal(frontmatter["session_count"], 1);
  assert.equal(frontmatter["progress"], "20%");
  assert.equal(frontmatter["current_phase"], "Phase 2 — Prototype");
  assert.equal(frontmatter["next_step"], "Souder le capteur d'humidité");
  assert.deepEqual(frontmatter["open_issues"], ["L'étanchéité du boîtier n'est pas validée"]);
});

test("session_count s'incrémente à chaque bilan", async () => {
  const { vault, config } = await projetNeuf();

  for (const attendu of [1, 2, 3]) {
    const bilan = await appendSessionSummary(vault, config, "Serre connectée", BILAN, LE_JOUR);
    assert.equal(bilan.session_number, attendu);
  }

  const { frontmatter } = await getProjectContext(vault, config, "Serre connectée");
  assert.equal(frontmatter["session_count"], 3);
});

test("une entrée numérotée est ajoutée au journal, sans écraser les précédentes", async () => {
  const { vault, config, notePath } = await projetNeuf();

  await appendSessionSummary(vault, config, "Serre connectée", BILAN, LE_JOUR);
  await appendSessionSummary(
    vault,
    config,
    "Serre connectée",
    { ...BILAN, discussed: "Soudure et premiers relevés.", next_step: "Étalonner" },
    new Date(2026, 8, 8),
  );

  const brut = await readFile(notePath, "utf8");
  assert.match(brut, /### Session 1 — 2026-09-01/);
  assert.match(brut, /> Choix du protocole radio/);
  assert.match(brut, /### Session 2 — 2026-09-08/);
  assert.match(brut, /> Soudure et premiers relevés\./);
  // Ordre chronologique : la session 1 reste avant la session 2.
  assert.ok(brut.indexOf("### Session 1") < brut.indexOf("### Session 2"));
});

test("un récit multiligne est entièrement mis en citation", async () => {
  const { vault, config, notePath } = await projetNeuf();
  await appendSessionSummary(
    vault,
    config,
    "Serre connectée",
    { ...BILAN, discussed: "Première ligne.\n\nSeconde ligne." },
    LE_JOUR,
  );

  const brut = await readFile(notePath, "utf8");
  assert.match(brut, /> Première ligne\.\n>\n> Seconde ligne\./);
});

test("les décisions sont datées et ajoutées à leur section", async () => {
  const { vault, config } = await projetNeuf();
  await appendSessionSummary(vault, config, "Serre connectée", BILAN, LE_JOUR);

  const { sections } = await getProjectContext(vault, config, "Serre connectée");
  assert.equal(sections["decisions"], "- [2026-09-01] LoRa plutôt que Wi-Fi pour la portée");
});

test("une décision déjà prise n'est pas redoublée, même à une autre date", async () => {
  const { vault, config } = await projetNeuf();

  await appendSessionSummary(vault, config, "Serre connectée", BILAN, LE_JOUR);
  const second = await appendSessionSummary(
    vault,
    config,
    "Serre connectée",
    BILAN,
    new Date(2026, 8, 8),
  );

  assert.equal(second.added_decisions, 0);
  const { sections } = await getProjectContext(vault, config, "Serre connectée");
  assert.equal(sections["decisions"]!.split("\n").length, 1);
});

test("les questions ouvertes alimentent leur propre section", async () => {
  const { vault, config } = await projetNeuf();
  await appendSessionSummary(vault, config, "Serre connectée", BILAN, LE_JOUR);

  const { sections } = await getProjectContext(vault, config, "Serre connectée");
  assert.equal(sections["questions"], "- Faut-il une batterie tampon ?");
  // Les problèmes, eux, restent dans le frontmatter : pas de doublon dans le corps.
  assert.ok(!sections["questions"]!.includes("étanchéité"));
});

test("un problème résolu passe des ouverts aux résolus", async () => {
  const { vault, config } = await projetNeuf();
  await appendSessionSummary(vault, config, "Serre connectée", BILAN, LE_JOUR);

  const bilan = await appendSessionSummary(
    vault,
    config,
    "Serre connectée",
    {
      ...BILAN,
      new_decisions: [],
      open_questions: [],
      open_issues: [],
      resolved_issues: ["L'étanchéité du boîtier n'est pas validée"],
    },
    new Date(2026, 8, 8),
  );

  assert.deepEqual(bilan.open_issues, []);
  assert.deepEqual(bilan.resolved_issues, ["L'étanchéité du boîtier n'est pas validée"]);
});

test("un problème non relisté reste ouvert plutôt que d'être effacé", async () => {
  const { vault, config } = await projetNeuf();
  await appendSessionSummary(vault, config, "Serre connectée", BILAN, LE_JOUR);

  // Session suivante : le modèle ne relance ni le problème, ni sa résolution.
  const bilan = await appendSessionSummary(
    vault,
    config,
    "Serre connectée",
    { ...BILAN, new_decisions: [], open_questions: [], open_issues: [], resolved_issues: [] },
    new Date(2026, 8, 8),
  );

  assert.deepEqual(bilan.open_issues, ["L'étanchéité du boîtier n'est pas validée"]);
});

test("un problème signalé deux fois n'est compté qu'une", async () => {
  const { vault, config } = await projetNeuf();
  await appendSessionSummary(vault, config, "Serre connectée", BILAN, LE_JOUR);

  const bilan = await appendSessionSummary(
    vault,
    config,
    "Serre connectée",
    { ...BILAN, open_issues: ["l'étanchéité du boîtier n'est pas validée  "] },
    new Date(2026, 8, 8),
  );

  assert.equal(bilan.open_issues.length, 1);
});

test("progress et current_phase omis laissent les valeurs en place", async () => {
  const { vault, config } = await projetNeuf();
  await appendSessionSummary(vault, config, "Serre connectée", BILAN, LE_JOUR);

  await appendSessionSummary(
    vault,
    config,
    "Serre connectée",
    {
      discussed: "Petite session.",
      new_decisions: [],
      resolved_issues: [],
      open_issues: [],
      open_questions: [],
      next_step: "Continuer",
    },
    new Date(2026, 8, 8),
  );

  const { frontmatter } = await getProjectContext(vault, config, "Serre connectée");
  assert.equal(frontmatter["progress"], "20%");
  assert.equal(frontmatter["current_phase"], "Phase 2 — Prototype");
});

test("le corps existant n'est ni déplacé ni réécrit", async () => {
  const { vault, config, notePath } = await projetNeuf();
  const avant = await readFile(notePath, "utf8");

  await appendSessionSummary(vault, config, "Serre connectée", BILAN, LE_JOUR);
  const apres = await readFile(notePath, "utf8");

  // La section Architecture, jamais touchée par ce tool, doit être identique.
  const extrait = (texte: string) =>
    texte.slice(texte.indexOf("## 🏗️"), texte.indexOf("## 📋"));
  assert.equal(extrait(apres), extrait(avant));

  // Commentaires YAML et styles d'écriture du template survivent.
  assert.match(apres, /# Identité du projet/);
  assert.match(apres, /title: "Serre connectée"/);
  assert.match(apres, /tags: \[claude\/project\]/);
});

test("les sections manquantes sont créées plutôt que de faire échouer l'écriture", async () => {
  const { vault, config, notePath } = await projetNeuf();

  // Une note remaniée à la main dans Obsidian, réduite à son frontmatter.
  const brut = await readFile(notePath, "utf8");
  const frontmatter = brut.slice(0, brut.indexOf("\n---\n", 4) + 5);
  await vault.write("PROJETS/Serre connectée.md", `${frontmatter}\nDes notes en vrac.\n`);

  await appendSessionSummary(vault, config, "Serre connectée", BILAN, LE_JOUR);

  const apres = await readFile(notePath, "utf8");
  assert.match(apres, /Des notes en vrac\./); // rien n'est perdu
  assert.match(apres, /## 📋 Journal des sessions/);
  assert.match(apres, /### Session 1 — 2026-09-01/);
  assert.match(apres, /## ✅ Décisions validées/);
  assert.match(apres, /## ❓ Questions ouvertes/);
});

test("le bilan remonte dans list_projects sans relire la note", async () => {
  const { vault, config } = await projetNeuf();
  await appendSessionSummary(vault, config, "Serre connectée", BILAN, LE_JOUR);

  const [entree] = await listProjects(vault, config);
  assert.equal(entree!.next_step, "Souder le capteur d'humidité");
  assert.equal(entree!.progress, "20%");
  assert.equal(entree!.last_session, "2026-09-01");
});

test("un projet inconnu est refusé sans rien écrire", async () => {
  const { vault, config, notePath } = await projetNeuf();
  const avant = await readFile(notePath, "utf8");

  await assert.rejects(
    () => appendSessionSummary(vault, config, "Projet fantôme", BILAN, LE_JOUR),
    ProjectNotFoundError,
  );
  assert.equal(await readFile(notePath, "utf8"), avant);
});

test("la date fournie l'emporte sur la date du jour", async () => {
  const { vault, config } = await projetNeuf();
  const bilan = await appendSessionSummary(
    vault,
    config,
    "Serre connectée",
    { ...BILAN, date: "2026-07-04" },
    LE_JOUR,
  );

  assert.equal(bilan.date, "2026-07-04");
  const { sections } = await getProjectContext(vault, config, "Serre connectée");
  assert.match(sections["decisions"]!, /^- \[2026-07-04\]/);
});

test("le rendu signale l'étape remplacée", async () => {
  const { vault, config } = await projetNeuf();
  const bilan = await appendSessionSummary(vault, config, "Serre connectée", BILAN, LE_JOUR);
  const rendu = formatRecorded(bilan);

  assert.match(rendu, /Session 1 enregistrée dans « Serre connectée » \(2026-09-01\)/);
  assert.match(rendu, /prochaine étape : Souder le capteur d'humidité/);
  assert.match(rendu, /1 décision\(s\) ajoutée\(s\)/);
  assert.match(rendu, /problèmes ouverts : 1/);
  assert.match(rendu, /Étape précédente remplacée : Définir la première étape/);
});

test("les listes de phrases restent en bloc, les listes de jetons en inline", async () => {
  const { vault, config, notePath } = await projetNeuf();

  await appendSessionSummary(vault, config, "Serre connectée", BILAN, LE_JOUR);
  await appendSessionSummary(
    vault,
    config,
    "Serre connectée",
    { ...BILAN, resolved_issues: ["L'étanchéité du boîtier n'est pas validée"], open_issues: [] },
    new Date(2026, 8, 8),
  );
  const brut = await readFile(notePath, "utf8");

  // Une liste vidée puis regarnie ne doit pas basculer en inline : des phrases
  // entières sur une ligne YAML seraient illisibles dans Obsidian.
  assert.match(brut, /resolved_issues:\n {2}- L'étanchéité du boîtier n'est pas validée/);
  assert.match(brut, /tags: \[claude\/project\]/);
  assert.match(brut, /stack: \[ESP32\]/);
});

test("des bilans concurrents sont sérialisés, aucun n'est perdu", async () => {
  const { vault, config, notePath } = await projetNeuf();

  // Le serveur MCP sert ses requêtes en parallèle : sans verrou, les trois
  // appels liraient le même session_count et deux entrées de journal
  // seraient écrasées.
  const bilans = await Promise.all(
    [1, 2, 3].map((n) =>
      appendSessionSummary(
        vault,
        config,
        "Serre connectée",
        { ...BILAN, discussed: `Session ${n}.`, new_decisions: [], open_questions: [] },
        LE_JOUR,
      ),
    ),
  );

  assert.deepEqual(
    bilans.map((bilan) => bilan.session_number).sort(),
    [1, 2, 3],
    "chaque bilan doit recevoir son propre numéro",
  );

  const brut = await readFile(notePath, "utf8");
  assert.match(brut, /session_count: 3/);
  for (const n of [1, 2, 3]) {
    assert.match(brut, new RegExp(`### Session ${n} — 2026-09-01`));
    assert.match(brut, new RegExp(`> Session ${n}\\.`));
  }
});

test("des bilans concurrents sur des projets différents n'interfèrent pas", async () => {
  const { vault, config } = await projetNeuf();
  await createProject(vault, config, { title: "Ruche", summary: "Suivi de colonie." }, LE_JOUR);

  const [serre, ruche] = await Promise.all([
    appendSessionSummary(vault, config, "Serre connectée", BILAN, LE_JOUR),
    appendSessionSummary(
      vault,
      config,
      "Ruche",
      { ...BILAN, next_step: "Peser la ruche", new_decisions: [], open_questions: [] },
      LE_JOUR,
    ),
  ]);

  assert.equal(serre!.session_number, 1);
  assert.equal(ruche!.session_number, 1);
  assert.equal(serre!.next_step, "Souder le capteur d'humidité");
  assert.equal(ruche!.next_step, "Peser la ruche");
});
