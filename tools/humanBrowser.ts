/**
 * Human Browser - Advanced Anti-Detection Automation Layer
 *
 * Powered by Playwright with custom stealth orchestration.
 * Implements bezier curve mouse movement, adaptive fallback, and
 * structured page snapshots for the agent swarm.
 */

import { chromium, Browser, Page } from "playwright";
import * as cheerio from "cheerio";
import stealthEngine from "../src/runtime/stealthEngine";
import configManager from "../src/config/configManager";
import { logger } from "../src/runtime/logger";

type BrowserMode = "interactive" | "http-fallback";
type WaitUntilState = "domcontentloaded" | "load" | "networkidle" | "commit";

export interface BrowserStatus {
  available: boolean;
  mode: BrowserMode;
  lastUrl?: string;
  reason?: string;
  retryAfterMs?: number;
  interactiveDisabled?: boolean;
}

export interface BrowserActionInput {
  action:
    | "navigate"
    | "click"
    | "type"
    | "submit"
    | "select"
    | "press"
    | "wait_for_selector"
    | "scroll"
    | "capture"
    | "inspect"
    | "status";
  url?: string;
  selector?: string;
  target?: string;
  text?: string;
  key?: string;
  value?: string;
  state?: "attached" | "detached" | "visible" | "hidden";
  direction?: "up" | "down";
  amount?: number;
  waitUntil?: WaitUntilState;
  waitMs?: number;
  timeoutMs?: number;
}

interface BrowserPageSummary {
  mode: BrowserMode;
  url: string;
  title: string;
  statusCode?: number;
  interactiveAvailable: boolean;
  forms: number;
  inputs: number;
  buttons: number;
  links: number;
  interactiveHints: string[];
  textPreview: string;
  htmlPreview: string;
}

interface FallbackResponse {
  html: string;
  statusCode?: number;
  finalUrl: string;
}

let browserInstance: Browser | null = null;
let pageInstance: Page | null = null;
let browserInitError: Error | null = null;
let browserDisabledUntil = 0;
let lastKnownUrl = "";
let lastMode: BrowserMode = "interactive";

function createTimeoutSignal(timeoutMs: number): AbortSignal {
  if (typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(timeoutMs);
  }

  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs);
  return controller.signal;
}

function getNumericConfig(key: string, fallback: number): number {
  const value = configManager.get(key);
  if (!value) return fallback;

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function summarizeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? "Unknown error");
}

function truncate(value: string, maxLength = 800): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return trimmed;

  try {
    return new URL(trimmed).toString();
  } catch {
    return new URL(`http://${trimmed}`).toString();
  }
}

function isBrowserLaunchFailure(error: unknown): boolean {
  const message = summarizeError(error).toLowerCase();
  return (
    message.includes("launch") ||
    message.includes("executable") ||
    message.includes("browser") ||
    message.includes("timeout")
  );
}

function isAllowedWaitUntil(value?: string): value is WaitUntilState {
  return (
    value === "domcontentloaded" ||
    value === "load" ||
    value === "networkidle" ||
    value === "commit"
  );
}

function humanDelay(min = 50, max = 350) {
  const base = Math.random() * (max - min) + min;
  const variance = gaussianRandom(0, base * 0.15);
  return Math.max(min, base + variance);
}

function gaussianRandom(mean = 0, stdev = 1) {
  const u = 1 - Math.random();
  const v = Math.random();
  const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  return z * stdev + mean;
}

