# Release checklist

Package: **`@linys77/pi-translate`**. The unscoped name belongs to another author.

GitHub releases and npm publication are separate. A GitHub release may be created first; the maintainer publishes **that exact tagged commit** to npm afterward. CI never publishes to npm.

## Prepare and validate

1. Update the version in `package.json` and `package-lock.json` together, and add brief notes at `docs/releases/v<version>.md`.
2. Run from a clean checkout on Node.js 22.19+:

   ```bash
   npm ci --ignore-scripts
   npm run verify
   npm audit --omit=dev
   npm publish --dry-run
   ```

   `verify` checks formatting, strict types, behavioral tests and the actual tarball through Pi's loader. It uses `tar` and cleans up its temporary archive. Only runtime TypeScript, the two READMEs, license, manifest and user-facing behavior docs are packed; no separate build is required.
3. Review [manual acceptance](acceptance.md) as needed. Fake-provider tests do not prove translation quality or remote-provider availability. The pinned upstream development audit warning is explained in [behavior.md](behavior.md#development).
4. Commit, push, and confirm CI is green.

## GitHub release

Tag the validated release commit and push the tag. For this release:

```bash
git tag -a v0.1.1 <release-commit> -m "Release v0.1.1"
git push origin v0.1.1
```

`.github/workflows/release.yml` checks the tagged package version, runs verification, and creates the release from `docs/releases/v0.1.1.md`. It uses GitHub's short-lived token and never overwrites an existing release. Retry through **Actions → GitHub Release → Run workflow**, specifying the existing tag.

If that version is already on npm, its recorded `gitHead` must equal the tag. A registry `404` allows the GitHub release to precede npm publication; other registry errors fail the workflow. Never move a published tag.

## npm publication — maintainer action

Publish from the tag, not a later README or development commit. Use a clean worktree if `main` has moved:

```bash
git worktree add --detach ../pi-translate-v0.1.1 v0.1.1
cd ../pi-translate-v0.1.1
npm ci --ignore-scripts
npm login --registry=https://registry.npmjs.org
npm whoami --registry=https://registry.npmjs.org
npm publish
```

`prepublishOnly` reruns `verify`. `publishConfig` fixes the official registry and public access. Complete any 2FA prompt interactively; never commit a token or paste it into an agent transcript.

After publication:

```bash
npm view @linys77/pi-translate@0.1.1 version gitHead dist.integrity
pi update npm:@linys77/pi-translate
```

Confirm `gitHead` equals `git rev-parse v0.1.1^{commit}` and test in Pi. Do not load npm and Git/local installations together. Version numbers on npm are immutable; corrections require a new version. Updating the README on GitHub does not update the README inside an already-published npm package.
