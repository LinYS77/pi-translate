# Release checklist

Package: **`@linys77/pi-translate`**, initial version **0.1.0**.

The unscoped `pi-translate` name belongs to another author. Keep the scoped name; never direct users to that unrelated package. The scope matches the maintainer of `pi-glance`, but publishing still requires a valid npm login and permission for `@linys77`.

## Validate

From a clean checkout, using Node.js 22.19+ and npm:

```bash
npm ci --ignore-scripts
npm run verify
npm audit --omit=dev
npm publish --dry-run
```

`verify` checks formatting, strict types, behavioral tests and the **actual packed artifact** through Pi's extension loader. The artifact must contain only runtime TypeScript, the two READMEs, license, package manifest and user-facing behavior docs. It must have no tests, CI, release scripts, lockfile, credentials or generated archives. No build step is needed: Pi loads the published TypeScript directly.

The package check uses `tar` and leaves no archive in the repository. `prepublishOnly` runs `verify` again for both a normal publish and `npm publish --dry-run`.

Review [manual acceptance](acceptance.md) with a real provider and terminal before release. Unit-test text is not evidence of real translation quality. Do not dismiss development audit warnings as runtime-host safety guarantees; the pinned Pi dependency warning is explained in [behavior.md](behavior.md#development).

## Publish — maintainer action

No CI job publishes automatically. Do not commit an npm token or authenticate through an agent transcript.

1. Confirm `main` is committed, pushed and CI is green.
2. Log in interactively and confirm the account has access to the scope:

   ```bash
   npm login --registry=https://registry.npmjs.org
   npm whoami --registry=https://registry.npmjs.org
   ```

3. Publish from the repository root, completing any requested 2FA approval:

   ```bash
   npm publish
   ```

   `publishConfig` fixes the official registry and public access. This command performs the real, externally visible release; the dry run does not.

4. Verify the registry metadata and one clean installation:

   ```bash
   npm view @linys77/pi-translate@0.1.0 version dist.integrity
   pi -e npm:@linys77/pi-translate@0.1.0
   ```

   Use a separate test agent directory, or remove another installation of this extension first. Check `/translate`, model selection, Alt+T and a complete translation round. Do not load the npm and Git/local versions together.

5. Only after the publish succeeds, tag that exact commit and push the tag:

   ```bash
   git tag -a v0.1.0 -m "Release v0.1.0"
   git push origin v0.1.0
   ```

6. Remove the “first release pending” note from both READMEs and make npm the primary installation example. A GitHub release is optional; it should point to the published commit, not a later documentation change.

## Subsequent versions

Update `package.json` and the lockfile together, rerun validation, and publish a new version. npm versions are immutable; never reuse an existing version. Keep the tag on the commit whose artifact was published.
