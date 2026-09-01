/**
 * `create_project` — ouvre une nouvelle note projet à partir du template.
 *
 * Le fichier est construit en *remplissant* `templates/project-template.md`,
 * pas en concaténant des chaînes : commentaires YAML, ordre des clés et styles
 * d'écriture du template sont donc ce que l'utilisateur retrouve dans Obsidian,
 * et faire évoluer le template suffit à faire évoluer les notes créées.
 *
 * Une création n'écrase jamais rien : un chemin déjà pris ou un titre déjà
 * utilisé est une erreur, jamais un remplacement.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import type { Config } from "../config.js";
import { loadProjects, projectTitle } from "../projects.js";
import { PROJECT_TAG, SECTIONS } from "../types.js";
import { NoteExistsError, type VaultClient } from "../vault/client.js";
import { setScalar, setSequence } from "../vault/frontmatter.js";
import { findSection, parseNote, serializeNote } from "../vault/parser.js";

const TEMPLATE_PATH = fileURLToPath(new URL("../../templates/project-template.md", import.meta.url));

/** Caractères refusés par Obsidian dans un nom de fichier. */
const CARACTERES_INTERDITS = /[\\/:*?"<>|#^[\]]/g;

export const CREATE_PROJECT_DESCRIPTION = [
  "Crée une nouvelle note projet dans le vault Obsidian, à partir du template.",
  "À utiliser quand l'utilisateur démarre un projet qui n'existe pas encore dans list_projects.",
  "La note est immédiatement suivie : les sessions suivantes la retrouveront automatiquement.",
  "N'écrase jamais une note existante.",
].join(" ");

export const createProjectInputShape = {
  title: z.string().min(1).describe("Titre du projet. Sert aussi de nom de fichier."),
  summary: z
    .string()
    .min(1)
    .describe("Description du projet en une ou deux phrases. Alimente le frontmatter et la section Vision."),
  stack: z
    .array(z.string())
    .default([])
    .describe("Technologies, outils ou matériel envisagés. Liste vide si rien n'est arrêté."),
  next_step: z
    .string()
    .optional()
    .describe("Première action concrète à faire. C'est le champ que l'utilisateur relira en premier."),
};

export const createProjectOutputShape = {
  title: z.string(),
  path: z.string(),
  created: z.string(),
};

export type CreateProjectInput = {
  title: string;
  summary: string;
  stack?: string[];
  next_step?: string;
};

export type CreatedProject = { title: string; path: string; created: string };

export class ProjectExistsError extends Error {
  override name = "ProjectExistsError";
  constructor(readonly title: string, readonly path: string) {
    super(
      `Un projet nommé « ${title} » existe déjà (${path}). ` +
        "Utiliser get_project_context pour le charger, ou choisir un autre titre.",
    );
  }
}

export class InvalidTitleError extends Error {
  override name = "InvalidTitleError";
  constructor(title: string) {
    super(
      `« ${title} » ne donne aucun nom de fichier valide : le titre doit contenir ` +
        "au moins un caractère accepté par Obsidian.",
    );
  }
}

/** Date du jour au format YYYY-MM-DD, en heure locale. */
export function today(now = new Date()): string {
  const deuxChiffres = (valeur: number) => String(valeur).padStart(2, "0");
  return `${now.getFullYear()}-${deuxChiffres(now.getMonth() + 1)}-${deuxChiffres(now.getDate())}`;
}

/** Nom de fichier dérivé du titre : caractères interdits retirés, espaces normalisés. */
export function fileNameFor(title: string): string {
  const nettoye = title
    .replace(CARACTERES_INTERDITS, " ")
    .replace(/\s+/g, " ")
    // Un point ou un tiret en tête cacherait la note ou la ferait passer pour une option.
    .replace(/^[.\-\s]+/, "")
    .trim();

  if (nettoye.length === 0) throw new InvalidTitleError(title);
  return `${nettoye}.md`;
}

/**
 * Vide une section de ses exemples et y met le texte donné.
 *
 * Le template porte des placeholders (`- [YYYY-MM-DD] …`, `### Session 1 — …`)
 * qui guident la lecture humaine mais n'ont pas leur place dans une note
 * fraîchement créée : ils feraient double emploi avec la première vraie entrée
 * qu'écrira `append_session_summary`.
 */
function replaceSection(body: string, key: keyof typeof SECTIONS, content: string, eol: string): string {
  const span = findSection(body, key);
  if (!span) return body;

  const ancien = body.slice(span.contentStart, span.end);
  // Le séparateur `---` de fin de section, lui, fait partie de la mise en page.
  const separateur = /(?:^|\n)---[ \t]*\s*$/.test(ancien) ? `${eol}---${eol}${eol}` : eol;
  const bloc = content.trim();

  return (
    body.slice(0, span.contentStart) +
    (bloc ? `${eol}${bloc}${eol}` : "") +
    separateur +
    body.slice(span.end)
  );
}

export async function createProject(
  vault: VaultClient,
  config: Config,
  input: CreateProjectInput,
  now = new Date(),
): Promise<CreatedProject> {
  const title = input.title.trim();
  const date = today(now);
  const notePath = path.posix.join(config.projectsFolder, fileNameFor(title));

  // Contrôle de courtoisie : il donne un message utile avant tout travail.
  // La garantie, elle, est portée par `vault.create` plus bas.
  if (await vault.exists(notePath)) {
    throw new ProjectExistsError(title, notePath);
  }
  // Un homonyme rangé ailleurs rendrait get_project_context ambigu à vie.
  const existant = (await loadProjects(vault, config)).find(
    (projet) => projectTitle(projet).toLowerCase() === title.toLowerCase(),
  );
  if (existant) throw new ProjectExistsError(title, existant.path);

  const note = parseNote(await readFile(TEMPLATE_PATH, "utf8"));
  if (!note.doc) {
    throw new Error(`Template illisible : frontmatter absent de ${TEMPLATE_PATH}`);
  }

  setScalar(note.doc, "title", title);
  setScalar(note.doc, "status", "idée");
  setScalar(note.doc, "created", date);
  setScalar(note.doc, "last_session", date);
  setScalar(note.doc, "progress", "0%");
  setScalar(note.doc, "current_phase", "Phase 1 — Cadrage");
  setScalar(note.doc, "summary", input.summary.trim());
  setScalar(note.doc, "session_count", 0);
  setScalar(note.doc, "next_step", input.next_step?.trim() || "Définir la première étape");

  setSequence(note.doc, "stack", input.stack ?? []);
  setSequence(note.doc, "sources", [], "block");
  setSequence(note.doc, "open_issues", [], "block");
  setSequence(note.doc, "resolved_issues", [], "block");
  // Le tag du template est conservé ; un vault qui en configure un autre le reçoit ici.
  if (config.projectTag !== PROJECT_TAG) setSequence(note.doc, "tags", [config.projectTag]);

  // La vision démarre sur le résumé fourni : une note créée n'est jamais vide.
  note.body = replaceSection(note.body, "vision", `> ${input.summary.trim()}`, note.eol);
  note.body = replaceSection(note.body, "decisions", "", note.eol);
  note.body = replaceSection(note.body, "journal", "", note.eol);
  note.body = replaceSection(note.body, "questions", "", note.eol);

  try {
    await vault.create(notePath, serializeNote(note));
  } catch (error) {
    if (error instanceof NoteExistsError) throw new ProjectExistsError(title, notePath);
    throw error;
  }
  return { title, path: notePath, created: date };
}

export function formatCreated(projet: CreatedProject): string {
  return [
    `Projet « ${projet.title} » créé.`,
    "",
    `- fichier : \`${projet.path}\``,
    `- créé le : ${projet.created}`,
    "",
    "La note est suivie dès maintenant : les prochaines conversations la retrouveront " +
      "via list_projects. Appeler append_session_summary en fin de session pour l'alimenter.",
  ].join("\n");
}
