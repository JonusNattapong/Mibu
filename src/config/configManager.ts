import fs from "fs";
import path from "path";
import os from "os";

export interface ProviderProfile {
  id: string;
  name: string;
  provider: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  visionModel?: string;
  defaultModel?: string;
  browserVisible?: boolean;
}

interface RedlockConfig {
  activeProfileId?: string;
  values: Record<string, string>;
  profiles: ProviderProfile[];
}

const configDir = path.join(os.homedir(), ".redrock");
const configPath = path.join(configDir, "config.json");

function ensureConfigDir(): void {
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
}

function readConfig(): RedlockConfig {
  ensureConfigDir();
  if (!fs.existsSync(configPath)) return { values: {}, profiles: [] };

  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8")) as RedlockConfig;
  } catch {
    return { values: {}, profiles: [] };
  }
}

function writeConfig(config: RedlockConfig): void {
  ensureConfigDir();
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
}

function parseDotEnvLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("="))
    return null;
  const index = trimmed.indexOf("=");
  const key = trimmed.slice(0, index).trim();
  const value = trimmed
    .slice(index + 1)
    .trim()
    .replace(/^['"]|['"]$/g, "");
  return key ? [key, value] : null;
}

export function get(key: string): string | undefined {
  const envValue = process.env[key]?.trim();
  if (envValue) return envValue;

  const configValue = readConfig().values[key]?.trim();
  return configValue || undefined;
}

export function set(key: string, value: string): void {
  const config = readConfig();
  config.values[key] = value;
  writeConfig(config);
  process.env[key] = value;
}

export function getConfigDirPath(): string {
  ensureConfigDir();
  return configDir;
}

export function getDefaultWorkspace(): string {
  return get("DEFAULT_WORKSPACE") || path.join(configDir, "workspaces");
}

export function migrateFromDotEnv(envPath: string): void {
  if (!fs.existsSync(envPath)) return;

  const config = readConfig();
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const parsed = parseDotEnvLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    if (value.trim() && !config.values[key]?.trim()) {
      config.values[key] = value;
    }
  }
  writeConfig(config);
}

export function ensureProfiles(): void {
  const config = readConfig();
  writeConfig({
    activeProfileId: config.activeProfileId,
    values: config.values || {},
    profiles: config.profiles || [],
  });
}

export function injectIntoProcessEnv(): void {
  const config = readConfig();
  for (const [key, value] of Object.entries(config.values)) {
    if (value.trim() && !process.env[key]?.trim()) {
      process.env[key] = value;
    }
  }

  const active = getActiveProfile();
  if (!active) return;
  process.env.DEFAULT_PROVIDER = active.provider;
  if (active.apiKey)
    process.env[`${active.provider.toUpperCase()}_API_KEY`] = active.apiKey;
  if (active.baseUrl)
    process.env[`${active.provider.toUpperCase()}_BASE_URL`] = active.baseUrl;
  if (active.model || active.defaultModel) {
    process.env[`${active.provider.toUpperCase()}_MODEL`] =
      active.model || active.defaultModel;
  }
}

export function getProfiles(): ProviderProfile[] {
  return readConfig().profiles || [];
}

export function getActiveProfile(): ProviderProfile | undefined {
  const config = readConfig();
  return (config.profiles || []).find(
    (profile) => profile.id === config.activeProfileId,
  );
}

export function saveProfile(profile: ProviderProfile): void {
  const config = readConfig();
  writeConfig({
    ...config,
    profiles: [
      ...(config.profiles || []).filter((item) => item.id !== profile.id),
      profile,
    ],
  });
}

export function setActiveProfile(id: string): void {
  const config = readConfig();
  writeConfig({ ...config, activeProfileId: id });
  injectIntoProcessEnv();
}

export function switchTacticalModel(modelId: string): void {
  const active = getActiveProfile();
  if (active) {
    updateProfile(active.id, { model: modelId });
  }
}

export function updateProfile(
  id: string,
  patch: Partial<ProviderProfile>,
): void {
  const config = readConfig();
  const nextConfig = {
    ...config,
    profiles: (config.profiles || []).map((profile) =>
      profile.id === id ? { ...profile, ...patch, id } : profile,
    ),
  };
  writeConfig(nextConfig);

  if (nextConfig.activeProfileId === id) {
    injectIntoProcessEnv();
  }
}

export function removeProfile(id: string): void {
  const config = readConfig();
  writeConfig({
    ...config,
    activeProfileId:
      config.activeProfileId === id ? undefined : config.activeProfileId,
    profiles: (config.profiles || []).filter((profile) => profile.id !== id),
  });
}

export default {
  get,
  set,
  getConfigDirPath,
  getDefaultWorkspace,
  migrateFromDotEnv,
  ensureProfiles,
  injectIntoProcessEnv,
  getProfiles,
  getActiveProfile,
  saveProfile,
  setActiveProfile,
  updateProfile,
  switchTacticalModel,
  removeProfile,
};
