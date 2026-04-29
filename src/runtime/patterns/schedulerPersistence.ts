import fs from "fs/promises";
import path from "path";
import os from "os";
import crypto from "crypto";

export interface ScheduledMission {
  id: string;
  cron: string;
  target: string;
  extraContext: string;
  recurring: boolean;
  createdAt: string;
}

const storePath = path.join(
  os.homedir(),
  ".redrock",
  "scheduled_missions.json",
);

async function ensureStoreDir(): Promise<void> {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
}

export const SchedulerPersistence = {
  async readMissions(): Promise<ScheduledMission[]> {
    try {
      return JSON.parse(
        await fs.readFile(storePath, "utf8"),
      ) as ScheduledMission[];
    } catch {
      return [];
    }
  },

  async addMission(
    input: Omit<ScheduledMission, "id" | "createdAt">,
  ): Promise<string> {
    await ensureStoreDir();
    const missions = await this.readMissions();
    const id = crypto.randomBytes(8).toString("hex");
    missions.push({ ...input, id, createdAt: new Date().toISOString() });
    await fs.writeFile(storePath, JSON.stringify(missions, null, 2), "utf8");
    return id;
  },

  async removeMission(id: string): Promise<void> {
    await ensureStoreDir();
    const missions = (await this.readMissions()).filter(
      (mission) => mission.id !== id,
    );
    await fs.writeFile(storePath, JSON.stringify(missions, null, 2), "utf8");
  },
};
