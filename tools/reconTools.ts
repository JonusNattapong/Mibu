/**
 * reconTools.ts — Elite Reconnaissance Toolkit for AuditorAi
 *
 * 7 Autonomous Recon Tools:
 *  1. dns_recon          — DNS Record Enumeration + SPF/DKIM/DMARC analysis
 *  2. http_header_audit  — Security Header Analysis
 *  3. ssl_inspect        — SSL/TLS Certificate Inspection
 *  4. secret_scanner     — Hardcoded Secret Detection
 *  5. wayback_lookup     — Historical Endpoint Discovery
 *  6. port_probe         — Service Port Scanning
 *  7. web_spider         — Lightweight Internal Link Crawler
 */

import dns from "dns/promises";
import tls from "tls";
import net from "net";
import fs from "fs";
import path from "path";
import axios from "axios";
import * as cheerio from "cheerio";
import stealthEngine from "../src/runtime/stealthEngine";
import pLimit from "p-limit";
import { logger } from "../src/runtime/logger";

interface ReconFinding {
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO" | "WARNING" | "OK";
  issue?: string;
  header?: string;
  name?: string;
  status?: string;
  value?: string;
  detail?: string;
  port?: number;
  service?: string;
  risk?: string;
}

interface DNSReconResult {
  domain: string;
  records: Record<string, any>;
  findings: ReconFinding[];
  summary: string;
}

interface HeaderAuditResult {
  url: string;
  statusCode: number;
  findings: ReconFinding[];
  summary: string;
}

interface SSLInspectResult {
  host?: string;
  protocol?: string;
  cipher?: any;
  certificate?: any;
  findings: ReconFinding[];
  summary?: string;
  error?: string;
}

interface SecretFinding {
  type: string;
  file: string;
  line: number;
  snippet: string;
  match: string;
}

interface SecretScanResult {
  scannedDir: string;
  totalFindings: number;
  findings: SecretFinding[];
  summary: string;
}

interface WaybackResult {
  url: string;
  totalSnapshots?: number;
  uniqueUrls?: number;
  interestingEndpoints?: string[];
  recentSnapshots?: any[];
  snapshots?: any[];
  summary?: string;
  error?: string;
}

interface PortResult {
  port: number;
  status: "OPEN" | "CLOSED" | "FILTERED";
  service: string;
}

interface PortProbeResult {
  host: string;
  totalScanned: number;
  openPorts: PortResult[];
  findings: ReconFinding[];
  allResults: PortResult[];
  summary: string;
}

interface SpiderResult {
  baseUrl: string;
  totalDiscovered: number;
  highValueTargets: string[];
  allUrls: string[];
  summary: string;
}

// ═══════════════════════════════════════════════════════════════
// 1. DNS RECON — Full DNS Record Enumeration
// ═══════════════════════════════════════════════════════════════
export async function dnsRecon(domain: string): Promise<DNSReconResult> {
  const records: Record<string, any> = {};
  const tasks = [
    { type: "A", fn: () => dns.resolve(domain, "A") },
    { type: "AAAA", fn: () => dns.resolve(domain, "AAAA") },
    { type: "MX", fn: () => dns.resolve(domain, "MX") },
    { type: "TXT", fn: () => dns.resolve(domain, "TXT") },
    { type: "NS", fn: () => dns.resolve(domain, "NS") },
    { type: "CNAME", fn: () => dns.resolve(domain, "CNAME") },
    { type: "SOA", fn: () => dns.resolveSoa(domain) },
  ];

  const TIMEOUT_MS = 5000;

  for (const task of tasks) {
    try {
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("DNS Timeout")), TIMEOUT_MS)
      );
      records[task.type] = await Promise.race([task.fn(), timeoutPromise]);
    } catch {
      records[task.type] = [];
    }
  }

  const findings: ReconFinding[] = [];
  const txtRecords = (records.TXT || []).flat() as string[];

  if (!txtRecords.some((t) => t.includes("v=spf1"))) {
    findings.push({
      severity: "MEDIUM",
      issue: "No SPF record found — email spoofing possible",
    });
  }
  if (!txtRecords.some((t) => t.includes("v=DKIM"))) {
    findings.push({ severity: "LOW", issue: "No DKIM record found" });
  }
  if (!txtRecords.some((t) => t.includes("v=DMARC") || t.includes("_dmarc"))) {
    findings.push({
      severity: "MEDIUM",
      issue: "No DMARC record found — phishing risk",
    });
  }
  if (records.MX && records.MX.length > 0) {
    const exchanges = records.MX.map((m: any) => m.exchange || m).join(", ");
    findings.push({ severity: "INFO", issue: `Mail servers: ${exchanges}` });
  }

  return {
    domain,
    records,
    findings,
    summary: `Resolved ${Object.values(records).flat().length} records across ${Object.keys(records).length} types.`,
  };
}

