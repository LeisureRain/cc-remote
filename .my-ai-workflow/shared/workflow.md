# Workflow

## Branching

- Repository documentation says this is a solo project using direct commits to `master`.
- Do not create feature branches unless explicitly requested.
- Keep branch-specific progress in `.my-ai-workflow/branches/{branch}.md`.

## Commit Workflow

- Commit once a logical change is complete and sanity-checked.
- Group commits by component or feature.
- Use Conventional Commit messages such as `feat(server): ...`, `fix(android): ...`, `docs: ...`, or `chore: ...`.
- Include a `Co-Authored-By` trailer in commit messages.
- Do not push to `origin` unless the user asks.

## Release Workflow

- Root `VERSION` is the source of truth.
- `node tools/sync-version.mjs` propagates version fields.
- `node package-win.mjs` builds the Windows launcher release artifact into `dist/`.
- `node package-android.mjs` builds the signed Android release APK into `dist/`.

## CI Workflow

- No CI workflow files were found during initialization.

## Development Commands

- Server dev:
  - `cd server`
  - `npm start`
  - `npm run dev`
- Root packaging:
  - `node package-win.mjs`
  - `node package-android.mjs`
- Android debugging commands exist in Gradle/CLAUDE docs, but the project-specific default for Android release packaging is the root packaging script.

## Unknowns

- PR/review workflow is not inferable from repository files.
- Automated release publishing workflow is not inferable from repository files.
