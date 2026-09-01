/**
 * Lecture et écriture des notes projet : frontmatter YAML + sections markdown.
 *
 * Deux garanties portent tout le reste :
 *
 * 1. Le frontmatter est manipulé via l'API `Document` de `yaml`, pas via
 *    `parse`/`stringify`. Les commentaires, les clés hors schéma, les styles de
 *    quoting et les listes inline survivent donc à une écriture. Avec les
 *    options `YAML_OUTPUT`, une note relue puis réécrite sans modification est
 *    identique octet pour octet.
 * 2. Le corps markdown n'est jamais régénéré : on n'insère qu'aux points
 *    calculés, le reste du fichier est recopié tel quel.
 */

import { parseDocument, type Document } from "yaml";
import { PROJECT_TAG, SECTIONS, type SectionKey } from "../types.js";

/**
 * `lineWidth: 0` désactive le repli des lignes longues (sinon un `summary` de
 * plus de 80 colonnes serait replié à la première écriture).
 * `flowCollectionPadding: false` évite `[ a, b ]` là où l'auteur a écrit `[a, b]`.
 */
const YAML_OUTPUT = { lineWidth: 0, flowCollectionPadding: false } as const;

/** Bloc `---` … `---` en tête de fichier. Le `m` permet de gérer un frontmatter vide. */
const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m;

/** Puce de liste markdown : `- texte` ou `* texte`. */
const LIST_ITEM_RE = /^[ \t]*[-*][ \t]+(.+?)[ \t]*$/;

/** Puce vide laissée comme placeholder par le template : `- ` seul sur sa ligne. */
const EMPTY_LIST_ITEM_RE = /^[ \t]*[-*][ \t]*$/;

/** Préfixe de date que porte chaque décision validée : `[2026-09-01] …`. */
const DATE_PREFIX_RE = /^\[\d{4}-\d{2}-\d{2}\]\s*/;

export type ParsedNote = {
  /** Document YAML mutable, ou `null` si la note n'a pas de frontmatter. */
  doc: Document | null;
  /** Vue JS du frontmatter, ou `null` si absent. Lecture seule en pratique. */
  data: Record<string, unknown> | null;
  /** Corps markdown, hors bloc frontmatter. */
  body: string;
  /** Fin de ligne dominante du fichier, préservée à l'écriture. */
  eol: string;
};

export class SectionNotFoundError extends Error {
  override name = "SectionNotFoundError";
  constructor(key: SectionKey) {
    super(`Section « ${SECTIONS[key]} » absente de la note`);
  }
}

/* ------------------------------------------------------------------ */
/* Frontmatter                                                         */
/* ------------------------------------------------------------------ */

export function parseNote(raw: string): ParsedNote {
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const match = FRONTMATTER_RE.exec(raw);

  if (!match || match.index !== 0) {
    return { doc: null, data: null, body: raw, eol };
  }

  const frontmatterText = (match[1] ?? "").replace(/\r?\n$/, "");
  const doc = parseDocument(frontmatterText);
  const parsed: unknown = doc.toJS();
  const data =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;

  return { doc, data, body: raw.slice(match[0].length), eol };
}

export function serializeNote(note: ParsedNote): string {
  if (!note.doc) return note.body;

  let yaml = note.doc.toString(YAML_OUTPUT).replace(/\n+$/, "");
  if (note.eol === "\r\n") yaml = yaml.replace(/\r?\n/g, "\r\n");

  return `---${note.eol}${yaml}${note.eol}---${note.eol}${note.body}`;
}