// ═══════════════════════════════════════════════════════════════
// 2. HTTP HEADER AUDIT — Security Header Analysis
// ═══════════════════════════════════════════════════════════════
export async function httpHeaderAudit(url: string): Promise<HeaderAuditResult> {
  const res = await axios.get(url, {
    validateStatus: () => true,
    timeout: 10000,
    headers: stealthEngine.getTacticalHeaders(),
    maxRedirects: 5,
  });

  const headers = res.headers;
  const findings: ReconFinding[] = [];

  const securityHeaders: Record<
    string,
    { name: string; severity: ReconFinding["severity"] }
  > = {
    "strict-transport-security": { name: "HSTS", severity: "HIGH" },
    "content-security-policy": { name: "CSP", severity: "HIGH" },
    "x-frame-options": { name: "Clickjacking Protection", severity: "MEDIUM" },
    "x-content-type-options": {
      name: "MIME Sniffing Protection",
      severity: "MEDIUM",
    },
    "x-xss-protection": { name: "XSS Filter (Legacy)", severity: "LOW" },
    "referrer-policy": { name: "Referrer Policy", severity: "LOW" },
    "permissions-policy": { name: "Permissions Policy", severity: "LOW" },
    "cross-origin-opener-policy": { name: "COOP", severity: "LOW" },
    "cross-origin-resource-policy": { name: "CORP", severity: "LOW" },
  };

  for (const [header, meta] of Object.entries(securityHeaders)) {
    if (!headers[header]) {
      findings.push({
        severity: meta.severity,
        header,
        name: meta.name,
        status: "MISSING",
      });
    } else {
      findings.push({
        severity: "OK",
        header,
        name: meta.name,
        status: "PRESENT",
        value: headers[header] as string,
      });
    }
  }

  // Information Disclosure
  if (headers["server"]) {
    findings.push({
      severity: "MEDIUM",
      header: "server",
      name: "Server Version Disclosure",
      value: headers["server"] as string,
    });
  }
  if (headers["x-powered-by"]) {
    findings.push({
      severity: "MEDIUM",
      header: "x-powered-by",
      name: "Technology Disclosure",
      value: headers["x-powered-by"] as string,
    });
  }
  if (headers["x-aspnet-version"]) {
    findings.push({
      severity: "HIGH",
      header: "x-aspnet-version",
      name: "ASP.NET Version Leak",
      value: headers["x-aspnet-version"] as string,
    });
  }

  // Cookie Analysis
  const setCookie = headers["set-cookie"];
  if (setCookie) {
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const cookie of cookies) {
      const cookieLower = cookie.toLowerCase();
      const cookieName = cookie.split(";")[0];

      if (!cookieLower.includes("httponly")) {
        findings.push({
          severity: "HIGH",
          header: "set-cookie",
          name: "Cookie missing HttpOnly flag",
          value: cookieName,
        });
      }
      if (!cookieLower.includes("secure")) {
        findings.push({
          severity: "MEDIUM",
          header: "set-cookie",
          name: "Cookie missing Secure flag",
          value: cookieName,
        });
      }
      if (!cookieLower.includes("samesite")) {
        findings.push({
          severity: "MEDIUM",
          header: "set-cookie",
          name: "Cookie missing SameSite attribute",
          value: cookieName,
        });
      }
    }
  }

  const missing = findings.filter((f) => f.status === "MISSING").length;
  const critical = findings.filter((f) => f.severity === "HIGH").length;

  return {
    url,
    statusCode: res.status,
    findings,
    summary: `${missing} security headers missing, ${critical} high-severity issues found.`,
  };
}

