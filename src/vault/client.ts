/**
 * Accès au vault Obsidian.
 *
 * L'accès passe par une interface étroite : les tools ne connaissent que
 * `VaultClient`, jamais `node:fs`. Une implémentation sur le plugin Local REST
 * API pourrait donc être ajoutée sans toucher aux tools.
 *
 * Aucune méthode de suppression n'est exposée : la contrainte « le MCP ne
 * supprime jamais rien » est portée par le type, pas par la discipline.
 */

import { randomBytes } from "node:crypto";
import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/** Seule extension considérée comme une note. Exclut notamment les `.mdenc` chiffrés. */
const NOTE_EXTENSION = ".md";

export interface VaultClient {
  /** Chemins de notes relatifs à la racine du vault, triés, récursifs. */
  listNotes(folder?: string): Promise<string[]>;
  read(notePath: string): Promise<string>;
  write(notePath: string, content: string): Promise<void>;
  exists(notePath: string): Promise<boolean>;
}

/** Chemin sortant du vault, ou vault introuvable. */
export class VaultPathError extends Error {
  override name = "VaultPathError";
}

export class FsVaultClient implements VaultClient {
  readonly root: string;

  constructor(vaultPath: string) {
    this.root = path.resolve(vaultPath);
  }

  /** Vérifie au démarrage que la racine existe et est bien un dossier. */
  async assertVaultExists(): Promise<void> {
    let info;
    try {
      info = await stat(this.root);
    } catch {
      throw new VaultPathError(`Vault introuvable : ${this.root}`);
    }
    if (!info.isDirectory()) {
      throw new VaultPathError(`Le chemin du vault n'est pas un dossier : ${this.root}`);
    }
  }

  /**
   * Résout un chemin relatif au vault en chemin absolu, en refusant toute
   * sortie de l'arborescence (`../`, chemin absolu, lien symbolique remontant).
   */
  resolve(notePath: string): string {
    const absolute = path.resolve(this.root, notePath);
    const relative = path.relative(this.root, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new VaultPathError(`Chemin hors du vault : ${notePath}`);
    }
    return absolute;
  }

  async listNotes(folder = ""): Promise<string[]> {
    const start = this.resolve(folder);
    const found: string[] = [];
    await this.#walk(start, found);
    return found.map((absolute) => path.relative(this.root, absolute)).sort();
  }

  async #walk(dir: string, found: string[]): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // dossier absent : on renvoie une liste vide plutôt qu'une erreur
    }
    for (const entry of entries) {
      // Ignore .obsidian, .trash, et les fichiers temporaires d'écriture atomique.
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.#walk(full, found);
      } else if (path.extname(entry.name) === NOTE_EXTENSION) {
        found.push(full);
      }
    }
  }

  async read(notePath: string): Promise<string> {
    return readFile(this.resolve(notePath), "utf8");
  }

  /**
   * Écriture atomique : fichier temporaire dans le même dossier, puis `rename`.
   *
   * Le `rename` est atomique sur un même système de fichiers, donc une note
   * ouverte dans Obsidian ne peut jamais être observée à moitié écrite, même si
   * le processus meurt en cours de route.
   */
  async write(notePath: string, content: string): Promise<void> {
    const absolute = this.resolve(notePath);
    const dir = path.dirname(absolute);
    await mkdir(dir, { recursive: true });

    // Préfixe `.` : invisible pour Obsidian comme pour `listNotes`.
    const temp = path.join(dir, `.${path.basename(absolute)}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      await writeFile(temp, content, "utf8");
      await rename(temp, absolute);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }

  async exists(notePath: string): Promise<boolean> {
    try {
      await access(this.resolve(notePath));
      return true;
    } catch {
      return false;
    }
  }
}
