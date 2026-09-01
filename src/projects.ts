/**
 * Chargement des notes projet.
 *
 * Le double filtre du brief est appliqué ici, et nulle part ailleurs : une note
 * n'est suivie que si elle est **dans le dossier projets** *et* qu'elle porte le
 * **tag projet** dans son frontmatter. Une note rangée au bon endroit sans tag
 * reste invisible pour le MCP, ce qui laisse la décision à l'utilisateur.
 */

import path from "node:path";

import type { Config } from "./config.js";
import type { VaultClient } from "./vault/client.js";
import { isProjectNote, parseNote, type ParsedNote } from "./vault/parser.js";

export type ProjectFile = {
  /** Chemin relatif au vault. */
  path: string;
  note: ParsedNote;
  /** Frontmatter de la note ; jamais `null` pour un projet, qui porte un tag. */
  data: Record<string, unknown>;
};

/** Titre affichable : le champ `title`, à défaut le nom du fichier. */
export function projectTitle(file: ProjectFile): string {
  const title = file.data["title"];
  if (typeof title === "string" && title.trim().length > 0) return title.trim();
  return path.basename(file.path, path.extname(file.path));
}

/** Lit un champ de frontmatter comme chaîne, avec valeur de repli. */
export function readString(data: Record<string, unknown>, key: string, fallback = ""): string {
  const value = data[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

/** Toutes les notes projet du vault, triées de la plus récemment travaillée à la plus ancienne. */
export async function loadProjects(vault: VaultClient, config: Config): Promise<ProjectFile[]> {
  const paths = await vault.listNotes(config.projectsFolder);
  const projects: ProjectFile[] = [];

  for (const notePath of paths) {
    let note: ParsedNote;
    try {
      note = parseNote(await vault.read(notePath));
    } catch {
      continue; // une note illisible ne doit pas faire tomber la liste entière
    }
    if (!isProjectNote(note.data, config.projectTag)) continue;
    projects.push({ path: notePath, note, data: note.data ?? {} });
  }

  return projects.sort((a, b) => {
    const parA = readString(a.data, "last_session");
    const parB = readString(b.data, "last_session");
    if (parA !== parB) return parB.localeCompare(parA); // dates ISO : ordre lexicographique
    return projectTitle(a).localeCompare(projectTitle(b), "fr");
  });
}
