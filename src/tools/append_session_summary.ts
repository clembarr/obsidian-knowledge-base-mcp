/**
 * `append_session_summary` — referme la boucle de mémoire inter-sessions.
 *
 * Appelé en fin de conversation, il grave dans la note ce que la session a
 * produit : le frontmatter porte l'état courant (celui que relira
 * `list_projects`), le journal porte le récit, et les sections Décisions et
 * Questions accumulent ce qui a été tranché ou soulevé.
 *
 * Deux règles gouvernent les écritures :
 *
 * 1. **Rien n'est jamais supprimé.** Un problème ne quitte `open_issues` qu'en
 *    étant explicitement déclaré résolu, jamais par omission — un modèle qui
 *    oublierait de relister un problème ne doit pas pouvoir l'effacer.
 * 2. **Le corps n'est pas régénéré.** On n'insère qu'aux points calculés par le
 *    parser ; le reste du markdown est recopié tel quel.
 */

import { z } from "zod";

import type { Config } from "../config.js";
import { loadProjects, projectTitle, readString } from "../projects.js";
import type { VaultClient } from "../vault/client.js";
import { readSequence, setScalar, setSequence } from "../vault/frontmatter.js";
import {
  appendListItems,
  appendToSection,
  ensureSection,
  normalizeItem,
  parseNote,
  serializeNote,
} from "../vault/parser.js";
import { findProject } from "./get_project_context.js";
import { today } from "./create_project.js";

export const APPEND_SESSION_SUMMARY_DESCRIPTION = [
  "Enregistre le bilan de la session en cours dans la note du projet.",
  "À appeler en fin de conversation, ou dès qu'une étape importante est franchie.",
  "Met à jour l'avancement et la prochaine étape, ajoute une entrée au journal,",
  "et reporte les décisions prises, les problèmes résolus et ceux encore ouverts.",
  "Un problème n'est retiré de la liste des problèmes ouverts que s'il est déclaré résolu.",
].join(" ");

const sessionSummarySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Format attendu : YYYY-MM-DD")
    .optional()
    .describe("Date de la session au format YYYY-MM-DD. Par défaut, aujourd'hui."),
  discussed: z
    .string()
    .min(1)
    .describe("Ce qui a été discuté, décidé et produit pendant la session. Quelques phrases."),
  new_decisions: z
    .array(z.string())
    .default([])
    .describe("Décisions arrêtées pendant la session. Elles seront datées automatiquement."),
  resolved_issues: z
    .array(z.string())
    .default([])
    .describe("Problèmes clos pendant la session. Seul moyen de les sortir des problèmes ouverts."),
  open_issues: z
    .array(z.string())
    .default([])
    .describe("Problèmes nouvellement identifiés. Les problèmes déjà connus restent ouverts sans être relistés."),
  open_questions: z
    .array(z.string())
    .default([])
    .describe("Questions de conception encore en suspens, ajoutées à la section Questions ouvertes."),
  next_step: z
    .string()
    .min(1)
    .describe("Première action concrète à la prochaine session. Le champ le plus relu de la note."),
  progress: z
    .string()
    .optional()
    .describe("Avancement estimé, ex. « 40% ». Inchangé si absent."),
  current_phase: z.string().optional().describe("Phase en cours. Inchangée si absente."),
});

export type SessionSummaryInput = z.infer<typeof sessionSummarySchema>;

export const appendSessionSummaryInputShape = {
  project_title: z.string().min(1).describe("Titre du projet, tel que renvoyé par list_projects."),
  summary: sessionSummarySchema,
};

export const appendSessionSummaryOutputShape = {
  title: z.string(),
  path: z.string(),
  session_number: z.number(),
  date: z.string(),
  next_step: z.string(),
  open_issues: z.array(z.string()),
  resolved_issues: z.array(z.string()),
  added_decisions: z.number(),
  added_questions: z.number(),
  previous_next_step: z.string(),
};

export type SessionRecorded = {
  title: string;
  path: string;
  session_number: number;
  date: string;
  next_step: string;
  open_issues: string[];
  resolved_issues: string[];
  added_decisions: number;
  added_questions: number;
  /** Étape visée avant ce bilan, pour rendre visible ce qui a été remplacé. */
  previous_next_step: string;
};

/** Concatène sans doublon, en gardant la première graphie rencontrée. */
function union(...listes: string[][]): string[] {
  const vus = new Set<string>();
  const resultat: string[] = [];
  for (const item of listes.flat()) {
    const cle = normalizeItem(item);
    if (cle.length === 0 || vus.has(cle)) continue;
    vus.add(cle);
    resultat.push(item.trim());
  }
  return resultat;
}

