import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { logger } from "../src/runtime/logger";

interface CacheEntry {
  data: any;
  timestamp: number;
  ttl: number;
}

/**
 * Intelligence Cache Manager
 * Provides persistent, cross-mission caching for tool results in ~/.redrock/cache
 */
class CacheManager {
  private cacheDir: string;
  private cacheFile: string;
  private cache: Record<string, CacheEntry> = {};

  constructor() {
    this.cacheDir = path.join(os.homedir(), ".redrock", "cache");
    this.cacheFile = path.join(this.cacheDir, "swarm_cache.json");
    this.ensureDirectory();
    this.load();
  }

  private ensureDirectory() {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  private load() {
    try {
      if (fs.existsSync(this.cacheFile)) {
        const raw = fs.readFileSync(this.cacheFile, "utf8");
        this.cache = JSON.parse(raw);
        this.cleanup(); // Remove expired entries on load
      }
    } catch (e: any) {
      logger.error({ error: e.message }, "Failed to load cache");
      this.cache = {};
    }
  }

  private save() {
    try {
      fs.writeFileSync(this.cacheFile, JSON.stringify(this.cache, null, 2), "utf8");
    } catch (e: any) {
      logger.error({ error: e.message }, "Failed to save cache");
    }
  }

  private cleanup() {
    const now = Date.now();
    let changed = false;
    for (const key in this.cache) {
      if (now - this.cache[key].timestamp > this.cache[key].ttl) {
        delete this.cache[key];
        changed = true;
      }
    }
    if (changed) this.save();
  }

  /**
   * Generate a unique key for a tool call
   */
  private generateKey(toolName: string, args: any): string {
    return `${toolName}:${JSON.stringify(args)}`;
  }

  /**
   * Get a cached result if it exists and is not expired
   */
  public get(toolName: string, args: any): any | null {
    const key = this.generateKey(toolName, args);
    const entry = this.cache[key];
    
    if (!entry) return null;

    if (Date.now() - entry.timestamp > entry.ttl) {
      delete this.cache[key];
      this.save();
      return null;
    }

    return entry.data;
  }

  /**
   * Save a result to the cache
   */
  public set(toolName: string, args: any, data: any, ttlMs: number = 3600000) {
    const key = this.generateKey(toolName, args);
    this.cache[key] = {
      data,
      timestamp: Date.now(),
      ttl: ttlMs
    };
    this.save();
  }

  /**
   * Clear the entire cache
   */
  public clear() {
    this.cache = {};
    this.save();
  }
}

export const cacheManager = new CacheManager();