function formatSummary(summary: BrowserPageSummary): string {
  const hints =
    summary.interactiveHints.length > 0
      ? summary.interactiveHints.map((hint) => `- ${hint}`).join("\n")
      : "- No obvious interactive controls detected.";
  const statusLine = summary.statusCode
    ? `HTTP Status: ${summary.statusCode}\n`
    : "";

  return [
    `[Browser Mode: ${summary.mode}]`,
    `URL: ${summary.url}`,
    `Title: ${summary.title || "(untitled)"}`,
    statusLine.trimEnd(),
    `Interactive Browser Available: ${summary.interactiveAvailable ? "yes" : "no"}`,
    `Forms: ${summary.forms} | Inputs: ${summary.inputs} | Buttons: ${summary.buttons} | Links: ${summary.links}`,
    `Interactive Hints:\n${hints}`,
    `Visible Text Preview:\n${summary.textPreview || "(empty)"}`,
    `HTML Preview:\n${summary.htmlPreview || "(empty)"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildHtmlSummary(
  url: string,
  html: string,
  mode: BrowserMode,
  statusCode?: number,
): BrowserPageSummary {
  const $ = cheerio.load(html);
  const title = $("title").first().text().trim();
  const textPreview = truncate($("body").text(), 1200);
  const htmlPreview = truncate($.html() || html, 1200);
  const interactiveHints = $("a, button, input, textarea, select, [role='button']")
    .slice(0, 8)
    .map((_, el) => {
      const node = $(el);
      const tag = el.tagName?.toLowerCase() || "element";
      const id = node.attr("id");
      const name = node.attr("name");
      const href = node.attr("href");
      const type = node.attr("type");
      const label = truncate(node.text() || node.attr("aria-label") || "", 80);
      const parts = [tag];
      if (id) parts.push(`#${id}`);
      if (name) parts.push(`[name=${name}]`);
      if (type) parts.push(`[type=${type}]`);
      if (href) parts.push(`-> ${href}`);
      if (label) parts.push(`"${label}"`);
      return parts.join(" ");
    })
    .get();

  return {
    mode,
    url,
    title,
    statusCode,
    interactiveAvailable: mode === "interactive",
    forms: $("form").length,
    inputs: $("input, textarea, select").length,
    buttons: $("button, input[type='submit'], input[type='button']").length,
    links: $("a[href]").length,
    interactiveHints,
    textPreview,
    htmlPreview,
  };
}

async function snapshotCurrentPage(): Promise<BrowserPageSummary> {
  ensureInteractiveBrowserAvailable();

  const snapshot = await pageInstance.evaluate(() => {
    const truncateLocal = (value: string, maxLength = 1200) => {
      const normalized = value.replace(/\s+/g, " ").trim();
      if (normalized.length <= maxLength) return normalized;
      return `${normalized.slice(0, maxLength - 3)}...`;
    };

    const interactiveNodes = Array.from(
      document.querySelectorAll(
        "a, button, input, textarea, select, [role='button']",
      ),
    )
      .slice(0, 8)
      .map((node) => {
        const element = node as HTMLElement;
        const tag = element.tagName.toLowerCase();
        const id = element.id ? `#${element.id}` : "";
        const name = element.getAttribute("name");
        const type = element.getAttribute("type");
        const href = element.getAttribute("href");
        const text = truncateLocal(
          element.innerText ||
            element.getAttribute("aria-label") ||
            element.getAttribute("placeholder") ||
            "",
          80,
        );
        const parts = [tag];
        if (id) parts.push(id);
        if (name) parts.push(`[name=${name}]`);
        if (type) parts.push(`[type=${type}]`);
        if (href) parts.push(`-> ${href}`);
        if (text) parts.push(`"${text}"`);
        return parts.join(" ");
      });

    return {
      url: window.location.href,
      title: document.title || "",
      forms: document.querySelectorAll("form").length,
      inputs: document.querySelectorAll("input, textarea, select").length,
      buttons: document.querySelectorAll(
        "button, input[type='submit'], input[type='button']",
      ).length,
      links: document.querySelectorAll("a[href]").length,
      interactiveHints: interactiveNodes,
      textPreview: truncateLocal(document.body?.innerText || ""),
      htmlPreview: truncateLocal(document.documentElement.outerHTML || ""),
    };
  });

  return {
    mode: "interactive",
    interactiveAvailable: true,
    statusCode: undefined,
    ...snapshot,
  };
}

