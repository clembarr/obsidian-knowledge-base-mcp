/** Configuration du serveur, lue dans l'environnement au démarrage. */

import { PROJECT_TAG } from "./types.js";

export type Config = {
  /** Racine du vault Obsidian. */
  vaultPath: string;
  /** Dossier des notes projet, relatif au vault. Seul dossier accessible en écriture. */
  projectsFolder: string;
  /** Tag qui identifie une note suivie. */
  projectTag: string;
};

export class ConfigError extends Error {
  override name = "ConfigError";
}

const DEFAULT_PROJECTS_FOLDER = "PROJETS";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const vaultPath = env["VAULT_PATH"]?.trim();
  if (!vaultPath) {
    throw new ConfigError(
      "VAULT_PATH n'est pas défini. Indiquez le chemin absolu du vault Obsidian " +
        "dans la configuration du serveur MCP.",
    );
  }

  return {
    vaultPath,
    projectsFolder: env["VAULT_PROJECTS_FOLDER"]?.trim() || DEFAULT_PROJECTS_FOLDER,
    projectTag: env["CLAUDE_PROJECT_TAG"]?.trim() || PROJECT_TAG,
  };
}
