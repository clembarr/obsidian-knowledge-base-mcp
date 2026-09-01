import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  appendListItems,
  appendToSection,
  findSection,
  getSectionText,
  isProjectNote,
  listItems,
  frontmatterTags,
  parseNote,
  SectionNotFoundError,
  serializeNote,
} from "./parser.js";

/** Racine du dépôt, indépendante du répertoire courant. */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const AVANCE = path.join(REPO, "test-vault/PROJETS/Serveur domotique.md");
const FRAIS = path.join(REPO, "test-vault/PROJETS/Bot Discord club escalade.md");
const SANS_FRONTMATTER = path.join(REPO, "test-vault/PROJETS/Brouillon sans frontmatter.md");
const SANS_MARQUEUR = path.join(REPO, "test-vault/PROJETS/Veille IA.md");
const TEMPLATE = path.join(REPO, "templates/project-template.md");

const lire = (file: string) => readFile(file, "utf8");

/* ------------------------------------------------------------------ */
/* Frontmatter                                                         */
/* ------------------------------------------------------------------ */

test("relire puis réécrire une note ne change pas un seul octet", async () => {
  const fichiers = [AVANCE, FRAIS, SANS_MARQUEUR, SANS_FRONTMATTER, TEMPLATE];
  for (const fichier of fichiers) {
    const raw = await lire(fichier);
    assert.equal(serializeNote(parseNote(raw)), raw, `écart sur ${path.basename(fichier)}`);
  }
});

test("une note sans frontmatter est traversée sans dommage", async () => {
  const raw = await lire(SANS_FRONTMATTER);
  const note = parseNote(raw);

  assert.equal(note.doc, null);
  assert.equal(note.data, null);
  assert.equal(note.body, raw);
  assert.equal(isProjectNote(note.data), false);
});

test("seules les notes portant le tag projet sont reconnues", async () => {
  assert.equal(isProjectNote(parseNote(await lire(AVANCE)).data), true);
  assert.equal(isProjectNote(parseNote(await lire(FRAIS)).data), true);
  assert.equal(isProjectNote(parseNote(await lire(SANS_MARQUEUR)).data), false);
});

test("frontmatterTags accepte les trois formes admises par Obsidian", () => {
  assert.deepEqual(frontmatterTags({ tags: ["Domotique", "#claude/project"] }), [
    "domotique",
    "claude/project",
  ]);
  assert.deepEqual(frontmatterTags({ tags: "domotique, claude/project" }), [
    "domotique",
    "claude/project",
  ]);
  assert.deepEqual(frontmatterTags({ tag: ["claude/project"] }), ["claude/project"]);
  assert.deepEqual(frontmatterTags({ tags: [] }), []);
  assert.deepEqual(frontmatterTags({}), []);
  assert.deepEqual(frontmatterTags(null), []);
});

test("le tag inline du corps ne suffit pas à marquer une note", () => {
  const raw = [
    "---",
    'title: "Fausse note"',
    "tags: [veille]",
    "---",
    "",
    "#claude/project",
    "",
    "## 🎯 Vision",
    "",
    "> Une note qui cite le tag sans le déclarer.",
    "",
  ].join("\n");

  const note = parseNote(raw);
  assert.equal(isProjectNote(note.data), false, "seul le frontmatter fait foi");
  assert.ok(note.body.includes("#claude/project"), "le tag décoratif reste dans le corps");
});

test("les notes suivies portent le tag en frontmatter et en tête de corps", async () => {
  const note = parseNote(await lire(AVANCE));

  assert.ok(frontmatterTags(note.data).includes("claude/project"));
  assert.ok(note.body.startsWith("\n#claude/project\n"), "tag décoratif en tête de corps");
  // Le tag décoratif ne perturbe pas le repérage des sections.
  assert.ok(getSectionText(note.body, "vision")?.startsWith("> Reprendre le contrôle"));
});

