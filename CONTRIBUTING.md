# Contributing to REDLOCK

Thank you for your interest in contributing to REDLOCK.

## Development Setup

```bash
# Install dependencies
bun install

# Start development mode
bun run dev

# Type checking
bun run check
```

## Code Style

- Use Bun runtime idioms
- Strict TypeScript (avoid `any`)
- Use `p-limit` for parallel work
- Use `pino` for logging

## Pull Requests

1. Run `bun run check` before submitting
2. Ensure no secrets or credentials are included
3. Keep changes focused and minimal

## Reporting Issues

Report bugs and feature requests at: [https://github.com/JonusNattapong/RedLock/issues](https://github.com/JonusNattapong/RedLock/issues)
