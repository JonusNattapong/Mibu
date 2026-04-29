import fs from "fs/promises";
import path from "path";
import os from "os";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

const configPath = path.join(os.homedir(), ".redrock", "mcp_servers.json");

async function readConfig(): Promise<Record<string, McpServerConfig>> {
  try {
    return JSON.parse(await fs.readFile(configPath, "utf8")) as Record<
      string,
      McpServerConfig
    >;
  } catch {
    return {};
  }
}

async function writeConfig(
  config: Record<string, McpServerConfig>,
): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
}

export const McpConfigManager = {
  async listServers(): Promise<Record<string, McpServerConfig>> {
    return await readConfig();
  },

  async addServer(name: string, config: McpServerConfig): Promise<void> {
    const servers = await readConfig();
    servers[name] = config;
    await writeConfig(servers);
  },

  async removeServer(name: string): Promise<void> {
    const servers = await readConfig();
    delete servers[name];
    await writeConfig(servers);
  },
};
