import assert from "node:assert/strict";
import { test } from "node:test";

import { KeyedMutex } from "./lock.js";

/** Tâche qui note son entrée et sa sortie, pour observer les chevauchements. */
function tracee(journal: string[], nom: string, delai = 5) {
  return async () => {
    journal.push(`${nom}:debut`);
    await new Promise((resolve) => setTimeout(resolve, delai));
    journal.push(`${nom}:fin`);
    return nom;
  };
}

test("deux tâches sur la même clé ne se chevauchent pas", async () => {
  const mutex = new KeyedMutex();
  const journal: string[] = [];

  await Promise.all([
    mutex.run("note", tracee(journal, "a")),
    mutex.run("note", tracee(journal, "b")),
  ]);

  assert.deepEqual(journal, ["a:debut", "a:fin", "b:debut", "b:fin"]);
});

test("des clés différentes restent traitées de front", async () => {
  const mutex = new KeyedMutex();
  const journal: string[] = [];

  await Promise.all([
    mutex.run("une", tracee(journal, "a")),
    mutex.run("autre", tracee(journal, "b")),
  ]);

  assert.deepEqual(journal.slice(0, 2).sort(), ["a:debut", "b:debut"]);
});

test("une tâche en échec ne bloque pas la file derrière elle", async () => {
  const mutex = new KeyedMutex();

  const echec = mutex.run("note", () => Promise.reject(new Error("boum")));
  const suivante = mutex.run("note", () => Promise.resolve("ok"));

  await assert.rejects(() => echec, /boum/);
  assert.equal(await suivante, "ok");
});

test("les clés sont libérées une fois la file vidée", async () => {
  const mutex = new KeyedMutex();

  await Promise.all([mutex.run("note", async () => 1), mutex.run("note", async () => 2)]);
  assert.equal(mutex.size, 0, "aucune clé ne doit être retenue après coup");
});

test("l'ordre d'appel est l'ordre d'exécution", async () => {
  const mutex = new KeyedMutex();
  const vus: number[] = [];

  await Promise.all(
    [1, 2, 3, 4, 5].map((n) =>
      mutex.run("note", async () => {
        await new Promise((resolve) => setTimeout(resolve, 6 - n));
        vus.push(n);
      }),
    ),
  );

  assert.deepEqual(vus, [1, 2, 3, 4, 5]);
});
