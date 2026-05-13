# Repository Guidelines

## Project Structure & Module Organization
- `src/main/`: Electron main process (app lifecycle, windows, native integrations).
- `src/renderer/`: UI assets loaded by Electron (`index.html`, `renderer.js`, `style.css`).
- `src/shared/`: Pure utilities shared between processes.
- `tests/`: Vitest unit tests, e.g. `tests/math.test.ts`.
- `assets/`, `docs/`, `scripts/`: static assets, design notes, and helper scripts.

## Build, Test, and Development Commands
Node.js 20+ and npm are assumed.
- `npm run dev`: compile TypeScript and launch Electron.
- `npm run build`: compile the main/preload code to `dist/`.
- `npm run lint`: run ESLint across `src/` and `tests/`.
- `npm run format`: apply Prettier formatting; `npm run format:check` for CI.
- `npm run test`: run Vitest once; `npm run test:watch` for watch mode.

## Coding Style & Naming Conventions
- Formatting is enforced by Prettier (`.prettierrc.json`); do not hand-format around it.
- ESLint uses `@typescript-eslint` rules; fix warnings before opening a PR.
- Filenames: `lowercase-kebab-case` for files/folders.
- Types/classes: `PascalCase`; functions/variables: `camelCase`; constants: `UPPER_SNAKE_CASE`.

## Testing Guidelines
- Use Vitest; name tests `*.test.ts` under `tests/`.
- Prefer deterministic units from `src/shared/` for fast coverage.
- If behavior is hard to test (native dialogs, OS hooks), explain the gap in the PR.

## Commit & Pull Request Guidelines
- Use Conventional Commits (`feat: ...`, `fix: ...`, `chore: ...`).
- PRs should include: change summary, testing steps, and screenshots/recordings for UI changes.

## Deployment & Operations
- Server deployment is documented in `docs/deploy.md`.
- The server repo is separate; the deployment entrypoint is `/opt/netcrosses-server/dist/server/index.js` using `/root/.nvm/versions/node/v20.19.6/bin/node`.
- Control port is `7001/tcp`; tunnel ports are `10000-10099/tcp`.
- Keep tokens secret and rotate them when operators or clients change.

## Security & Configuration Tips
- Do not commit secrets. Use `.env` locally and check in `.env.example`.
- Keep OS-specific paths out of code; use `app.getPath()` or config values instead.