/** Normalise un tag : sans `#`, sans espaces superflus, insensible à la casse. */
function normalizeTag(value: string): string {
  return value.trim().replace(/^#/, "").toLowerCase();
}

/**
 * Tags déclarés dans le frontmatter.
 *
 * Obsidian accepte trois formes : une liste (`tags: [a, b]`), une chaîne
 * (`tags: a, b`) et la clé historique `tag:`. Les trois sont reconnues.
 * Les `#tags` inline du corps sont volontairement ignorés : un tag cité en
 * prose marquerait la note par accident.
 */
export function frontmatterTags(data: Record<string, unknown> | null): string[] {
  if (!data) return [];

  const raw = data["tags"] ?? data["tag"];
  const values = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(/[,\s]+/)
      : [];

  return values
    .filter((value): value is string => typeof value === "string")
    .map(normalizeTag)
    .filter((tag) => tag.length > 0);
}

/** Une note n'est suivie par le MCP que si son frontmatter porte le tag projet. */
export function isProjectNote(data: Record<string, unknown> | null, tag = PROJECT_TAG): boolean {
  return frontmatterTags(data).includes(normalizeTag(tag));
}

/* ------------------------------------------------------------------ */
/* Sections                                                            */
/* ------------------------------------------------------------------ */

type Line = { text: string; start: number; nextStart: number };

/** Découpe le corps en lignes en conservant les offsets absolus. */
function toLines(body: string): Line[] {
  const lines: Line[] = [];
  let offset = 0;
  while (true) {
    const newline = body.indexOf("\n", offset);
    const end = newline === -1 ? body.length : newline;
    lines.push({
      text: body.slice(offset, end).replace(/\r$/, ""),
      start: offset,
      nextStart: newline === -1 ? body.length : newline + 1,
    });
    if (newline === -1) break;
    offset = newline + 1;
  }
  return lines;
}

export type SectionSpan = {
  /** Début de la ligne de titre. */
  headingStart: number;
  /** Début du contenu, juste après la ligne de titre. */
  contentStart: number;
  /** Fin de section : début du `##` suivant, ou fin du corps. */
  end: number;
};

/**
 * Localise une section par son titre canonique.
 *
 * Les lignes situées dans un bloc de code sont ignorées : un `## …` à
 * l'intérieur d'une clôture ``` ne termine pas une section.
 */
export function findSection(body: string, key: SectionKey): SectionSpan | null {
  const heading = SECTIONS[key];
  const lines = toLines(body);

  let inCodeFence = false;
  let headingIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*(?:```|~~~)/.test(line.text)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;

    if (headingIndex === -1) {
      if (line.text.trimEnd() === heading) headingIndex = i;
      continue;
    }
    if (line.text.startsWith("## ")) {
      return {
        headingStart: lines[headingIndex]!.start,
        contentStart: lines[headingIndex]!.nextStart,
        end: line.start,
      };
    }
  }

  if (headingIndex === -1) return null;
  return {
    headingStart: lines[headingIndex]!.start,
    contentStart: lines[headingIndex]!.nextStart,
    end: body.length,
  };
}

/**
 * Contenu textuel d'une section, séparateur `---` de fin et blancs retirés.
 * Destiné à la lecture (`get_project_context`), jamais à la réécriture.
 */
export function getSectionText(body: string, key: SectionKey): string | null {
  const span = findSection(body, key);
  if (!span) return null;
  return body
    .slice(span.contentStart, span.end)
    .replace(/(?:[ \t]*\r?\n)+---[ \t]*(?:\r?\n)*$/, "\n")
    .trim();
}

/**
 * Point d'insertion en fin de section : juste avant les lignes vides et le
 * séparateur `---` de clôture, qui doivent rester en dernier.
 */
export function sectionInsertionIndex(body: string, key: SectionKey): number | null {
  const span = findSection(body, key);
  if (!span) return null;

  const content = body.slice(span.contentStart, span.end);
  const tail = /(?:[ \t]*\r?\n)*(?:---[ \t]*(?:\r?\n)*)?$/.exec(content);
  return span.contentStart + (tail ? tail.index : content.length);
}

/** Coupe le corps au point d'insertion, blancs de jointure retirés des deux côtés. */
function splitAtSectionEnd(body: string, key: SectionKey): { before: string; after: string } {
  const index = sectionInsertionIndex(body, key);
  if (index === null) throw new SectionNotFoundError(key);

  return {
    before: body.slice(0, index).replace(/(?:[ \t]*\r?\n)+$/, ""),
    after: body.slice(index).replace(/^(?:[ \t]*\r?\n)+/, ""),
  };
}

function assemble(before: string, block: string, after: string, eol: string, glue: string): string {
  return before + glue + block + (after.length > 0 ? eol + eol + after : eol);
}

/** Ajoute un bloc markdown en fin de section, séparé par une ligne vide. */
export function appendToSection(body: string, key: SectionKey, text: string, eol = "\n"): string {
  const { before, after } = splitAtSectionEnd(body, key);
  return assemble(before, text.trim(), after, eol, eol + eol);
}

/* ------------------------------------------------------------------ */
/* Listes à puces                                                      */
/* ------------------------------------------------------------------ */

/** Puces existantes d'une section, placeholders vides exclus. */
export function listItems(body: string, key: SectionKey): string[] {
  const text = getSectionText(body, key);
  if (text === null) return [];

  const items: string[] = [];
  for (const line of text.split("\n")) {
    const match = LIST_ITEM_RE.exec(line.replace(/\r$/, ""));
    if (match?.[1]) items.push(match[1]);
  }
  return items;
}

/** Deux décisions ne diffèrent pas par leur date ni par leur casse. */
function normalizeItem(item: string): string {
  return item.replace(DATE_PREFIX_RE, "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Ajoute des puces à une section, sans doublon.
 *
 * Renvoie le corps inchangé si tout est déjà présent : une session qui ne
 * décide rien de neuf ne doit produire aucun diff.
 */
export function appendListItems(
  body: string,
  key: SectionKey,
  items: string[],
  eol = "\n",
): string {
  const span = findSection(body, key);
  if (!span) throw new SectionNotFoundError(key);

  const existing = listItems(body, key).map(normalizeItem);
  const seen = new Set(existing);
  const additions: string[] = [];

  for (const item of items) {
    const normalized = normalizeItem(item);
    if (normalized.length === 0 || seen.has(normalized)) continue;
    seen.add(normalized);
    additions.push(item.trim());
  }
  if (additions.length === 0) return body;

  // Le template pose une puce vide en placeholder : elle disparaît à la
  // première vraie entrée, plutôt que de rester au-dessus de la liste.
  let working = body;
  if (existing.length === 0) {
    const content = body.slice(span.contentStart, span.end);
    const cleaned = content
      .split("\n")
      .filter((line) => !EMPTY_LIST_ITEM_RE.test(line.replace(/\r$/, "")))
      .join("\n");
    if (cleaned !== content) {
      working = body.slice(0, span.contentStart) + cleaned + body.slice(span.end);
    }
  }

  // Une puce qui prolonge une liste existante s'y colle : une ligne vide
  // couperait la liste en deux blocs distincts au rendu markdown.
  const { before, after } = splitAtSectionEnd(working, key);
  const derniereLigne = before.slice(before.lastIndexOf("\n") + 1);
  const glue = LIST_ITEM_RE.test(derniereLigne) ? eol : eol + eol;

  return assemble(before, additions.map((item) => `- ${item}`).join(eol), after, eol, glue);
}
