# Full TUI Command System Migration Plan

## Architecture Overview

This document outlines the complete migration of the Claude Code command system to REDLOCK.

---

## System Architecture Analysis Completed

### Core Components

| Component | Description | Status |
|---|---|---|
| **Command Registry** | Memoized centralized command loader | Mapped |
| **Command Types** | `local`, `local-jsx`, `prompt`, `resume` | Mapped |
| **Availability Gating** | Auth / Provider based command filtering | Mapped |
| **Dynamic Loading** | Skills, Plugins, Workflows, Bundled commands | Mapped |
| **Bridge Safety** | Remote session command filtering | Mapped |
| **Skill Tool Integration** | Automatic command exposure to agent | Mapped |
| **Cache Management** | Layered memoization invalidation system | Mapped |

---

## Migration Phases

### Phase 1: Core Infrastructure

1. **Base Command Interface**
    - Port `Command` type definition
    - Implement command metadata schema
    - Add aliases, availability, and source tracking

2. **Command Registration System**
    - Implement registry
    - Lazy command loading
    - Plugin / Skill / Workflow integration points

3. **Slash Command Parser**
    - Input line detection `/command args`
    - Command resolution with alias support
    - Argument parsing

### Phase 2: Loading System

1. **Dynamic Sources**
    - Bundled skills
    - Local skill directory commands
    - Plugin commands
    - Workflow script commands

2. **Availability Filtering**
    - Provider based gating
    - Feature flag filtering
    - User type permissions

### Phase 3: System Integration

1. **CLI TUI Integration**
    - Typeahead / autocomplete
    - Command help display
    - Keyboard shortcut system

2. **Agent Integration**
    - Skill Tool command exposure
    - Automatic command discovery
    - Agent invokable commands

### Phase 4: Command Porting

| Priority | Commands |
|---|---|
| HIGH | `/help`, `/status`, `/tasks`, `/clear`, `/exit`, `/model`, `/config`, `/memory` |
| MEDIUM | `/mcp`, `/plugins`, `/skills`, `/review`, `/plan`, `/cost`, `/summary` |
| LOW | All other commands |

---

## Capabilities this will unlock

- Full slash command system with autocomplete
- Dynamic skill and plugin command loading
- Remote session compatible commands
- Agent self-invokable commands
- Layered cache invalidation system
- Professional aesthetic integration