test("modifier le frontmatter préserve commentaires et clés hors schéma", async () => {
  const note = parseNote(await lire(AVANCE));
  assert.ok(note.doc);

  note.doc.set("session_count", 4);
  note.doc.set("next_step", "Migrer le Pi sur SSD");
  const sortie = serializeNote(note);

  assert.match(sortie, /# Identité du projet/);
  assert.match(sortie, /# Suivi des problématiques/);
  assert.match(sortie, /budget: "230 €"/);
  assert.match(sortie, /session_count: 4/);
  assert.match(sortie, /next_step: "Migrer le Pi sur SSD"/);
  // Le corps est intact, séparateurs et callout compris.
  assert.match(sortie, /> \[!warning\] Le Pi tourne sur carte SD/);
  assert.equal(sortie.slice(sortie.indexOf("## 🎯 Vision")), note.body.slice(note.body.indexOf("## 🎯 Vision")));
});

test("le diff d'une écriture sans modification est vide", async () => {
  const raw = await lire(AVANCE);
  const note = parseNote(raw);
  note.doc!.set("session_count", note.data!["session_count"]);
  assert.equal(serializeNote(note), raw);
});

/* ------------------------------------------------------------------ */
/* Sections                                                            */
/* ------------------------------------------------------------------ */

test("getSectionText renvoie le contenu sans le séparateur de fin", async () => {
  const { body } = parseNote(await lire(AVANCE));

  const vision = getSectionText(body, "vision");
  assert.ok(vision);
  assert.ok(vision.startsWith("> Reprendre le contrôle du chauffage"));
  assert.ok(!vision.includes("---"));
  assert.ok(!vision.includes("## ✅"));

  const questions = getSectionText(body, "questions");
  assert.ok(questions?.includes("Node-RED"));
});

test("une section absente renvoie null plutôt que de lever", async () => {
  const { body } = parseNote(await lire(SANS_MARQUEUR));
  assert.equal(findSection(body, "vision"), null);
  assert.equal(getSectionText(body, "journal"), null);
});

test("un titre de niveau 2 dans un bloc de code ne coupe pas la section", () => {
  const body = [
    "## 🏗️ Architecture / Design actuel",
    "",
    "```md",
    "## Ceci est un exemple, pas un vrai titre",
    "```",
    "",
    "Texte qui appartient encore à la section.",
    "",
    "---",
    "",
    "## ❓ Questions ouvertes",
    "",
    "- une question",
    "",
  ].join("\n");

  const texte = getSectionText(body, "architecture");
  assert.ok(texte);
  assert.ok(texte.includes("Texte qui appartient encore à la section."));
  assert.ok(texte.includes("## Ceci est un exemple"));
  assert.ok(!texte.includes("une question"));
});

test("les sous-titres ### ne terminent pas une section", async () => {
  const { body } = parseNote(await lire(AVANCE));
  const journal = getSectionText(body, "journal");

  assert.ok(journal);
  assert.ok(journal.includes("### Session 1 — 2026-06-14"));
  assert.ok(journal.includes("### Session 3 — 2026-08-28"));
  assert.ok(!journal.includes("## ❓"));
});

test("appendToSection insère avant le séparateur et laisse la suite intacte", async () => {
  const { body, eol } = parseNote(await lire(AVANCE));
  const sortie = appendToSection(body, "journal", "### Session 4 — 2026-09-01\n\n> Couche vault.", eol);

  const journal = getSectionText(sortie, "journal")!;
  assert.ok(journal.includes("### Session 3 — 2026-08-28"));
  assert.ok(journal.endsWith("> Couche vault."), "la nouvelle entrée doit clore le journal");

  // Le séparateur et la section suivante sont préservés dans cet ordre.
  assert.match(sortie, /> Couche vault\.\n\n---\n\n## ❓ Questions ouvertes/);
  // Les sections antérieures ne bougent pas.
  assert.equal(getSectionText(sortie, "vision"), getSectionText(body, "vision"));
  assert.equal(getSectionText(sortie, "questions"), getSectionText(body, "questions"));
});

test("appendToSection alimente une section vide", async () => {
  const { body, eol } = parseNote(await lire(FRAIS));
  assert.equal(getSectionText(body, "journal"), "");

  const sortie = appendToSection(body, "journal", "### Session 1 — 2026-09-01\n\n> Cadrage.", eol);
  assert.equal(getSectionText(sortie, "journal"), "### Session 1 — 2026-09-01\n\n> Cadrage.");
  assert.match(sortie, /## 📋 Journal des sessions\n\n### Session 1/);
});

test("appendToSection lève sur une section inconnue", async () => {
  const { body } = parseNote(await lire(SANS_MARQUEUR));
  assert.throws(() => appendToSection(body, "journal", "texte"), SectionNotFoundError);
});

/* ------------------------------------------------------------------ */
/* Listes à puces                                                      */
/* ------------------------------------------------------------------ */

test("listItems lit les puces existantes", async () => {
  const { body } = parseNote(await lire(AVANCE));
  const decisions = listItems(body, "decisions");

  assert.equal(decisions.length, 4);
  assert.ok(decisions[0]?.startsWith("[2026-06-14] Home Assistant OS"));
});

test("appendListItems ignore les doublons, y compris à date différente", async () => {
  const { body, eol } = parseNote(await lire(AVANCE));
  const sortie = appendListItems(
    body,
    "decisions",
    [
      "[2026-09-01] zigbee plutôt que Z-Wave : matériel moins cher et mieux dispo",
      "[2026-09-01] Sauvegardes chiffrées sur disque externe",
    ],
    eol,
  );

  const decisions = listItems(sortie, "decisions");
  assert.equal(decisions.length, 5, "une seule décision doit être ajoutée");
  assert.ok(decisions.at(-1)?.includes("Sauvegardes chiffrées"));
});

test("appendListItems ne touche pas au fichier si rien n'est nouveau", async () => {
  const { body, eol } = parseNote(await lire(AVANCE));
  const sortie = appendListItems(
    body,
    "decisions",
    ["[2026-09-01] Dongle SkyConnect, flashé en firmware Zigbee"],
    eol,
  );
  assert.equal(sortie, body);
});

test("appendListItems remplace la puce vide du template", async () => {
  const { body, eol } = parseNote(await lire(FRAIS));
  assert.deepEqual(listItems(body, "decisions"), []);

  const sortie = appendListItems(body, "decisions", ["[2026-09-01] Bot en TypeScript"], eol);
  const section = getSectionText(sortie, "decisions")!;

  assert.equal(section, "- [2026-09-01] Bot en TypeScript");
  assert.ok(!/^\s*-\s*$/m.test(section), "la puce vide doit avoir disparu");
});

test("les insertions successives restent lisibles", async () => {
  const { body, eol } = parseNote(await lire(FRAIS));

  let sortie = appendListItems(body, "questions", ["Quel hébergement ?"], eol);
  sortie = appendListItems(sortie, "questions", ["Faut-il un mode test ?"], eol);

  assert.equal(
    getSectionText(sortie, "questions"),
    [
      "- Hébergement : VPS existant ou service gratuit ?",
      "- Quel hébergement ?",
      "- Faut-il un mode test ?",
    ].join("\n"),
  );
});