/** Retire d'une liste les éléments présents dans une autre, à la normalisation près. */
function without(liste: string[], retires: string[]): string[] {
  const exclus = new Set(retires.map(normalizeItem));
  return liste.filter((item) => !exclus.has(normalizeItem(item)));
}

/** Entrée de journal : un titre de session et le récit en citation. */
function journalEntry(numero: number, date: string, discussed: string): string {
  const citation = discussed
    .trim()
    .split(/\r?\n/)
    .map((ligne) => (ligne.trim().length > 0 ? `> ${ligne.trim()}` : ">"))
    .join("\n");
  return `### Session ${numero} — ${date}\n\n${citation}`;
}

export async function appendSessionSummary(
  vault: VaultClient,
  config: Config,
  query: string,
  summary: SessionSummaryInput,
  now = new Date(),
): Promise<SessionRecorded> {
  const projet = findProject(await loadProjects(vault, config), query);

  // Relecture depuis le disque : la note peut avoir changé dans Obsidian entre
  // le get_project_context du début de session et ce bilan de fin.
  const note = parseNote(await vault.read(projet.path));
  if (!note.doc) throw new Error(`Frontmatter absent de ${projet.path}`);

  const date = summary.date ?? today(now);
  const etapePrecedente = readString(note.data ?? {}, "next_step");
  const compte = Number(note.data?.["session_count"] ?? 0);
  const numero = (Number.isFinite(compte) ? compte : 0) + 1;

  /* --- Frontmatter : l'état courant, celui que relit list_projects --- */

  const resolus = union(readSequence(note.data, "resolved_issues"), summary.resolved_issues);
  const ouverts = without(
    union(readSequence(note.data, "open_issues"), summary.open_issues),
    summary.resolved_issues,
  );

  setScalar(note.doc, "last_session", date);
  setScalar(note.doc, "next_step", summary.next_step.trim());
  setScalar(note.doc, "session_count", numero);
  if (summary.progress) setScalar(note.doc, "progress", summary.progress.trim());
  if (summary.current_phase) setScalar(note.doc, "current_phase", summary.current_phase.trim());
  setSequence(note.doc, "open_issues", ouverts, "block");
  setSequence(note.doc, "resolved_issues", resolus, "block");

  /* --- Corps : le récit et ce qui s'accumule --- */

  let body = note.body;
  for (const section of ["journal", "decisions", "questions"] as const) {
    body = ensureSection(body, section, note.eol);
  }

  body = appendToSection(body, "journal", journalEntry(numero, date, summary.discussed), note.eol);

  // Les décisions sont datées à l'écriture : la liste se lit comme une frise.
  const avantDecisions = body;
  body = appendListItems(
    body,
    "decisions",
    summary.new_decisions.map((decision) => `[${date}] ${decision.trim()}`),
    note.eol,
  );
  const decisionsAjoutees = body === avantDecisions ? 0 : summary.new_decisions.length;

  const avantQuestions = body;
  body = appendListItems(body, "questions", summary.open_questions, note.eol);
  const questionsAjoutees = body === avantQuestions ? 0 : summary.open_questions.length;

  note.body = body;
  await vault.write(projet.path, serializeNote(note));

  return {
    title: projectTitle(projet),
    path: projet.path,
    session_number: numero,
    date,
    next_step: summary.next_step.trim(),
    open_issues: ouverts,
    resolved_issues: resolus,
    added_decisions: decisionsAjoutees,
    added_questions: questionsAjoutees,
    previous_next_step: etapePrecedente,
  };
}

export function formatRecorded(bilan: SessionRecorded): string {
  const lignes = [
    `Session ${bilan.session_number} enregistrée dans « ${bilan.title} » (${bilan.date}).`,
    "",
    `- prochaine étape : ${bilan.next_step}`,
  ];

  if (bilan.added_decisions > 0) {
    lignes.push(`- ${bilan.added_decisions} décision(s) ajoutée(s) et datée(s)`);
  }
  if (bilan.added_questions > 0) {
    lignes.push(`- ${bilan.added_questions} question(s) ouverte(s) ajoutée(s)`);
  }
  lignes.push(
    `- problèmes ouverts : ${bilan.open_issues.length}`,
    `- problèmes résolus : ${bilan.resolved_issues.length}`,
    `- fichier : \`${bilan.path}\``,
  );
  if (bilan.previous_next_step && bilan.previous_next_step !== bilan.next_step) {
    lignes.push("", `_Étape précédente remplacée : ${bilan.previous_next_step}_`);
  }
  return lignes.join("\n");
}
