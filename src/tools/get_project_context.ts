/**
 * `get_project_context` — le contexte d'un projet, en un appel.
 *
 * Appelé juste après `list_projects`, c'est lui qui remplit la mémoire de la
 * conversation. Il renvoie donc l'état *courant* du projet — frontmatter,
 * vision, décisions, architecture, questions ouvertes — et **pas** le journal
 * des sessions, qui raconte l'historique et gonflerait la context window sans
 * rien apprendre d'actionnable. Le journal reste consultable dans Obsidian, et
 * la phase 2 en réinjectera un extrait borné.
 */

import { z } from "zod";

import type { Config } from "../config.js";
import { loadProjects, projectTitle, readString, type ProjectFile } from "../projects.js";
import { getSectionText } from "../vault/parser.js";
import type { SectionKey } from "../types.js";
import type { VaultClient } from "../vault/client.js";

export const GET_PROJECT_CONTEXT_DESCRIPTION = [
  "Charge le contexte d'un projet suivi : résumé, avancement, décisions validées,",
  "architecture actuelle, problèmes ouverts et questions en suspens.",
  "À appeler dès que la conversation porte sur un projet, avant de proposer quoi que ce soit.",
  "Le titre peut être approximatif dès 3 caractères : la correspondance est insensible à la casse et aux accents.",
  "Ne renvoie pas le journal des sessions, qui est de l'historique.",
].join(" ");

/** Sections renvoyées, dans l'ordre de lecture. Le journal en est volontairement absent. */
const CONTEXT_SECTIONS = [
  ["vision", "🎯 Vision"],
  ["decisions", "✅ Décisions validées"],
  ["architecture", "🏗️ Architecture / Design actuel"],
  ["questions", "❓ Questions ouvertes"],
] as const satisfies ReadonlyArray<readonly [SectionKey, string]>;

export const getProjectContextInputShape = {
  project_title: z
    .string()
    .min(1)
    .describe("Titre du projet, tel que renvoyé par list_projects. Correspondance approximative acceptée."),
};

export const getProjectContextOutputShape = {
  title: z.string(),
  path: z.string(),
  frontmatter: z.record(z.string(), z.unknown()),
  sections: z.record(z.string(), z.string()),
};

export type ProjectContext = {
  title: string;
  path: string;
  frontmatter: Record<string, unknown>;
  /** Sections présentes uniquement : une section absente de la note est omise. */
  sections: Record<string, string>;
};

export class ProjectNotFoundError extends Error {
  override name = "ProjectNotFoundError";
  constructor(query: string, readonly candidates: string[], queryLength = query.trim().length) {
    const connus =
      candidates.length > 0
        ? `Projets suivis : ${candidates.join(", ")}.`
        : "Aucun projet n'est suivi dans ce vault.";
    // Une requête trop courte n'a pas été comparée en approximatif : le dire,
    // sinon l'absence de résultat paraît contredire la liste affichée juste après.
    const trop_court =
      queryLength > 0 && queryLength < LONGUEUR_MIN_APPROXIMATIVE
        ? ` Une recherche approximative demande au moins ${LONGUEUR_MIN_APPROXIMATIVE} caractères.`
        : "";
    super(`Aucun projet ne correspond à « ${query} ».${trop_court} ${connus}`);
  }
}

export class AmbiguousProjectError extends Error {
  override name = "AmbiguousProjectError";
  constructor(query: string, readonly matches: string[]) {
    super(
      `« ${query} » correspond à plusieurs projets : ${matches.join(", ")}. ` +
        "Préciser le titre exact.",
    );
  }
}

/** Casse, accents et espaces multiples ne doivent pas faire rater un projet. */
function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Longueur minimale d'une requête pour ouvrir les passes approximatives.
 *
 * En dessous, « e » ou « ai » accrocheraient la moitié du vault : le résultat
 * serait une ambiguïté sur des projets sans rapport avec l'intention. La passe
 * exacte, elle, n'est jamais bridée — un projet nommé « Bot » ou « IA » doit
 * rester atteignable par son titre.
 */
