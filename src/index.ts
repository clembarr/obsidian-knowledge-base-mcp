#!/usr/bin/env node
/**
 * Point d'entrée du serveur MCP.
 *
 * Transport stdio : stdout porte le protocole JSON-RPC et rien d'autre. Tout
 * message de diagnostic passe donc par stderr — un `console.log` corromprait
 * la communication avec le client.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig, type Config } from "./config.js";
import {
  appendSessionSummary,
  appendSessionSummaryInputShape,
  appendSessionSummaryOutputShape,
  formatRecorded,
  APPEND_SESSION_SUMMARY_DESCRIPTION,
} from "./tools/append_session_summary.js";
import {
  createProject,
  createProjectInputShape,
  createProjectOutputShape,
  formatCreated,
  InvalidTitleError,
  ProjectExistsError,
  CREATE_PROJECT_DESCRIPTION,
} from "./tools/create_project.js";
import {
  formatContext,
  getProjectContext,
  getProjectContextInputShape,
  getProjectContextOutputShape,
  GET_PROJECT_CONTEXT_DESCRIPTION,
  ProjectNotFoundError,
  AmbiguousProjectError,
} from "./tools/get_project_context.js";
import {
  formatProjects,
  listProjects,
  listProjectsOutputShape,
  LIST_PROJECTS_DESCRIPTION,
} from "./tools/list_projects.js";
import { FsVaultClient } from "./vault/client.js";

const VERSION = "0.1.0";

function createServer(vault: FsVaultClient, config: Config): McpServer {
  const server = new McpServer({ name: "obsidian-projects", version: VERSION });

  server.registerTool(
    "list_projects",
    {
      title: "Lister les projets suivis",
      description: LIST_PROJECTS_DESCRIPTION,
      inputSchema: {},
      outputSchema: listProjectsOutputShape,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const projects = await listProjects(vault, config);
      return {
        content: [{ type: "text", text: formatProjects(projects, config) }],
        structuredContent: { projects },
      };
    },
  );

  server.registerTool(
    "get_project_context",
    {
      title: "Charger le contexte d'un projet",
      description: GET_PROJECT_CONTEXT_DESCRIPTION,
      inputSchema: getProjectContextInputShape,
      outputSchema: getProjectContextOutputShape,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ project_title }) => {
      try {
        const context = await getProjectContext(vault, config, project_title);
        return {
          content: [{ type: "text", text: formatContext(context) }],
          structuredContent: context,
        };
      } catch (error) {
        // Titre inconnu ou ambigu : le message liste les projets disponibles,
        // ce qui permet au modèle de corriger son appel sans nouvel aller-retour.
        if (error instanceof ProjectNotFoundError || error instanceof AmbiguousProjectError) {
          return { content: [{ type: "text", text: error.message }], isError: true };
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "create_project",
    {
      title: "Créer un projet",
      description: CREATE_PROJECT_DESCRIPTION,
      inputSchema: createProjectInputShape,
      outputSchema: createProjectOutputShape,
      // `destructiveHint: false` : la création n'écrase jamais une note existante.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        const projet = await createProject(vault, config, input);
        return {
          content: [{ type: "text", text: formatCreated(projet) }],
          structuredContent: projet,
        };
      } catch (error) {
        if (error instanceof ProjectExistsError || error instanceof InvalidTitleError) {
          return { content: [{ type: "text", text: error.message }], isError: true };
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "append_session_summary",
    {
      title: "Enregistrer le bilan de la session",
      description: APPEND_SESSION_SUMMARY_DESCRIPTION,
      inputSchema: appendSessionSummaryInputShape,
      outputSchema: appendSessionSummaryOutputShape,
      // `destructiveHint: false` : l'écriture n'ajoute et ne met à jour que des
      // champs ; aucun contenu existant du corps n'est retiré.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ project_title, summary }) => {
      try {
        const bilan = await appendSessionSummary(vault, config, project_title, summary);
        return {
          content: [{ type: "text", text: formatRecorded(bilan) }],
          structuredContent: bilan,
        };
      } catch (error) {
        if (error instanceof ProjectNotFoundError || error instanceof AmbiguousProjectError) {
          return { content: [{ type: "text", text: error.message }], isError: true };
        }
        throw error;
      }
    },
  );

  return server;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const vault = new FsVaultClient(config.vaultPath, { writableFolder: config.projectsFolder });
  await vault.assertVaultExists();

  const server = createServer(vault, config);
  await server.connect(new StdioServerTransport());

  console.error(
    `obsidian-projects ${VERSION} — vault ${vault.root}, dossier « ${config.projectsFolder} », tag « ${config.projectTag} »`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