// ═══════════════════════════════════════════════════════════════
// 3. SSL INSPECT — Certificate & Protocol Analysis
// ═══════════════════════════════════════════════════════════════
export function sslInspect(targetUrl: string): Promise<SSLInspectResult> {
  return new Promise((resolve) => {
    try {
      const urlObj = new URL(targetUrl);
      const host = urlObj.hostname;
      const port = parseInt(urlObj.port) || 443;

      const socket = tls.connect(
        { host, port, servername: host, rejectUnauthorized: false },
        () => {
          const cert = socket.getPeerCertificate();
          const protocol = socket.getProtocol();
          const cipher = socket.getCipher() as any;

          const result: SSLInspectResult = {
            host,
            protocol: protocol || undefined,
            cipher: cipher
              ? {
                  name: cipher.name,
                  version: cipher.version,
                  bits: cipher.bits,
                }
              : null,
            certificate: {
              subject: cert.subject,
              issuer: cert.issuer,
              validFrom: cert.valid_from,
              validTo: cert.valid_to,
              serialNumber: cert.serialNumber,
              fingerprint: cert.fingerprint256 || cert.fingerprint,
              subjectAltNames: cert.subjectaltname || "None",
            },
            findings: [],
          };

          // Expiry check
          const expiry = new Date(cert.valid_to);
          const daysLeft = Math.ceil(
            (expiry.getTime() - Date.now()) / 86400000,
          );
          if (expiry < new Date()) {
            result.findings.push({
              severity: "CRITICAL",
              issue: "Certificate EXPIRED",
              detail: `Expired on ${cert.valid_to}`,
            });
          } else if (daysLeft < 30) {
            result.findings.push({
              severity: "WARNING",
              issue: `Certificate expires in ${daysLeft} days`,
              detail: cert.valid_to,
            });
          }

          // Weak protocol
          if (
            protocol &&
            (protocol.includes("TLSv1.0") ||
              protocol.includes("TLSv1.1") ||
              protocol.includes("SSLv"))
          ) {
            result.findings.push({
              severity: "HIGH",
              issue: `Weak protocol: ${protocol}`,
              detail: "Upgrade to TLSv1.2 or TLSv1.3",
            });
          }

          // Self-signed
          if (
            cert.issuer &&
            cert.subject &&
            JSON.stringify(cert.issuer) === JSON.stringify(cert.subject)
          ) {
            result.findings.push({
              severity: "HIGH",
              issue: "Self-signed certificate detected",
            });
          }

          // Weak cipher
          if (cipher && (cipher as any).bits && (cipher as any).bits < 128) {
            result.findings.push({
              severity: "HIGH",
              issue: `Weak cipher: ${cipher.name} (${(cipher as any).bits}-bit)`,
            });
          }

          result.summary =
            result.findings.length === 0
              ? "SSL/TLS configuration looks healthy."
              : `${result.findings.length} issues detected in SSL/TLS configuration.`;

          socket.end();
          resolve(result);
        },
      );

      socket.on("error", (err) => {
        resolve({
          host,
          error: err.message,
          findings: [{ severity: "CRITICAL", issue: err.message }],
        });
      });

      socket.setTimeout(10000, () => {
        socket.destroy();
        resolve({
          host,
          error: "Connection timeout",
          findings: [
            { severity: "WARNING", issue: "SSL connection timed out" },
          ],
        });
      });
    } catch (e: any) {
      resolve({ error: e.message, findings: [], summary: "" });
    }
  });
}