async function fetchContentFallback(url: string): Promise<FallbackResponse> {
  const normalizedUrl = normalizeUrl(url);
  const response = await fetch(normalizedUrl, {
    method: "GET",
    headers: stealthEngine.getTacticalHeaders(),
    signal: createTimeoutSignal(getNumericConfig("BROWSER_FETCH_TIMEOUT_MS", 20000)),
  });

  return {
    html: await response.text(),
    statusCode: response.status,
    finalUrl: response.url || normalizedUrl,
  };
}

function ensureInteractiveBrowserAvailable(): void {
  if (pageInstance) return;

  if (browserInitError) {
    throw new Error(
      `Interactive browser unavailable: ${browserInitError.message}. ` +
        `Use fetch_url/navigate fallback for read-only access, or set BROWSER_EXECUTABLE_PATH / BROWSER_CHANNEL if Playwright cannot launch locally.`,
    );
  }

  throw new Error("Interactive browser page instance not available");
}

/**
 * Moves mouse along a realistic bezier curve to target coordinates
 */
async function bezierMouseMove(targetX: number, targetY: number) {
  if (!pageInstance) return;

  const startX = 0;
  const startY = 0;

  const cp1x = startX + (targetX - startX) * 0.3 + gaussianRandom(0, 60);
  const cp1y = startY + (targetY - startY) * 0.1 + gaussianRandom(0, 40);
  const cp2x = startX + (targetX - startX) * 0.7 + gaussianRandom(0, 40);
  const cp2y = startY + (targetY - startY) * 0.9 + gaussianRandom(0, 60);

  const steps =
    Math.floor(Math.hypot(targetX - startX, targetY - startY) / 12) + 8;

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const easeT = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

    const x =
      Math.pow(1 - easeT, 3) * startX +
      3 * Math.pow(1 - easeT, 2) * easeT * cp1x +
      3 * (1 - easeT) * Math.pow(easeT, 2) * cp2x +
      Math.pow(easeT, 3) * targetX;

    const y =
      Math.pow(1 - easeT, 3) * startY +
      3 * Math.pow(1 - easeT, 2) * easeT * cp1y +
      3 * (1 - easeT) * Math.pow(easeT, 2) * cp2y +
      Math.pow(easeT, 3) * targetY;

    await pageInstance.mouse.move(
      x + gaussianRandom(0, 1.2),
      y + gaussianRandom(0, 1.2),
    );
    await new Promise((r) => setTimeout(r, 4 + Math.random() * 8));
  }

  await pageInstance.mouse.move(targetX, targetY);
}

