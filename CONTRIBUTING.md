# Contributing to @hotlap/telemetry

Thank you for your interest in contributing to the HotLap.ai telemetry SDK!

## Getting Started

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/telemetry.git
   cd telemetry
   ```
3. Install dependencies:
   ```bash
   bun install
   ```
4. Create a branch for your changes:
   ```bash
   git checkout -b feature/your-feature-name
   ```

## Development

### Prerequisites

- [Bun](https://bun.sh) >= 1.0.0
- Windows (required for live telemetry testing)
- iRacing (for testing live telemetry features)

### Running the Project

```bash
# Run the CLI in watch mode
bun run dev

# Run the telemetry server
bun run server

# Run tests
bun run test

# Run benchmarks
bun run bench

# Type check
bun run typecheck
```

### Project Structure

```
src/
  binary-reader.ts  # Low-level binary parsing utilities
  cli.ts            # Command-line interface
  constants.ts      # iRacing SDK constants and enums
  ibt.ts            # IBT file parser
  index.ts          # Main exports
  live.ts           # Live telemetry via Windows FFI
  telemetry-server.ts  # WebSocket server for streaming
  types.ts          # TypeScript type definitions
```

## Code Style

- Use TypeScript for all new code
- Follow existing code patterns and naming conventions
- Use meaningful variable and function names
- Keep functions focused and small
- Add types for all function parameters and return values

## Commit Messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

**Types:**
- `feat` - New feature
- `fix` - Bug fix
- `docs` - Documentation only
- `style` - Code style (formatting, etc.)
- `refactor` - Code refactoring
- `perf` - Performance improvement
- `test` - Adding/updating tests
- `chore` - Maintenance tasks

**Examples:**
```
feat(ibt): add support for parsing stint data
fix(live): handle disconnection gracefully
docs: update API reference for IRSDK class
perf(binary-reader): optimize variable batch reading
```

## Pull Requests

1. Ensure your code follows the existing style
2. Update documentation if needed
3. Add tests for new functionality
4. Make sure all tests pass: `bun run test`
5. Make sure types are correct: `bun run typecheck`
6. Write a clear PR description explaining your changes

## Reporting Issues

When reporting issues, please include:

- Bun version (`bun --version`)
- Operating system and version
- iRacing version (if applicable)
- Steps to reproduce the issue
- Expected vs actual behavior
- Any error messages or logs

## Feature Requests

We welcome feature requests! Please open an issue describing:

- The problem you're trying to solve
- Your proposed solution
- Any alternatives you've considered

## Questions?

Feel free to open an issue for any questions about contributing.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
