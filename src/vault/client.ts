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
import { access, link, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { KeyedMutex } from "./lock.js";

/** Seule extension considérée comme une note. Exclut notamment les `.mdenc` chiffrés. */
const NOTE_EXTENSION = ".md";

export interface VaultClient {
  /** Chemins de notes relatifs à la racine du vault, triés, récursifs. */
  listNotes(folder?: string): Promise<string[]>;
  read(notePath: string): Promise<string>;
  write(notePath: string, content: string): Promise<void>;
  /** Comme `write`, mais échoue si la note existe déjà. */
  create(notePath: string, content: string): Promise<void>;
  /** Lecture-modification-écriture sérialisée : deux mises à jour d'une même note ne se chevauchent pas. */
  update<T>(notePath: string, transform: NoteTransform<T>): Promise<T>;
  exists(notePath: string): Promise<boolean>;
}

/** Nouveau contenu de la note, et ce que l'appelant veut retirer de l'opération. */
export type NoteUpdate<T> = { content: string; value: T };

export type NoteTransform<T> = (raw: string) => NoteUpdate<T> | Promise<NoteUpdate<T>>;

/** Chemin sortant du vault, ou vault introuvable. */
export class VaultPathError extends Error {
  override name = "VaultPathError";
}

/** `create` sur une note déjà présente. */
export class NoteExistsError extends Error {
  override name = "NoteExistsError";
  constructor(readonly notePath: string) {
    super(`La note existe déjà : ${notePath}`);
  }
}

export type FsVaultOptions = {
  /**
   * Dossier, relatif au vault, seul autorisé en écriture. Par défaut le vault
   * entier. Le passer restreint physiquement la casse : le reste de la base de
   * connaissance devient inatteignable, même par un tool qui s'égarerait.
   */
  writableFolder?: string;
};

export class FsVaultClient implements VaultClient {
  readonly root: string;
  /** Racine autorisée en écriture. La lecture, elle, couvre tout le vault. */
  readonly writableRoot: string;
  /** Une file d'attente par note, pour les mises à jour. */
  readonly #locks = new KeyedMutex();

  constructor(vaultPath: string, options: FsVaultOptions = {}) {
    this.root = path.resolve(vaultPath);
    this.writableRoot = options.writableFolder ? this.resolve(options.writableFolder) : this.root;
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

  /** Comme `resolve`, mais refuse aussi tout ce qui sort du dossier accessible en écriture. */
  resolveWritable(notePath: string): string {
    const absolute = this.resolve(notePath);
    const relative = path.relative(this.writableRoot, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new VaultPathError(
        `Écriture refusée hors du dossier projets (${path.relative(this.root, this.writableRoot) || "."}) : ${notePath}`,
      );
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

  /** Écriture atomique, création ou remplacement. */
  async write(notePath: string, content: string): Promise<void> {
    await this.#stage(notePath, content, (temp, absolute) => rename(temp, absolute));
  }

  /**
   * Création exclusive : `link` échoue avec EEXIST si la cible existe déjà.
   *
   * Le contrôle est fait par le noyau, au moment même de la publication du
   * fichier. Un `exists()` préalable, lui, laisserait une fenêtre entre la
   * vérification et l'écriture — les requêtes MCP étant servies en parallèle,
   * deux créations simultanées du même projet s'y engouffreraient et la
   * seconde écraserait la première.
   */
  async create(notePath: string, content: string): Promise<void> {
    await this.#stage(notePath, content, async (temp, absolute) => {
      try {
        await link(temp, absolute);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new NoteExistsError(notePath);
        }
        throw error;
      }
    });
  }

  /**
   * Écrit dans un fichier temporaire du même dossier, puis le publie.
   *
   * La publication se faisant sur le même système de fichiers, elle est
   * atomique : une note ouverte dans Obsidian ne peut jamais être observée à
   * moitié écrite, même si le processus meurt en cours de route.
   */
  async #stage(
    notePath: string,
    content: string,
    publish: (temp: string, absolute: string) => Promise<void>,
  ): Promise<void> {
    const absolute = this.resolveWritable(notePath);
    const dir = path.dirname(absolute);
    await mkdir(dir, { recursive: true });

    // Préfixe `.` : invisible pour Obsidian comme pour `listNotes`.
    const temp = path.join(dir, `.${path.basename(absolute)}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      await writeFile(temp, content, "utf8");
      await publish(temp, absolute);
    } finally {
      // Après `rename` le temporaire n'existe plus ; après `link` il reste à retirer.
      await rm(temp, { force: true });
    }
  }

  /**
   * Met à jour une note sous verrou : personne d'autre ne peut la lire pour
   * la réécrire tant que la transformation n'a pas été publiée.
   *
   * C'est ce qui rend sûr un `append` : sans cela, deux appels concurrents
   * liraient le même `session_count` et produiraient deux fois la session 3,
   * la seconde écriture perdant l'entrée de journal de la première.
   */
  async update<T>(notePath: string, transform: NoteTransform<T>): Promise<T> {
    // Résolu hors du verrou : un chemin invalide doit échouer tout de suite.
    const absolute = this.resolveWritable(notePath);

    return this.#locks.run(absolute, async () => {
      const { content, value } = await transform(await this.read(notePath));
      await this.write(notePath, content);
      return value;
    });
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
