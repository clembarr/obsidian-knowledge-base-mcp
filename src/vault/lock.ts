/**
 * Sérialisation des accès concurrents, note par note.
 *
 * Le serveur MCP sert ses requêtes en parallèle : deux bilans de session
 * envoyés coup sur coup se chevauchent, chacun lit la note avant que l'autre
 * n'écrive, et la seconde écriture écrase la première. Une file par note
 * suffit à l'empêcher, sans pénaliser les projets différents, qui continuent
 * d'être traités de front.
 *
 * La portée est le processus. Deux serveurs lancés sur le même vault — un
 * client de bureau et un terminal, par exemple — ne se voient pas ; il
 * faudrait un verrou sur le système de fichiers, dont les verrous morts
 * coûteraient plus cher que le risque qu'ils couvrent.
 */
export class KeyedMutex {
  readonly #chaines = new Map<string, Promise<unknown>>();

  /** Exécute `task`, après toutes les tâches déjà en file sur la même clé. */
  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const precedent = this.#chaines.get(key) ?? Promise.resolve();

    // `then(task, task)` : une tâche en échec ne doit pas bloquer la file
    // derrière elle, seulement remonter son erreur à son propre appelant.
    const resultat = precedent.then(task, task);
    const maillon = resultat.then(
      () => {},
      () => {},
    );
    this.#chaines.set(key, maillon);

    try {
      return await resultat;
    } finally {
      // Dernier de la file : on retire la clé pour ne pas retenir les notes
      // touchées pendant toute la vie du serveur.
      if (this.#chaines.get(key) === maillon) this.#chaines.delete(key);
    }
  }

  /** Nombre de clés en attente. Sert aux tests. */
  get size(): number {
    return this.#chaines.size;
  }
}