const LONGUEUR_MIN_APPROXIMATIVE = 3;

/**
 * Retrouve un projet par son titre.
 *
 * Trois passes, de la plus stricte à la plus permissive : égalité exacte, puis
 * préfixe, puis sous-chaîne. On ne descend d'un cran que si le précédent ne
 * donne rien, pour qu'un titre exact ne soit jamais rendu ambigu par un projet
 * dont il serait le préfixe.
 */
export function findProject(projects: ProjectFile[], query: string): ProjectFile {
  const cible = normalize(query);
  const titres = projects.map((projet) => normalize(projectTitle(projet)));

  const passes = [(titre: string) => titre === cible];
  if (cible.length >= LONGUEUR_MIN_APPROXIMATIVE) {
    passes.push(
      (titre: string) => titre.startsWith(cible),
      (titre: string) => titre.includes(cible),
    );
  }

  for (const passe of passes) {
    const trouves = projects.filter((_, index) => passe(titres[index]!));
    if (trouves.length === 1) return trouves[0]!;
    if (trouves.length > 1) throw new AmbiguousProjectError(query, trouves.map(projectTitle));
  }

  throw new ProjectNotFoundError(query, projects.map(projectTitle), cible.length);
}

export async function getProjectContext(
  vault: VaultClient,
  config: Config,
  query: string,
): Promise<ProjectContext> {
  const projet = findProject(await loadProjects(vault, config), query);

  const sections: Record<string, string> = {};
  for (const [key] of CONTEXT_SECTIONS) {
    const texte = getSectionText(projet.note.body, key);
    if (texte) sections[key] = texte;
  }

  return {
    title: projectTitle(projet),
    path: projet.path,
    frontmatter: projet.data,
    sections,
  };
}

/** Liste de frontmatter rendue en puces, ou `null` si vide. */
function bulletList(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const items = value
    .map((item) => (typeof item === "string" ? item.trim() : String(item)))
    .filter((item) => item.length > 0);
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : null;
}

/** Rendu markdown destiné à être lu par le modèle : dense, sans redondance. */
export function formatContext(context: ProjectContext): string {
  const fm = context.frontmatter;
  const blocs: string[] = [];

  const etat = [readString(fm, "status"), readString(fm, "progress"), readString(fm, "current_phase")]
    .filter(Boolean)
    .join(" · ");

  const entete = [`# ${context.title}`, etat];
  const derniere = readString(fm, "last_session");
  const compte = readString(fm, "session_count");
  if (derniere) {
    entete.push(`Dernière session : ${derniere}${compte ? ` (${compte} au total)` : ""}`);
  }
  const suite = readString(fm, "next_step");
  if (suite) entete.push(`**Prochaine étape : ${suite}**`);
  entete.push(`\`${context.path}\``);
  blocs.push(entete.filter(Boolean).join("\n"));

  const resume = readString(fm, "summary");
  if (resume) blocs.push(resume);

  for (const [cle, libelle] of [
    ["stack", "Stack"],
    ["sources", "Sources"],
  ] as const) {
    const liste = bulletList(fm[cle]);
    if (liste) blocs.push(`## ${libelle}\n\n${liste}`);
  }

  for (const [cle, libelle] of [
    ["open_issues", "🔴 Problèmes ouverts"],
    ["resolved_issues", "🟢 Problèmes résolus"],
  ] as const) {
    const liste = bulletList(fm[cle]);
    if (liste) blocs.push(`## ${libelle}\n\n${liste}`);
  }

  for (const [key, titre] of CONTEXT_SECTIONS) {
    const texte = context.sections[key];
    if (texte) blocs.push(`## ${titre}\n\n${texte}`);
  }

  blocs.push(
    "---\n_Journal des sessions non inclus (historique). " +
      "Utiliser append_session_summary en fin de session pour l'alimenter._",
  );

  return blocs.join("\n\n");
}
