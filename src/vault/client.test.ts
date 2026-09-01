import assert from "node:assert/strict";
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { FsVaultClient, VaultPathError } from "./client.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const VAULT = path.join(REPO, "test-vault");

const lecture = new FsVaultClient(VAULT);
const bacs: string[] = [];

/** Copie jetable du vault : aucun test d'écriture ne touche aux fixtures. */
async function bacASable(): Promise<FsVaultClient> {
  const dir = await mkdtemp(path.join(tmpdir(), "vault-test-"));
  bacs.push(dir);
  await cp(VAULT, dir, { recursive: true });
  return new FsVaultClient(dir);
}

after(async () => {
  for (const dir of bacs) await rm(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* Lecture et filtrage                                                 */
/* ------------------------------------------------------------------ */

test("listNotes ne remonte que les .md, récursivement", async () => {
  const notes = await lecture.listNotes();

  assert.deepEqual(notes, [
    "PROJETS/Archives/Refonte portfolio.md",
    "PROJETS/Bot Discord club escalade.md",
    "PROJETS/Brouillon sans frontmatter.md",
    "PROJETS/Serveur domotique.md",
    "PROJETS/Veille IA.md",
    "README.md",
    "RESSOURCES/Zigbee — notes de compatibilité.md",
  ]);
});

test("les notes chiffrées .mdenc sont ignorées", async () => {
  const notes = await lecture.listNotes();
  assert.ok(!notes.some((note) => note.endsWith(".mdenc")));
  assert.ok(!notes.some((note) => note.includes("Journal intime")));
});

test("listNotes se restreint au dossier demandé", async () => {
  const notes = await lecture.listNotes("PROJETS");

  assert.equal(notes.length, 5);
  assert.ok(notes.every((note) => note.startsWith("PROJETS/")));
  assert.ok(notes.includes("PROJETS/Archives/Refonte portfolio.md"), "le sous-dossier est parcouru");
  assert.ok(!notes.includes("README.md"));
});

test("un dossier absent renvoie une liste vide", async () => {
  assert.deepEqual(await lecture.listNotes("DossierInexistant"), []);
});

test("read et exists opèrent sur des chemins relatifs au vault", async () => {
  assert.equal(await lecture.exists("PROJETS/Serveur domotique.md"), true);
  assert.equal(await lecture.exists("PROJETS/Absent.md"), false);

  const contenu = await lecture.read("PROJETS/Serveur domotique.md");
  assert.match(contenu, /^---\n/);
  assert.match(contenu, /title: "Serveur domotique"/);
});

/* ------------------------------------------------------------------ */
/* Confinement au vault                                                */
/* ------------------------------------------------------------------ */

test("tout chemin sortant du vault est refusé", async () => {
  for (const chemin of ["../secret.md", "PROJETS/../../secret.md", "/etc/passwd"]) {
    assert.throws(() => lecture.resolve(chemin), VaultPathError, `accepté à tort : ${chemin}`);
  }
  await assert.rejects(() => lecture.read("../../etc/passwd"), VaultPathError);
});

test("assertVaultExists rejette un chemin qui n'est pas un dossier", async () => {
  await assert.rejects(() => new FsVaultClient(path.join(VAULT, "README.md")).assertVaultExists(), VaultPathError);
  await assert.rejects(() => new FsVaultClient(path.join(REPO, "nulle-part")).assertVaultExists(), VaultPathError);
  await lecture.assertVaultExists();
});

/* ------------------------------------------------------------------ */
/* Écriture                                                            */
/* ------------------------------------------------------------------ */

test("une écriture est relisible et ne laisse aucun fichier temporaire", async () => {
  const vault = await bacASable();
  const cible = "PROJETS/Serveur domotique.md";

  const avant = await vault.read(cible);
  await vault.write(cible, avant.replace("progress: \"60%\"", "progress: \"65%\""));

  assert.match(await vault.read(cible), /progress: "65%"/);

  const restes = await readdir(path.join(vault.root, "PROJETS"));
  assert.deepEqual(restes.filter((nom) => nom.startsWith(".") || nom.endsWith(".tmp")), []);
});

test("write crée les dossiers manquants", async () => {
  const vault = await bacASable();
  await vault.write("PROJETS/Nouveau/Sous-dossier/Projet.md", "# Projet\n");

  assert.equal(await vault.exists("PROJETS/Nouveau/Sous-dossier/Projet.md"), true);
  assert.equal(await vault.read("PROJETS/Nouveau/Sous-dossier/Projet.md"), "# Projet\n");
});

test("une écriture ne touche à aucune autre note", async () => {
  const vault = await bacASable();
  const temoin = "PROJETS/Bot Discord club escalade.md";
  const avant = await vault.read(temoin);

  await vault.write("PROJETS/Serveur domotique.md", "# remplacé\n");

  assert.equal(await vault.read(temoin), avant);
  assert.equal(
    await readFile(path.join(VAULT, temoin), "utf8"),
    avant,
    "le vault de fixtures doit rester intact",
  );
});

test("l'écriture est refusée hors du dossier projets", async () => {
  const bac = await bacASable();
  const confine = new FsVaultClient(bac.root, { writableFolder: "PROJETS" });

  // Le dossier autorisé reste accessible.
  await confine.write("PROJETS/Nouveau projet.md", "# ok\n");
  assert.equal(await confine.exists("PROJETS/Nouveau projet.md"), true);

  // Le reste de la base de connaissance est intouchable.
  for (const chemin of [
    "README.md",
    "RESSOURCES/Zigbee — notes de compatibilité.md",
    "PROJETS/../README.md",
  ]) {
    await assert.rejects(() => confine.write(chemin, "écrasé"), VaultPathError, `accepté à tort : ${chemin}`);
  }

  // Et rien n'a été touché au passage.
  assert.match(await confine.read("README.md"), /Vault de test/);
});

test("la lecture reste ouverte à tout le vault même en écriture confinée", async () => {
  const confine = new FsVaultClient(VAULT, { writableFolder: "PROJETS" });

  const ressource = await confine.read("RESSOURCES/Zigbee — notes de compatibilité.md");
  assert.match(ressource, /notes de compatibilité/);
  assert.ok((await confine.listNotes()).includes("README.md"));
});

test("l'API n'expose aucun moyen de supprimer", () => {
  const client = lecture as unknown as Record<string, unknown>;
  for (const interdit of ["delete", "remove", "unlink", "rm", "destroy"]) {
    assert.equal(typeof client[interdit], "undefined", `méthode inattendue : ${interdit}`);
  }
});