export async function initBrowser() {
  if (browserInstance) return { browser: browserInstance, page: pageInstance };

  const now = Date.now();
  if (browserInitError && now < browserDisabledUntil) {
    throw new Error(
      `${browserInitError.message} (browser retry cooling down for ${Math.max(
        1000,
        browserDisabledUntil - now,
      )}ms)`,
    );
  }

  const isHeadless = configManager.get("BROWSER_HEADLESS") !== "false";
  const proxyStr = stealthEngine.getProxyConfig();
  const proxy = proxyStr ? stealthEngine.parseProxy(proxyStr) : undefined;
  const launchTimeout = getNumericConfig("BROWSER_LAUNCH_TIMEOUT_MS", 60000);
  const retryCooldownMs = getNumericConfig("BROWSER_RETRY_COOLDOWN_MS", 120000);
  const executablePath = configManager.get("BROWSER_EXECUTABLE_PATH");
  const channel = configManager.get("BROWSER_CHANNEL");

  // Determine headless mode from active profile or global config
  const activeProfile = configManager.getActiveProfile();
  const requestedHeadless = activeProfile?.browserVisible === true ? false : (configManager.get("BROWSER_HEADLESS") !== "false");

  // If browser is already running but with a different headless setting, close it
  if (browserInstance && (configManager.get("_LAST_HEADLESS_STATE") !== String(requestedHeadless))) {
    logger.info(`Requested visibility changed (${requestedHeadless ? 'Stealth' : 'Visible'}). Restarting browser...`);
    await browserInstance.close();
    browserInstance = null;
    pageInstance = null;
  }

  logger.info(
    {
      headless: requestedHeadless,
      proxy: !!proxy,
      launchTimeout,
      executablePath: Boolean(executablePath),
      channel: channel || undefined,
    },
    "Initializing tactical browser engine",
  );

  try {
    browserInitError = null;

    // --- Pre-launch Cleanup for Windows ---
    // Removed aggressive taskkill to prevent closing user's personal browsers

    browserInstance = await chromium.launch({
      headless: requestedHeadless,
      executablePath: executablePath || undefined,
      channel: channel || undefined,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--disable-infobars",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--disable-extensions",
        "--disable-component-update",
        "--disable-gpu",
        "--window-size=1920,1080",
      ],
      timeout: launchTimeout,
    });
    
    // Store last headless state to detect changes
    configManager.set("_LAST_HEADLESS_STATE", String(requestedHeadless));

    const context = await browserInstance.newContext({
      userAgent: stealthEngine.getRandomUA(),
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
      extraHTTPHeaders: stealthEngine.getTacticalHeaders(),
    });

    pageInstance = await context.newPage();
    pageInstance.setDefaultTimeout(launchTimeout);
    pageInstance.setDefaultNavigationTimeout(launchTimeout);

    await pageInstance.addInitScript(() => {
      const globalAny = globalThis as any;
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      delete (globalAny as any).cdc_adoQpoasnfa76pfcZLmcfl_;
      (globalAny as any).chrome = { runtime: {} };
    });

    browserDisabledUntil = 0;
    lastMode = "interactive";
  } catch (error) {
    // Fallback logic for Windows: try msedge if chrome fails
    if (process.platform === "win32" && (channel === "chrome" || !channel) && !executablePath) {
      logger.warn("Chrome launch failed. Attempting fallback to Microsoft Edge...");
      try {
        browserInstance = await chromium.launch({
          headless: requestedHeadless,
          channel: "msedge",
          args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-blink-features=AutomationControlled",
            "--disable-infobars",
            "--disable-dev-shm-usage",
            "--no-first-run",
            "--disable-extensions",
            "--disable-component-update",
          ],
          timeout: launchTimeout,
        });
        configManager.set("_LAST_HEADLESS_STATE", String(requestedHeadless));
        // Success with Edge! Resume setup.
        const context = await browserInstance.newContext({
          userAgent: stealthEngine.getRandomUA(),
          viewport: { width: 1920, height: 1080 },
          deviceScaleFactor: 1,
          extraHTTPHeaders: stealthEngine.getTacticalHeaders(),
        });
        pageInstance = await context.newPage();
        pageInstance.setDefaultTimeout(launchTimeout);
        pageInstance.setDefaultNavigationTimeout(launchTimeout);
        browserDisabledUntil = 0;
        lastMode = "interactive";
        return; // Exit successfully
      } catch (edgeError) {
        logger.error({ error: summarizeError(edgeError) }, "Edge fallback also failed.");
      }
    }

    logger.error({ error: summarizeError(error) }, "Critical browser engine failure");
    browserInstance = null;
    pageInstance = null;
    browserInitError =
      error instanceof Error
        ? error
        : new Error(String(error ?? "Unknown browser launch error"));
    browserDisabledUntil = Date.now() + retryCooldownMs;
    logger.warn(
      {
        launchTimeout,
        retryCooldownMs,
        executablePath: executablePath || undefined,
        channel: channel || undefined,
        error: browserInitError.message,
      },
      "Browser launch failed; HTTP fallback will be used when possible",
    );
    throw browserInitError;
  }

  return { browser: browserInstance, page: pageInstance };
}

