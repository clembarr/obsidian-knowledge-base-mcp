/**
 * Écriture du frontmatter, sans abîmer ce que l'utilisateur a écrit à la main.
 *
 * Les helpers modifient les nœuds YAML **en place** plutôt que de les
 * remplacer : `doc.set("title", …)` construirait un nouveau scalaire et
 * perdrait ses guillemets, son style de liste ou son commentaire de fin de
 * ligne. Une note relue puis réécrite ne doit différer que des champs
 * réellement modifiés.
 */

import { isSeq, type Document, type Scalar, type YAMLSeq } from "yaml";

/** Écrit une valeur scalaire en conservant le style d'écriture existant. */
export function setScalar(doc: Document, key: string, value: string | number): void {
  const node = doc.get(key, true) as Scalar | undefined;
  if (node && typeof node === "object" && "value" in node) {
    node.value = value;
    return;
  }
  doc.set(key, value);
}

/**
 * Style d'écriture d'une liste.
 *
 * `preserve` convient aux listes de jetons courts (`tags`, `stack`), où le
 * style choisi par l'utilisateur doit survivre. `block` s'impose pour les
 * listes de phrases (`open_issues`, `sources`) : une liste vidée se sérialise
 * `[]`, et la relecture suivante la prendrait pour de l'inline — les phrases
 * s'entasseraient alors sur une seule ligne, illisible dans le volet
 * Propriétés d'Obsidian.
 */
export type SequenceStyle = "preserve" | "block";

/** Remplace le contenu d'une liste, en gardant ou en imposant son style. */
export function setSequence(
  doc: Document,
  key: string,
  values: string[],
  style: SequenceStyle = "preserve",
): void {
  const node = doc.get(key, true);
  if (isSeq(node)) {
    const seq = node as YAMLSeq;
    seq.items.length = 0;
    for (const value of values) seq.add(value);
    if (style === "block") seq.flow = false;
    return;
  }
  doc.set(key, values);
}

/**
 * Lit une liste de chaînes du frontmatter.
 *
 * Tolère la valeur unique (`open_issues: "…"`), qu'Obsidian produit quand on
 * saisit un seul élément dans le volet des propriétés.
 */
export function readSequence(data: Record<string, unknown> | null, key: string): string[] {
  const raw = data?.[key];
  const values = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}