// ═══════════════════════════════════════════════════════════════
// 4. SECRET SCANNER — Hardcoded Secret Detection
// ═══════════════════════════════════════════════════════════════
export async function secretScanner(
  targetDir: string,
  maxDepth: number = 5,
): Promise<SecretScanResult> {
  const limit = pLimit(10); // Scan 10 ports/ips at once

  const patterns = [
    { name: "AWS Access Key ID", regex: /AKIA[0-9A-Z]{16}/g },
    {
      name: "AWS Secret Key",
      regex: /(?:aws_secret|secret_access_key)[\s:="']+([A-Za-z0-9/+=]{40})/gi,
    },
    {
      name: "Generic API Key",
      regex: /(?:api[_-]?key|apikey|api_token)[\s:="']+([A-Za-z0-9_\-]{20,})/gi,
    },
    {
      name: "Generic Secret",
      regex: /(?:secret|password|passwd|pwd|token)[\s:="']+([^\s"']{8,64})/gi,
    },
    {
      name: "JWT Token",
      regex: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g,
    },
    {
      name: "Private Key",
      regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
    },
    { name: "GitHub Token", regex: /gh[pousr]_[A-Za-z0-9_]{36,}/g },
    { name: "Slack Token", regex: /xox[baprs]-[0-9]{10,}-[A-Za-z0-9]{10,}/g },
    { name: "Google API Key", regex: /AIzaSy[A-Za-z0-9_-]{33}/g },
    { name: "Stripe Key", regex: /(?:sk|pk)_(?:test|live)_[A-Za-z0-9]{20,}/g },
    {
      name: "Database URL",
      regex: /(?:mongodb|postgres|mysql|redis):\/\/[^\s"']+/gi,
    },
    { name: "Bearer Token", regex: /Bearer\s+[A-Za-z0-9._\-]{20,}/g },
  ];

  const skipDirs = new Set([
    "node_modules", ".git", "dist", "build", ".next", "vendor", "__pycache__", ".venv",
  ]);
  const skipExts = new Set([
    ".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".ttf", ".eot", ".mp4", ".mp3", ".zip", ".tar", ".gz", ".lock",
  ]);
  const findings: SecretFinding[] = [];

  async function scanDir(dir: string, depth: number) {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const tasks = entries.map((entry) => 
      limit(async () => {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          if (!skipDirs.has(entry.name)) await scanDir(fullPath, depth + 1);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (skipExts.has(ext)) return;

          try {
            const stat = await fs.promises.stat(fullPath);
            if (stat.size > 1024 * 1024) return;
            const content = await fs.promises.readFile(fullPath, "utf8");

            for (const pattern of patterns) {
              pattern.regex.lastIndex = 0;
              let match: RegExpExecArray | null;
              while ((match = pattern.regex.exec(content)) !== null) {
                const lines = content.substring(0, match.index).split("\n");
                const lineNum = lines.length;
                const line = lines[lineNum - 1] || "";

                if (line.includes("example") || line.includes("placeholder") || line.includes("TODO"))
                  continue;

                findings.push({
                  type: pattern.name,
                  file: path.relative(targetDir, fullPath),
                  line: lineNum,
                  snippet: line.trim().substring(0, 120),
                  match: match[0].substring(0, 60),
                });
              }
            }
          } catch {}
        }
      })
    );
    await Promise.all(tasks);
  }

  await scanDir(targetDir, 0);

  return {
    scannedDir: targetDir,
    totalFindings: findings.length,
    findings: findings.slice(0, 50),
    summary:
      findings.length === 0
        ? "No hardcoded secrets detected."
        : `Found ${findings.length} potential secret(s) in source code.`,
  };
}

// ═══════════════════════════════════════════════════════════════
// 5. WAYBACK LOOKUP
// ═══════════════════════════════════════════════════════════════
export async function waybackLookup(url: string): Promise<WaybackResult> {
  try {
    const apiUrl = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}/*&output=json&limit=100&fl=timestamp,original,statuscode,mimetype&collapse=urlkey`;
    const res = await axios.get(apiUrl, {
      timeout: 20000,
      headers: stealthEngine.getTacticalHeaders(),
    });

    const data = res.data as any[];

    if (!Array.isArray(data) || data.length < 2) {
      return { url, snapshots: [], summary: "No archived snapshots found." };
    }

    const headers = data[0];
    const rows = data.slice(1);
    const snapshots = rows.map((row: any[]) => {
      const obj: any = {};
      headers.forEach((h: string, i: number) => {
        obj[h] = row[i];
      });
      return obj;
    });

    const uniqueUrls = [...new Set(snapshots.map((s: any) => s.original))];
    const interestingPatterns = [
      /admin/i,
      /login/i,
      /api/i,
      /debug/i,
      /test/i,
      /backup/i,
      /config/i,
      /\.env/i,
      /\.git/i,
      /phpinfo/i,
      /wp-admin/i,
      /\.sql/i,
      /\.bak/i,
      /\.old/i,
      /dashboard/i,
      /panel/i,
      /interestingEndpoints/i,
    ];

    const interestingEndpoints = uniqueUrls.filter((u) =>
      interestingPatterns.some((p) => p.test(u)),
    );

    return {
      url,
      totalSnapshots: snapshots.length,
      uniqueUrls: uniqueUrls.length,
      interestingEndpoints,
      recentSnapshots: snapshots.slice(-10),
      summary: `Found ${uniqueUrls.length} unique URLs across ${snapshots.length} snapshots. ${interestingEndpoints.length} potentially interesting endpoints discovered.`,
    };
  } catch (e: any) {
    return {
      url,
      error: e.message,
      summary: `Wayback lookup failed: ${e.message}`,
    };
  }
}

// ═══════════════════════════════════════════════════════════════
// 6. PORT PROBE
// ═══════════════════════════════════════════════════════════════
function probePort(
  host: string,
  port: number,
  timeout: number = 3000,
): Promise<PortResult> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeout);

    socket.on("connect", () => {
      socket.destroy();
      resolve({ port, status: "OPEN", service: "" });
    });

    socket.on("timeout", () => {
      socket.destroy();
      resolve({ port, status: "FILTERED", service: "" });
    });

    socket.on("error", () => {
      socket.destroy();
      resolve({ port, status: "CLOSED", service: "" });
    });

    socket.connect(port, host);
  });
}

export async function portProbe(
  host: string,
  customPorts?: number[],
): Promise<PortProbeResult> {
  const commonPorts = [
    { port: 21, service: "FTP" },
    { port: 22, service: "SSH" },
    { port: 23, service: "Telnet" },
    { port: 25, service: "SMTP" },
    { port: 80, service: "HTTP" },
    { port: 443, service: "HTTPS" },
    { port: 3306, service: "MySQL" },
    { port: 5432, service: "PostgreSQL" },
    { port: 1433, service: "MSSQL" },
    { port: 3389, service: "RDP" },
    { port: 6379, service: "Redis" },
    { port: 27017, service: "MongoDB" },
    { port: 9200, service: "Elastic" },
    { port: 5601, service: "Kibana" },
    { port: 8080, service: "HTTP-ALT" },
    { port: 8443, service: "HTTPS-ALT" },
    { port: 9000, service: "Sonarqube/Portainer" },
  ];

  const portsToScan = customPorts
    ? customPorts.map((p) => ({ port: p, service: "Custom" }))
    : commonPorts;

  const results: PortResult[] = [];
  for (let i = 0; i < portsToScan.length; i += 10) {
    const batch = portsToScan.slice(i, i + 10);
    const batchResults = await Promise.all(
      batch.map(async (p) => {
        const result = await probePort(host, p.port);
        return { ...result, service: p.service };
      }),
    );
    results.push(...batchResults);
  }

  const openPorts = results.filter((r) => r.status === "OPEN");
  const findings: ReconFinding[] = [];

  const dangerousPorts: Record<number, string> = {
    23: "Telnet (unencrypted)",
    3389: "RDP (brute-force target)",
    6379: "Redis (often unauthenticated)",
    27017: "MongoDB (often unauthenticated)",
    9200: "Elasticsearch (data exposure)",
  };

  for (const open of openPorts) {
    if (dangerousPorts[open.port]) {
      findings.push({
        severity: "HIGH",
        port: open.port,
        service: open.service,
        risk: dangerousPorts[open.port],
      });
    }
  }

  return {
    host,
    totalScanned: results.length,
    openPorts,
    findings,
    allResults: results,
    summary: `${openPorts.length}/${results.length} ports open. ${findings.length} high-risk services detected.`,
  };
}

// ═══════════════════════════════════════════════════════════════
// 7. WEB SPIDER — Lightweight Crawler
// ═══════════════════════════════════════════════════════════════
export async function webSpider(
  baseUrl: string,
  limit: number = 50,
): Promise<SpiderResult> {
  const visited = new Set<string>();
  const queue: string[] = [baseUrl];
  const discovered: string[] = [];
  const urlObj = new URL(baseUrl);
  const targetHost = urlObj.hostname;

  while (queue.length > 0 && discovered.length < limit) {
    const currentUrl = queue.shift()!;
    if (visited.has(currentUrl)) continue;
    visited.add(currentUrl);

    try {
      const res = await axios.get(currentUrl, {
        timeout: 5000,
        headers: stealthEngine.getTacticalHeaders(),
        validateStatus: (status) => status === 200,
      });

      const $ = cheerio.load(res.data);
      discovered.push(currentUrl);

      $("a").each((_, el) => {
        const href = $(el).attr("href");
        if (!href) return;

        try {
          const absoluteUrl = new URL(href, currentUrl);
          const cleanUrl = absoluteUrl.href.split("#")[0] || "";

          if (
            cleanUrl &&
            absoluteUrl.hostname === targetHost &&
            absoluteUrl.protocol.startsWith("http") &&
            !visited.has(cleanUrl)
          ) {
            queue.push(cleanUrl);
          }
        } catch {}
      });
    } catch {
      // Skip failed requests
    }
  }

  const interestingPatterns = [
    /admin/i,
    /api/i,
    /v1/i,
    /v2/i,
    /config/i,
    /login/i,
    /upload/i,
    /debug/i,
  ];
  const highValue = discovered.filter((url) =>
    interestingPatterns.some((p) => p.test(url)),
  );

  return {
    baseUrl,
    totalDiscovered: discovered.length,
    highValueTargets: highValue,
    allUrls: discovered,
    summary: `Crawled ${discovered.length} internal links. Found ${highValue.length} high-value targets.`,
  };
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════
export default {
  dnsRecon,
  httpHeaderAudit,
  sslInspect,
  secretScanner,
  waybackLookup,
  portProbe,
  webSpider,
};
