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
