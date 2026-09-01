/**
 * `list_projects` — inventaire des projets suivis.
 *
 * Premier appel d'une session : il donne la carte de ce qui est en cours, sans
 * charger le contenu des notes. Le détail d'un projet se demande ensuite avec
 * `get_project_context`.
 */

import { z } from "zod";

import type { Config } from "../config.js";
import { loadProjects, projectTitle, readString } from "../projects.js";
import type { ProjectListEntry } from "../types.js";
import type { VaultClient } from "../vault/client.js";

export const LIST_PROJECTS_DESCRIPTION = [
  "Liste les projets suivis dans le vault Obsidian, du plus récemment travaillé au plus ancien.",
  "Renvoie pour chacun : titre, statut, avancement, date de dernière session et prochaine étape.",
  "À appeler en début de conversation pour retrouver l'état des travaux en cours.",
  "Ne renvoie pas le contenu des notes : utiliser get_project_context pour un projet précis.",
].join(" ");

export const listProjectsOutputShape = {
  projects: z.array(
    z.object({
      title: z.string(),
      path: z.string(),
      status: z.string(),
      last_session: z.string(),
      next_step: z.string(),
      progress: z.string(),
    }),
  ),
};

export async function listProjects(vault: VaultClient, config: Config): Promise<ProjectListEntry[]> {
  const projects = await loadProjects(vault, config);

  return projects.map((file) => ({
    title: projectTitle(file),
    path: file.path,
    status: readString(file.data, "status"),
    last_session: readString(file.data, "last_session"),
    next_step: readString(file.data, "next_step"),
    progress: readString(file.data, "progress"),
  }));
}

/** Rendu compact : lisible par un humain, économe en tokens pour le modèle. */
export function formatProjects(entries: ProjectListEntry[], config: Config): string {
  if (entries.length === 0) {
    return [
      `Aucun projet suivi dans « ${config.projectsFolder} ».`,
      "",
      `Une note est suivie si elle se trouve dans ce dossier **et** porte le tag \`${config.projectTag}\` dans son frontmatter.`,
      "Utiliser create_project pour en démarrer un.",
    ].join("\n");
  }

  const lignes = entries.map((entry) => {
    const etat = [entry.status, entry.progress].filter(Boolean).join(" · ");
    const entete = etat ? `**${entry.title}** — ${etat}` : `**${entry.title}**`;
    const details = [
      entry.last_session ? `dernière session : ${entry.last_session}` : null,
      entry.next_step ? `prochaine étape : ${entry.next_step}` : null,
    ].filter(Boolean);

    return [`- ${entete}`, ...details.map((detail) => `  ${detail}`), `  \`${entry.path}\``].join("\n");
  });

  const titre = entries.length === 1 ? "1 projet suivi." : `${entries.length} projets suivis.`;
  return [titre, "", ...lignes].join("\n");
}
