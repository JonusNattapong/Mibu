# PROMPTINJECTION (v1.2.0)

![PROMPTINJECTION - Offensive AI Research Lab](https://raw.githubusercontent.com/JonusNattapong/DeepResearch/main/assets/title.png)

> **Autonomous Intelligence & Deep Strategic Technical Research**
> Advanced investigative research platform and codebase analysis powered by Autonomous Swarm Agents.

---

## System Overview

PROMPTINJECTION LAB is an offensive security research platform designed for analyzing AI Agent vulnerabilities, strategic logic investigation, and system hardening. The system utilizes a coordinated swarm of AI agents to deliver high-fidelity research and exploitation blueprints.

---

## New Features in v1.2.0 (The Swarm Update)

### 1. Parallel Research Engine

The system can now spawn and manage multiple sub-agents simultaneously:

- **Concurrent Execution**: Search Google, Wikipedia, and ArXiv in parallel within a single turn.
- **High Throughput**: Process large volumes of data faster than traditional sequential agent systems.

### 2. Autonomous Swarm Delegation (Friend Agents)

The lead agent can now delegate specific tasks to other AI models:

- **Task Delegation**: If the primary model (e.g., GPT-4o-mini) reaches its limits, it can autonomously route sub-tasks to specialized models like Claude 3.5 or Gemini 1.5.
- **Cross-Provider Synergy**: Combine the strengths of different providers (OpenAI, Anthropic, Google, KiloCode) within a single mission.

### 3. Multimodal Vision Capabilities

Support for visual data analysis:

- **Autonomous Screenshotting**: Capture and analyze screenshots of complex charts, graphs, or UI layouts automatically.
- **Vision Analysis**: Utilize the vision_analyze tool to interpret visual data and integrate findings into the final report.

### 4. Advanced Browser Interaction

- **Autonomous Action**: Agents can Click, Type, and Scroll through web pages to uncover deep-seated information.
- **Dynamic Exploration**: Full support for Single Page Applications (SPA) and interactive websites.

---

## Operational Modes

### Global Intelligence Mission

Designed for free-form research on any topic. The system acts as a Lead Investigative Analyst to generate a Deep Intelligence Dossier with verifiable citations.

### Strategic Code Analysis

- Analyze codebases from GitHub or Local Paths.
- Synthesize technical blueprints for developers or Coder AI.
- Inspect deep architectural structures and data flows.

---

## Interfaces

### Intelligence Command Center (Web)

- Modern Bento UI layout focused on clarity.
- Live Swarm Streaming showing real-time agent activities and tool usage.

### Hacker-Grade TUI (Terminal)

- Professional CLI experience designed for engineering workflows.
- Real-time tool logs (e.g., [Delegation], [Browser]) providing full transparency of the agent's actions.

---

## Configuration

The system supports **Auto-Discovery Keys**, automatically selecting the best available provider based on your configured API keys.

```env
# Set via the [*] Configure menu in the TUI
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
GEMINI_API_KEY=...
KILOCODE_API_KEY=...
GITHUB_TOKEN=...
```

---

## Getting Started

### Quick Start (No installation)

```bash
npx prompt-injection
# or
npx pi
```

### Local Installation

```bash
npm install -g promptinjection
pi
```

**PROMPTINJECTION** — Intelligence at Scale, Autonomy without Limits.
