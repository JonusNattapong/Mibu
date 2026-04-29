# Tools Agent Really Needs in Production

## Core Principle

> **Agent doesn't need many tools, but needs tools that can split tasks**
> Don't create task-specific tools, create general-purpose tools that the Agent can apply creatively

---

## Tier 0: Must Have (Critical)

| Tool | Priority | Reason |
|---|---|---|
| `memory_read` / `memory_write` | 10/10 | Agent forgets everything between sessions. Persistent memory is essential. |
| `schedule_task` | 10/10 | Agent must be able to schedule future work, check back periodically, repeat tasks |
| `spawn_background_process` | 10/10 | Run long-running programs while Agent works on other things |
| `ask_human` | 9/10 | When stuck, Agent must be able to ask for help |
| `stop_self` | 9/10 | Agent must be able to stop when done or when it knows it can't succeed |

---

## Tier 1: 10x Performance Boost

| Tool | Priority | Reason |
|---|---|---|
| `search_file` / `grep` | 9/10 | Search thousands of files in 1 second |
| `git_commit` / `git_restore` | 9/10 | Agent must be able to rollback when it breaks code |
| `http_request` | 8/10 | Call any API directly without browser |
| `extract_text` | 8/10 | Read PDF, Word, Excel, Image OCR automatically |
| `run_code` | 8/10 | Execute Python / JS / Powershell in sandbox immediately |

---

## Tier 2: Nice to Have

| Tool | Priority |
|---|---|
| `send_notification` | 7/10 |
| `upload_file` | 7/10 |
| `open_browser` | 7/10 |
| `take_screenshot` | 6/10 |
| `get_system_info` | 6/10 |
| `kill_process` | 6/10 |
| `netstat` / `port_scan` | 6/10 |

---

## Tools NOT to Create

- `install_npm_package` → Use `run_command npm install` instead
- `create_react_app` → Use `run_command npx create-react-app` instead
- `scan_vulnerability` → Use `run_command nuclei` instead

> **Golden Rule:** If it can be done with `run_command`, don't create a new tool

---

## Priority Implementation Order

1. Add `memory_read` / `memory_write` first
2. Add `spawn_background_process`
3. Add `schedule_task`
4. Add `ask_human`
5. Add `search_file` / grep

Everything else the Agent can already do with existing tools