export function getStatus(): BrowserStatus {
  const retryAfterMs =
    browserDisabledUntil > Date.now()
      ? browserDisabledUntil - Date.now()
      : undefined;

  return {
    available: Boolean(pageInstance),
    mode: pageInstance ? "interactive" : "http-fallback",
    lastUrl: lastKnownUrl || undefined,
    reason: browserInitError?.message,
    retryAfterMs,
    interactiveDisabled: !pageInstance,
  };
}

export async function inspect(): Promise<string> {
  if (!pageInstance) {
    const status = getStatus();
    return `Browser Status: ${JSON.stringify(status)}`;
  }

  return formatSummary(await snapshotCurrentPage());
}

export async function navigate(
  url: string,
  waitUntil?: WaitUntilState,
  waitMs?: number,
): Promise<string> {
  const normalizedUrl = normalizeUrl(url);
  lastKnownUrl = normalizedUrl;

  try {
    await initBrowser();
  } catch (error) {
    if (isBrowserLaunchFailure(error)) {
      logger.warn(
        { url: normalizedUrl, error: summarizeError(error) },
        "Falling back to HTTP fetch because the browser could not launch",
      );
      const fallback = await fetchContentFallback(normalizedUrl);
      lastMode = "http-fallback";
      return formatSummary(
        buildHtmlSummary(
          fallback.finalUrl,
          fallback.html,
          "http-fallback",
          fallback.statusCode,
        ),
      );
    }
    throw error;
  }

  ensureInteractiveBrowserAvailable();

  const finalWaitUntil = isAllowedWaitUntil(waitUntil)
    ? waitUntil
    : "domcontentloaded";

  try {
    await pageInstance.goto(normalizedUrl, {
      waitUntil: finalWaitUntil,
      timeout: getNumericConfig("BROWSER_NAV_TIMEOUT_MS", 60000),
    });
  } catch (error) {
    logger.warn(
      { url: normalizedUrl, error: summarizeError(error) },
      "Initial navigation failed, attempting fallback page load",
    );
    await pageInstance
      .goto(normalizedUrl, {
        waitUntil: "load",
        timeout: getNumericConfig("BROWSER_NAV_FALLBACK_TIMEOUT_MS", 15000),
      })
      .catch(() => undefined);
  }

  await new Promise(
    (r) => setTimeout(r, Math.max(0, waitMs || humanDelay(800, 2200))),
  );
  lastMode = "interactive";
  lastKnownUrl = pageInstance.url();
  return formatSummary(await snapshotCurrentPage());
}

