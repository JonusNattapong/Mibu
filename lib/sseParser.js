/**
 * Robust SSE Parser for Reverse Engineer
 * Parses Server-Sent Events (SSE) from AI Providers and the local API gateway.
 */
class SSEParser {
  constructor(onEvent) {
    this.buffer = "";
    this.onEvent = onEvent;
  }

  feed(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    
    // Keep incomplete line in buffer
    this.buffer = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) continue;
      
      const data = trimmed.replace("data: ", "").trim();
      if (data === "[DONE]") {
        this.onEvent({ type: "done" });
      } else {
        try {
          const json = JSON.parse(data);
          this.onEvent({ type: "data", data: json });
        } catch (e) {
          // Fragmented JSON or parse error, skip or log
        }
      }
    }
  }
}

module.exports = { SSEParser };
