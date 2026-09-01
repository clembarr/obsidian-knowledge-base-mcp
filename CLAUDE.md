# Obsidian Claude MCP — Brief Claude Code

## Contexte du projet

Construire un MCP (Model Context Protocol) local qui joue le rôle de pont entre
Obsidian (base de connaissance personnelle en markdown) et Claude. L'objectif est
de résoudre le problème de mémoire inter-sessions : à chaque nouvelle conversation,
Claude reçoit automatiquement le contexte du projet en cours, sans que l'utilisateur
ait à tout réexpliquer.

L'utilisateur est ADHD, a tendance à perdre le fil entre les sessions, et veut un
système entièrement automatique — zéro friction, zéro écriture manuelle.

---

## Décisions d'architecture validées

- **Stack** : TypeScript (MCP SDK officiel Anthropic) ou Python (mcp lib)
- **Stockage** : fichiers `.md` locaux dans un vault Obsidian existant
- **Pont Obsidian** : plugin [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) (HTTP local)
- **Format des fichiers projet** : frontmatter YAML + corps markdown structuré (voir ci-dessous)
- **Pas de base de données externe** : tout reste local dans le vault

---

## Structure d'un fichier projet

Chaque projet est un fichier `.md` dans le vault avec cette structure :

```
---
title: "..."
status: "en cours"
created: YYYY-MM-DD
last_session: YYYY-MM-DD
tags: []
progress: "0%"
current_phase: "..."
next_step: "..."
summary: "..."
stack: []
sources: []
open_issues: []
resolved_issues: []
claude_project: true
session_count: 0
---

## 🎯 Vision
## ✅ Décisions validées
## 🏗️ Architecture / Design actuel
## 📋 Journal des sessions
## ❓ Questions ouvertes
```

Le champ `claude_project: true` permet au MCP d'identifier les fichiers à tracker.

---

## Fonctionnalités MVP (Phase 1)

### Tools MCP à implémenter

```
list_projects()
  → Scanne le vault, retourne tous les fichiers avec claude_project: true
  → Retourne : title, status, last_session, next_step, progress

get_project_context(project_title: string)
  → Lit le fichier .md correspondant
  → Retourne : frontmatter complet + sections Vision, Décisions validées,
    Architecture, Questions ouvertes (PAS le journal complet)
  → Objectif : contexte minimal mais suffisant, sans exploser la context window

append_session_summary(project_title: string, summary: SessionSummary)
  → Met à jour le frontmatter : last_session, next_step, progress, open_issues, resolved_issues
  → Ajoute une nouvelle entrée dans ## 📋 Journal des sessions
  → Réorganise proprement les sections ## ✅ Décisions validées et ## ❓ Questions ouvertes

create_project(title: string, summary: string, stack: string[])
  → Crée un nouveau fichier .md à partir du template
  → Initialise le frontmatter avec les valeurs fournies
```

### Type SessionSummary

```typescript
type SessionSummary = {
  date: string                  // YYYY-MM-DD
  discussed: string             // résumé de la session
  new_decisions: string[]       // ajoutées à ## ✅ Décisions validées
  resolved_issues: string[]     // issues closes ce jour
  open_issues: string[]         // issues encore ouvertes ou nouvelles
  next_step: string             // mis à jour dans le frontmatter
  progress: string              // ex: "40%"
  current_phase: string
}
```

---

## Gestion du context bloat (Phase 2)

Le journal des sessions peut devenir très long. Stratégie à implémenter :

- `get_project_context` retourne le journal complet uniquement si `session_count < 5`
- Au-delà, ne retourner que les 2 dernières sessions + un résumé condensé des sessions précédentes
- Ajouter un tool `summarize_old_sessions(project_title)` qui condense les anciennes entrées

---

## Structure du repo

```
obsidian-claude-mcp/
├── src/
│   ├── index.ts          # Point d'entrée MCP
│   ├── tools/
│   │   ├── list_projects.ts
│   │   ├── get_project_context.ts
│   │   ├── append_session_summary.ts
│   │   └── create_project.ts
│   ├── obsidian/
│   │   ├── client.ts     # Wrapper Local REST API
│   │   └── parser.ts     # Lecture/écriture frontmatter YAML + sections MD
│   └── types.ts
├── templates/
│   └── project-template.md
├── package.json
├── tsconfig.json
└── README.md
```

---

## Configuration attendue

```json
// claude_desktop_config.json
{
  "mcpServers": {
    "obsidian-projects": {
      "command": "node",
      "args": ["path/to/obsidian-claude-mcp/dist/index.js"],
      "env": {
        "OBSIDIAN_API_URL": "http://localhost:27123",
        "OBSIDIAN_API_KEY": "your-key-here",
        "VAULT_PROJECTS_FOLDER": "Projects"
      }
    }
  }
}
```

---

## Ordre de build recommandé

1. Setup MCP boilerplate + connexion Local REST API (vérifier que le vault répond)
2. Implémenter `list_projects` — le plus simple, bonne validation de la stack
3. Implémenter `get_project_context`
4. Implémenter `create_project` avec le template
5. Implémenter `append_session_summary` — le plus complexe (parsing + écriture YAML + MD)
6. Tests manuels dans Claude Desktop
7. Passer à la Phase 2 (context bloat)

---

## Contraintes

- Ne jamais réécrire un fichier entier si seul le frontmatter a changé
- Préserver le formatage markdown existant dans le corps du fichier
- Toujours incrémenter `session_count` à chaque `append_session_summary`
- Le MCP est read/write mais ne supprime jamais rien — uniquement append ou update