export async function click(selector: string, retries = 2): Promise<boolean> {
  await initBrowser();
  ensureInteractiveBrowserAvailable();

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const element = await pageInstance.waitForSelector(selector, {
        state: "visible",
        timeout: getNumericConfig("BROWSER_ELEMENT_TIMEOUT_MS", 8000),
      });
      if (!element) throw new Error("Element not found after wait");

      const box = await element.boundingBox();
      if (!box) throw new Error("Element has no bounding box (hidden or removed)");

      const targetX = box.x + box.width / 2 + gaussianRandom(0, box.width * 0.1);
      const targetY = box.y + box.height / 2 + gaussianRandom(0, box.height * 0.1);

      await bezierMouseMove(targetX, targetY);
      await new Promise((r) => setTimeout(r, humanDelay(60, 220)));
      await pageInstance.mouse.down();
      await new Promise((r) => setTimeout(r, humanDelay(40, 130)));
      await pageInstance.mouse.up();
      await new Promise((r) => setTimeout(r, humanDelay(250, 750)));
      lastKnownUrl = pageInstance.url();
      return true;
    } catch (error) {
      if (attempt === retries) {
        logger.error(`[Browser] Click failed: ${summarizeError(error)}`);
        return false;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  return false;
}

export async function type(selector: string, text: string): Promise<boolean> {
  await initBrowser();
  ensureInteractiveBrowserAvailable();

  const success = await click(selector);
  if (!success) return false;

  await new Promise((r) => setTimeout(r, humanDelay(120, 350)));

  try {
    for (const char of text) {
      await pageInstance.keyboard.type(char);
      await new Promise((r) => setTimeout(r, humanDelay(35, 180)));
    }
    await new Promise((r) => setTimeout(r, humanDelay(200, 600)));
    lastKnownUrl = pageInstance.url();
    return true;
  } catch (error) {
    logger.error(`[Browser] Typing failed: ${summarizeError(error)}`);
    return false;
  }
}

export async function submit(selector = "form"): Promise<boolean> {
  await initBrowser();
  ensureInteractiveBrowserAvailable();

  try {
    await pageInstance.waitForSelector(selector, {
      state: "attached",
      timeout: getNumericConfig("BROWSER_ELEMENT_TIMEOUT_MS", 8000),
    });
    await pageInstance.$eval(selector, (node) => {
      const form =
        node instanceof HTMLFormElement
          ? node
          : (node.closest("form") as HTMLFormElement | null);
      if (!form) {
        throw new Error("No form found for submission");
      }
      form.requestSubmit();
    });
    await new Promise((r) => setTimeout(r, humanDelay(400, 1200)));
    lastKnownUrl = pageInstance.url();
    return true;
  } catch (error) {
    logger.error(`[Browser] Submit failed: ${summarizeError(error)}`);
    return false;
  }
}

export async function select(selector: string, value: string): Promise<boolean> {
  await initBrowser();
  ensureInteractiveBrowserAvailable();

  try {
    await pageInstance.waitForSelector(selector, {
      state: "visible",
      timeout: getNumericConfig("BROWSER_ELEMENT_TIMEOUT_MS", 8000),
    });
    await pageInstance.selectOption(selector, { value }).catch(async () => {
      await pageInstance.selectOption(selector, { label: value });
    });
    await new Promise((r) => setTimeout(r, humanDelay(200, 600)));
    lastKnownUrl = pageInstance.url();
    return true;
  } catch (error) {
    logger.error(`[Browser] Select failed: ${summarizeError(error)}`);
    return false;
  }
}

export async function press(key: string, selector?: string): Promise<boolean> {
  await initBrowser();
  ensureInteractiveBrowserAvailable();

  try {
    if (selector) {
      await pageInstance.waitForSelector(selector, {
        state: "visible",
        timeout: getNumericConfig("BROWSER_ELEMENT_TIMEOUT_MS", 8000),
      });
      await pageInstance.focus(selector);
      await new Promise((r) => setTimeout(r, humanDelay(80, 180)));
    }
    await pageInstance.keyboard.press(key);
    await new Promise((r) => setTimeout(r, humanDelay(120, 350)));
    lastKnownUrl = pageInstance.url();
    return true;
  } catch (error) {
    logger.error(`[Browser] Key press failed: ${summarizeError(error)}`);
    return false;
  }
}

export async function waitForSelector(
  selector: string,
  state: "attached" | "detached" | "visible" | "hidden" = "visible",
  timeoutMs = getNumericConfig("BROWSER_ELEMENT_TIMEOUT_MS", 8000),
): Promise<boolean> {
  await initBrowser();
  ensureInteractiveBrowserAvailable();

  try {
    await pageInstance.waitForSelector(selector, {
      state,
      timeout: timeoutMs,
    });
    lastKnownUrl = pageInstance.url();
    return true;
  } catch (error) {
    logger.warn(
      `[Browser] wait_for_selector failed: ${summarizeError(error)}`,
    );
    return false;
  }
}

export async function scroll(
  direction: "up" | "down",
  amount = 400,
): Promise<boolean> {
  await initBrowser();
  ensureInteractiveBrowserAvailable();

  const delta = direction === "down" ? amount : -amount;
  await pageInstance.mouse.wheel(0, delta);
  await new Promise((r) => setTimeout(r, humanDelay(300, 900)));
  lastKnownUrl = pageInstance.url();
  return true;
}

export async function capture() {
  await initBrowser();
  ensureInteractiveBrowserAvailable();
  lastKnownUrl = pageInstance.url();
  return await pageInstance.screenshot({ type: "png", fullPage: false });
}

export async function executeAction(input: BrowserActionInput): Promise<string> {
  const selector = input.selector || input.target || "";
  const direction = input.direction === "up" ? "up" : "down";
  const amount =
    typeof input.amount === "number" && Number.isFinite(input.amount)
      ? input.amount
      : 400;

  if (input.action === "status") {
    return `Browser Status: ${JSON.stringify(getStatus())}`;
  }

  if (input.action === "inspect") {
    return await inspect();
  }

  if (input.action === "navigate") {
    return await navigate(
      input.url || lastKnownUrl,
      input.waitUntil,
      input.waitMs,
    );
  }

  if (input.action === "click") {
    if (!selector) {
      return "Browser action click requires selector or target.";
    }
    const clicked = await click(selector);
    const snapshot = await inspect();
    return `${clicked ? `Clicked selector: ${selector}` : `Failed to click selector: ${selector}`}\n${snapshot}`;
  }

  if (input.action === "type") {
    if (!selector || !input.text) {
      return "Browser action type requires selector/target and text.";
    }
    const typed = await type(selector, input.text);
    const snapshot = await inspect();
    return `${typed ? `Typed into selector: ${selector}` : `Failed to type into selector: ${selector}`}\n${snapshot}`;
  }

  if (input.action === "submit") {
    const submitted = await submit(selector || "form");
    const snapshot = await inspect();
    return `${submitted ? `Submitted form: ${selector || "form"}` : `Failed to submit form: ${selector || "form"}`}\n${snapshot}`;
  }

  if (input.action === "select") {
    if (!selector || !input.value) {
      return "Browser action select requires selector/target and value.";
    }
    const selected = await select(selector, input.value);
    const snapshot = await inspect();
    return `${selected ? `Selected value ${input.value} in ${selector}` : `Failed to select value ${input.value} in ${selector}`}\n${snapshot}`;
  }

  if (input.action === "press") {
    const key = input.key || input.text;
    if (!key) {
      return "Browser action press requires key.";
    }
    const pressed = await press(key, selector || undefined);
    const snapshot = await inspect();
    return `${pressed ? `Pressed key: ${key}` : `Failed to press key: ${key}`}\n${snapshot}`;
  }

  if (input.action === "wait_for_selector") {
    if (!selector) {
      return "Browser action wait_for_selector requires selector or target.";
    }
    const waited = await waitForSelector(
      selector,
      input.state || "visible",
      input.timeoutMs,
    );
    const snapshot = await inspect();
    return `${waited ? `Selector became ${input.state || "visible"}: ${selector}` : `Selector did not reach ${input.state || "visible"}: ${selector}`}\n${snapshot}`;
  }

  if (input.action === "scroll") {
    const scrolled = await scroll(direction, amount);
    const snapshot = await inspect();
    return `${scrolled ? `Scrolled ${direction} by ${amount}px.` : `Failed to scroll ${direction}.`}\n${snapshot}`;
  }

  if (input.action === "capture") {
    const image = await capture();
    return `[screenshot captured: ${image.length} bytes]`;
  }

  return `Unknown browser action: ${input.action}`;
}

export async function close() {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
    pageInstance = null;
  }
  browserInitError = null;
  browserDisabledUntil = 0;
  return true;
}

export async function getPageContent() {
  if (!pageInstance) return "";
  return await pageInstance.content();
}

export default {
  initBrowser,
  getStatus,
  inspect,
  navigate,
  click,
  type,
  submit,
  select,
  press,
  waitForSelector,
  scroll,
  capture,
  executeAction,
  close,
  getPageContent,
};
