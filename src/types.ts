/** Types partagés du MCP Obsidian ↔ Claude. */

/**
 * Tag qui identifie une note suivie par le MCP.
 *
 * Un tag Obsidian plutôt qu'une clé maison : il participe à la recherche, au
 * graphe, à Dataview et au volet Tags, et se pose depuis l'interface sans
 * éditer de YAML. Imbriqué sous `claude/` pour ne pas polluer la taxonomie
 * thématique du vault.
 *
 * La détection ne lit que le frontmatter. Le même tag est aussi posé en tête
 * de corps à la création, pour la mise en valeur des extensions Obsidian, mais
 * cette occurrence-là est décorative : elle ne rend pas une note suivie.
 */
export const PROJECT_TAG = "claude/project";

/** Frontmatter d'un fichier projet (cf. templates/project-template.md). */
export type ProjectFrontmatter = {
  title: string;
  status: string;
  created: string;
  last_session: string;
  tags: string[];
  progress: string;
  current_phase: string;
  next_step: string;
  summary: string;
  stack: string[];
  sources: string[];
  open_issues: string[];
  resolved_issues: string[];
  session_count: number;
  /** Toute clé ajoutée à la main dans le vault est préservée telle quelle. */
  [key: string]: unknown;
};

/** Ce que `list_projects` renvoie pour chaque projet. */
export type ProjectListEntry = {
  title: string;
  path: string;
  status: string;
  last_session: string;
  next_step: string;
  progress: string;
};

/** Un fichier projet lu depuis le vault : frontmatter + corps markdown brut. */
export type ProjectNote = {
  path: string;
  frontmatter: ProjectFrontmatter;
  /** Corps markdown, hors bloc frontmatter. Préservé octet pour octet. */
  body: string;
  /** Contenu complet d'origine, tel que lu dans le vault. */
  raw: string;
};

/** Résumé d'une session, produit par Claude en fin de conversation. */
export type SessionSummary = {
  /** YYYY-MM-DD */
  date: string;
  discussed: string;
  new_decisions: string[];
  resolved_issues: string[];
  open_issues: string[];
  next_step: string;
  /** ex: "40%" */
  progress: string;
  current_phase: string;
};

/** Titres de sections canoniques du template. */
export const SECTIONS = {
  vision: "## 🎯 Vision",
  decisions: "## ✅ Décisions validées",
  architecture: "## 🏗️ Architecture / Design actuel",
  journal: "## 📋 Journal des sessions",
  questions: "## ❓ Questions ouvertes",
} as const;

export type SectionKey = keyof typeof SECTIONS;
