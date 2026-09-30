# @city-of-helsinki/license-notices

A Vite plugin that writes the license notices of every third-party package
bundled into a production build, and serves them from the root of the
deployed application.

## Why

Serving an application to a browser distributes its JavaScript bundle, and
with it every open source package the bundle contains. Almost every open
source license attaches conditions to that distribution:

- **MIT, ISC, BSD and Apache-2.0** require the copyright notice and the
  license text to travel with the code.
- **MPL-2.0** (section 3.2) also requires telling recipients where the source
  of the MPL-covered files can be obtained.
- **GPL-2.0** requires a copy of the license (section 1) and access to the
  complete corresponding source (section 3).

A minified bundle carries none of this: minification strips the license
comments, and the license files stay behind in `node_modules`. This plugin
collects them at build time from exactly the packages that ended up in the
bundle, and writes them next to it:

- `third-party-licenses.txt`, the notices for people to read, and
- `oss-licenses.json`, the same data for license audit tooling.

Both are generated on every build, so they always describe the build they ship
with. Neither is committed to the repository.

The plugin prefers failing the build to shipping something nobody has
checked: a license it cannot identify, a license decision that no longer
matches the package, or a copyleft license it has no notice rules for all stop
the build with a message that says what to check. See
[When the build fails](#when-the-build-fails).

## Setup

1. Add the package:

   ```sh
   pnpm add --save-dev @city-of-helsinki/license-notices
   ```

2. Put everything specific to the repository in a config file of its own, for
   example `scripts/thirdPartyLicenses.config.ts`:

   ```ts
   import type { ThirdPartyLicensesConfig } from '@city-of-helsinki/license-notices';

   export const thirdPartyLicensesConfig: ThirdPartyLicensesConfig = {
     repositoryUrl: 'https://github.com/City-of-Helsinki/<repository>',
   };
   ```

3. Add the plugin to `vite.config.ts`:

   ```ts
   import { thirdPartyLicenses } from '@city-of-helsinki/license-notices';

   import { thirdPartyLicensesConfig } from './scripts/thirdPartyLicenses.config';

   export default defineConfig({
     plugins: [
       // ...
       thirdPartyLicenses(thirdPartyLicensesConfig),
     ],
   });
   ```

   The plugin only runs in `vite build`.

4. Make sure the application's own `LICENSE` file is present when the build
   runs, because the notices start with the application's own license. In a
   Docker build, copy it into the build stage:

   ```dockerfile
   COPY --chown=default:root index.html LICENSE vite.config.ts ./
   ```

   and do not exclude it in `.dockerignore`. If `.dockerignore` lists the files
   to include instead, add `!LICENSE`.

5. Run `pnpm build` and read the output. The first build of an existing
   application usually needs a license decision or two; the build tells which.

6. Consider a test for the license decisions in the config, since a reader
   cannot verify them from the bundle:

   ```ts
   it('elects Apache-2.0 for the dual-licensed dompurify', () => {
     expect(thirdPartyLicensesConfig.licenseDecisions?.dompurify?.license).toBe(
       'Apache-2.0'
     );
   });
   ```

## What the notices contain

- The license of the application itself, read from the `LICENSE`, `LICENCE`
  or `COPYING` file at the Vite root, and a link to its source.
- One entry per bundled package and version, sorted by name: its license, the
  license it declares when a decision replaced it, the reason for the
  decision, and the package's own license file.
- For a package that ships no license file, a notice rebuilt from the canonical
  text of the license it declares and the author it names, marked as rebuilt.
- For MPL-2.0 components, the section 3.2 notice of where their source is.
- For GPL-2.0 components, the section 3 notice of where their source and the
  source of the rest of the application are, and the full text of the GPL once
  at the end.

The output has no timestamps and a stable order, so an unchanged dependency
set produces a byte-identical file.

## Configuration

| Option                 | Description                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `repositoryUrl`        | Required. Browsable URL of the application's source, named as its source in the notices.                                                                     |
| `licenseDecisions`     | Licenses to replace, see [License decisions](#license-decisions).                                                                                            |
| `sassResolvedPackages` | Packages whose styles Sass inlines while compiling the stylesheets. The bundler never sees them, so they have to be listed, for example `hds-design-tokens`. |
| `noticesFileName`      | Name of the notices file. Defaults to `third-party-licenses.txt`.                                                                                            |
| `manifestFileName`     | Name of the JSON manifest. Defaults to `oss-licenses.json`; `false` leaves it out.                                                                           |

### License decisions

A license decision replaces the license a package declares. There are two
reasons to make one:

- **To elect one license of a dual-licensed package.** DOMPurify is offered
  under `(MPL-2.0 OR Apache-2.0)`. Electing Apache-2.0 means the MPL-2.0
  obligations do not apply:

  ```ts
  licenseDecisions: {
    dompurify: {
      license: 'Apache-2.0',
      note:
        'Offered by its author under "(MPL-2.0 OR Apache-2.0)". This ' +
        'distribution elects Apache-2.0, so the MPL-2.0 obligations do not ' +
        'apply to this component.',
    },
  },
  ```

- **To name the license of a package that declares no valid SPDX
  identifier**, such as `"BSD"` or `"SEE LICENSE IN LICENSE.md"`, after reading
  its license file.

The note says why, and it is printed in the notices, because a reader cannot
verify either kind of decision from the bundle.

A decision is keyed by a package name, or by a whole scope such as
`@ckeditor/*`. An exact name takes precedence over the scope's pattern.

`declared` guards a decision: the decision applies only while the package
declares exactly that license, and any other declared license fails the build.
A scope pattern must have it, because it also matches packages added to the
scope later:

```ts
'@ckeditor/*': {
  declared: 'SEE LICENSE IN LICENSE.md',
  license: 'GPL-2.0-or-later',
  note: 'Offered by CKSource under GPL-2.0-or-later or commercial terms.',
},
```

## When the build fails

| Message                                                              | What to do                                                                                                                                                       |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `License "…" for <package> is not a valid SPDX expression!`          | Read the package's license file and add a license decision naming its SPDX identifier.                                                                           |
| `<package> declares "…", but the license decision "…" applies only…` | The package's license changed, or a new package matched a scope pattern. Read its license, then update or add the decision.                                      |
| `<package> is distributed under "…", and there are no notice rules…` | A GPL-3.0, LGPL, AGPL or EUPL license, which needs more than a notice. Elect another license with a decision if one is offered, or add notice rules for it here. |
| `Distributed package "…" was not found in node_modules…`             | A package listed in `sassResolvedPackages` is not installed.                                                                                                     |

## Supported licenses

- **Notices from the package's own license file:** any license with a valid
  SPDX identifier.
- **Rebuilt notices** for packages that ship no license file: MIT, ISC and
  Apache-2.0.
- **Extra notice rules:** MPL-2.0 and GPL-2.0 (`GPL-2.0-only`,
  `GPL-2.0-or-later`).
- **Fail the build:** GPL-3.0, LGPL, AGPL and EUPL, in any form, until notice
  rules exist for them.

Licenses the plugin does not recognise as copyleft, such as EPL or CDDL, and
licenses that are not open source at all, such as the Hippocratic License,
pass through as stated. Reading the generated notices when dependencies change
is still worthwhile.

## Limitations

- **Vite 7 and 8 only.** Next.js, webpack and Turbopack builds are not
  supported.
- **npm packages in the bundle only.** Images, fonts and scripts loaded from a
  CDN are not covered, and belong in the application's own documentation.
- Packages with a license decision are looked up at the top of `node_modules`
  and in the pnpm virtual store.
- This plugin produces notices. It does not replace a review of whether a
  license suits the application.

## Development

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

To try an unreleased version in an application, pack it and install the
tarball there:

```sh
pnpm pack:local
# in the application:
pnpm add --save-dev ../license-notices/license-notices-local-<timestamp>.tgz
```

Every `pack:local` writes a tarball with a new name, so that pnpm does not
reuse the files it extracted from an earlier one. The tarballs are ignored by
git.

## Releasing

Releases are made with [release-please](https://github.com/googleapis/release-please)
from the conventional commit messages. Merging the release pull request tags
the release, and the release workflow publishes it to npm with
[trusted publishing](https://docs.npmjs.com/trusted-publishers), so that no npm
token is stored in the repository.

## License texts

The canonical texts in `licenseTexts/` are used for rebuilt notices and for
the GPL appendix:

| File             | Source                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `MIT.txt`        | [SPDX License List](https://github.com/spdx/license-list-data), with the copyright line as a `{{copyright}}` placeholder |
| `ISC.txt`        | [SPDX License List](https://github.com/spdx/license-list-data), with the copyright line as a `{{copyright}}` placeholder |
| `Apache-2.0.txt` | <https://www.apache.org/licenses/LICENSE-2.0.txt>, verbatim                                                              |
| `GPL-2.0.txt`    | <https://www.gnu.org/licenses/old-licenses/gpl-2.0.txt>, verbatim                                                        |

## License

MIT, see [LICENSE](./LICENSE).
