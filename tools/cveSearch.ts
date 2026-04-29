import axios from "axios";
import logger from "../src/runtime/logger";

export interface CVEResult {
  id: string;
  summary: string;
  cvss?: number;
  published: string;
  references: string[];
}

/**
 * CVE Intelligence Service
 * Integrates with public CVE databases to provide real-time vulnerability data.
 */
export class CVESearcher {
  private static BASE_URL = "https://cve.circl.lu/api/search/";

  /**
   * Search for CVEs based on a product or vendor string.
   */
  public async searchByProduct(product: string): Promise<CVEResult[]> {
    try {
      logger.info({ product }, "Searching CVE database...");
      // The CIRCL API search is /api/search/[vendor]/[product] or just /api/search/[keyword]
      const response = await axios.get(`${CVESearcher.BASE_URL}${encodeURIComponent(product)}`, {
        timeout: 15000,
      });

      if (!Array.isArray(response.data)) {
        // Some APIs return a different structure if only one or no results
        if (response.data && response.data.results) return this.mapResults(response.data.results);
        return [];
      }

      return this.mapResults(response.data);
    } catch (error: any) {
      if (error.response?.status === 404) {
        logger.info({ product }, "No CVE data found for this product (404)");
        return [];
      }
      logger.error({ error: error.message }, "CVE search failed");
      return []; // Return empty instead of throwing to prevent swarm interruption
    }
  }

  /**
   * Get specific CVE details by ID.
   */
  public async getDetails(cveId: string): Promise<any> {
    try {
      const response = await axios.get(`https://cve.circl.lu/api/cve/${cveId}`);
      return response.data;
    } catch (error: any) {
      return { error: `Failed to fetch details for ${cveId}: ${error.message}` };
    }
  }

  private mapResults(data: any[]): CVEResult[] {
    return data.slice(0, 10).map((item: any) => ({
      id: item.id || item.id,
      summary: item.summary || item.Summary || "No summary available.",
      cvss: item.cvss || item.cvss_score || 0,
      published: item.Published || item.published || "Unknown",
      references: item.references || []
    }));
  }
}

export const cveSearcher = new CVESearcher();
