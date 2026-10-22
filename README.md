# @city-of-helsinki/license-notices

Writes the license notices of every third-party package bundled into the
production build of a Vite, Rsbuild or Next.js application, and serves them
from the root of the deployed application.

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
comments, and the license files stay behind in `node_modules`. This package
collects them at build time from exactly the packages that ended up in the
bundle, and writes them next to it:

- `third-party-licenses.txt`, the notices for people to read, and
- `oss-licenses.json`, the same data for license audit tooling.

Both are generated on every build, so they always describe the build they ship
with. Neither is committed to the repository.

It prefers failing the build to shipping something nobody has
checked: a license it cannot identify, a license decision that no longer
matches the package, or a copyleft license it has no notice rules for all stop
the build with a message that says what to check. See
[When the build fails](#when-the-build-fails).

## Setup

1. Add the package:

   ```sh
   pnpm add --save-dev @city-of-helsinki/license-notices
   ```

2. Put everything specific to the repository in a config file of its own. For
   Vite, for example `scripts/thirdPartyLicenses.config.ts`:

   ```ts
   import type { ThirdPartyLicensesConfig } from '@city-of-helsinki/license-notices';

   export const thirdPartyLicensesConfig: ThirdPartyLicensesConfig = {
     repositoryUrl: 'https://github.com/City-of-Helsinki/<repository>',
   };
   ```

   For Rsbuild, the same file, with the type imported from
   `@city-of-helsinki/license-notices/rsbuild`.

   A CommonJS `next.config.js` cannot load a TypeScript file, so for Next, for
   example `scripts/thirdPartyLicenses.config.js`, typed with JSDoc:

   ```js
   /** @type {import('@city-of-helsinki/license-notices/next').ThirdPartyLicensesConfig} */
   const thirdPartyLicensesConfig = {
     repositoryUrl: 'https://github.com/City-of-Helsinki/<repository>',
   };

   module.exports = { thirdPartyLicensesConfig };
   ```

3. Add it to the build, see [Vite](#vite) or [Next.js](#nextjs) below.

4. Make sure the application's own `LICENSE` file is present when the build
   runs, because the notices start with the application's own license. In a
   Docker build, do not exclude it in `.dockerignore`, and if `.dockerignore`
   lists the files to include instead, add `!LICENSE`. A Dockerfile that
   copies the files it needs one by one has to name it as well:

   ```dockerfile
   COPY --chown=default:root index.html LICENSE vite.config.ts ./
   ```

   One that copies the whole build context, with `COPY . .`, needs nothing
   more.

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

### Vite

Add the plugin to `vite.config.ts`:

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

The plugin only runs in `vite build`, and emits both files into the build
output.

### Next.js

Wrap the Next config with `withThirdPartyLicenses`, from the
`@city-of-helsinki/license-notices/next` entry point, and enable production
source maps, which the notices are read from:

```js
const {
  withThirdPartyLicenses,
} = require('@city-of-helsinki/license-notices/next');

const {
  thirdPartyLicensesConfig,
} = require('./scripts/thirdPartyLicenses.config');

module.exports = {
  // ...
  productionBrowserSourceMaps: true,
};

module.exports = withThirdPartyLicenses(
  module.exports,
  thirdPartyLicensesConfig
);
module.exports = withSentryConfig(module.exports, {
  // ...
});
```

- The notices are written during `next build`, after the client is compiled,
  into the `public` directory. `next start` serves them from there, and so
  does the server of an `output: 'standalone'` build, once `public` is copied
  next to it as Next's deployment instructions say. Add both files to
  `.gitignore`:

  ```gitignore
  /public/third-party-licenses.txt
  /public/oss-licenses.json
  ```

  Each build replaces the files it writes, but leaves a file it no longer
  writes in place, after `manifestFileName` is set to `false` or a file name
  is changed. Remove such a file by hand.

- Apply `withThirdPartyLicenses` before other wrappers, such as
  `withSentryConfig`, as above. Those may remove the source maps after
  uploading them, and run any hook configured before them first. A line of
  its own before an existing wrapper leaves that wrapper's options as they
  are.
- The notices of an earlier build are removed from `public` before new ones
  are written, so a build that fails on a license leaves none behind for
  `next start` to serve. A build that fails to compile stops before that, and
  leaves `public` as it was. `next dev` neither writes nor removes them.
- The entry point is an ES module, which a CommonJS `next.config.js` can
  `require` on Node 22.12 and later.
- `next start` loads the Next config too, so where the production image
  installs only `dependencies`, add the package there rather than to
  `devDependencies`.
- Vite does not have to be installed in a Next app. Import the
  `ThirdPartyLicensesConfig` type from
  `@city-of-helsinki/license-notices/next` there, since the types of the main
  entry point refer to Vite.

### Rsbuild

Add the plugin, from the `@city-of-helsinki/license-notices/rsbuild` entry
point, to `rsbuild.config.ts`:

```ts
import { pluginThirdPartyLicenses } from '@city-of-helsinki/license-notices/rsbuild';

import { thirdPartyLicensesConfig } from './scripts/thirdPartyLicenses.config';

export default defineConfig({
  plugins: [
    // ...
    pluginThirdPartyLicenses(thirdPartyLicensesConfig),
  ],
});
```

- The plugin only runs in `rsbuild build`, and writes both files into the
  root of the build output, `output.distPath.root`, of each environment that
  builds for a browser (`web` or `web-worker`). Environments that share a
  root share one set of files.
  Rsbuild empties that directory before each build, so nothing needs to be
  added to `.gitignore`.
- Source maps are not needed, and production builds of Rsbuild write none by
  default.
- Vite does not have to be installed in an Rsbuild app. Import the
  `ThirdPartyLicensesConfig` type from
  `@city-of-helsinki/license-notices/rsbuild` there.

## What the notices contain

- The license of the application itself, read from the `LICENSE`, `LICENCE`
  or `COPYING` file at the Vite root or in the Next project directory, and a
  link to its source.
- One entry per bundled package and version, sorted by name: its license, the
  license it declares when a decision replaced it, the reason for the
  decision, and the package's own license file.
- For a package that ships no license file, a notice rebuilt from the canonical
  text of the license it declares and the author it names, marked as rebuilt.
  A package declaring licenses joined with `AND`, such as `(OFL-1.1 AND MIT)`,
  gets the text of each one, labelled with its identifier. Licenses offered as
  a choice with `OR` are not rebuilt until a license decision elects one.
- For MPL-2.0 components, the section 3.2 notice of where their source is.
- For GPL-2.0 components, the section 3 notice of where their source and the
  source of the rest of the application are, and the full text of the GPL once
  at the end.

The output has no timestamps and a stable order, so an unchanged dependency
set produces a byte-identical file.

## How the bundled packages are found

- **Vite:** [rollup-license-plugin](https://github.com/codepunkt/rollup-license-plugin)
  reports every package with rendered output in the bundle, so a package that
  tree shaking removes entirely is left out.
- **Next.js,** with Turbopack or webpack, and with the Pages or the App
  Router: the source maps of the chunks in `.next/static`, which is everything
  sent to a browser. A source counts only when the source map maps output to
  it, so tree shaking is followed in the same way. Turbopack has no plugin API
  that reports the modules of a chunk, and its chunks name modules by number
  only, so the source maps are the one record of what a chunk contains.

  Turbopack follows the source maps that packages ship, so a source can name
  a file a package was built from, such as `@apollo/src/...`, instead of the
  installed one. Such a file is given to the package that shipped it: the
  package it is inside of, or in the pnpm virtual store, the package in the
  same store directory. When neither tells, the build fails, see below.

- **Rsbuild:** the modules in the chunks of each browser environment, as the
  compilation stats of Rspack list them, including the modules concatenated
  into another one. A module that tree shaking removes is in no chunk, and is
  left out. A module whose used exports Rspack inlined where they are used,
  such as a constant, counts as bundled although it is in no chunk.

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

  A package that declares a choice often ships the text of each license in a
  file of its own, next to a `LICENSE` that names only the choice. ibantools
  ships `LICENSE` with just `MIT OR MPL-2.0`, `LICENSE.MIT` and
  `LICENSE.MPL-2.0`. So when a decision elects one license of a declared
  choice, the notice uses the first of these that exists:
  1. the file the decision names as `licenseFile`, which must exist:

     ```ts
     dompurify: {
       license: 'MPL-2.0',
       licenseFile: 'LICENSE-MPL',
       note: '…',
     },
     ```

  2. a file named for the elected license: `LICENSE` or `LICENCE`, `.` or
     `-`, the SPDX identifier, and optionally `.txt` or `.md`, in any case,
     such as `LICENSE.MIT` or `licence-Apache-2.0.txt`,
  3. a license file whose text is that of the elected license, for MIT, ISC,
     Apache-2.0, MPL-2.0, BSD-2-Clause, BSD-3-Clause and OFL-1.1,
  4. a notice rebuilt from the canonical text of the elected license and the
     author in `package.json`, for the licenses listed under
     [Supported licenses](#supported-licenses), marked as rebuilt in the
     notices.

  If none applies, the build fails and lists the license files the package
  ships, so that the right one can be named as `licenseFile`.

- **To name the license of a package that declares no valid SPDX
  identifier**, such as `"BSD"` or `"SEE LICENSE IN LICENSE.md"`, after reading
  its license file. Its license file is used as it is.

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

| Message                                                              | What to do                                                                                                                                                         |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `License "…" for <package> is not a valid SPDX expression!`          | Read the package's license file and add a license decision naming its SPDX identifier.                                                                             |
| `<package> declares "…", but the license decision "…" applies only…` | The package's license changed, or a new package matched a scope pattern. Read its license, then update or add the decision.                                        |
| `<package> is distributed under "…", and there are no notice rules…` | A GPL-3.0, LGPL, AGPL or EUPL license, which needs more than a notice. Elect another license with a decision if one is offered, or add notice rules for it here.   |
| `Distributed package "…" was not found in node_modules…`             | A package listed in `sassResolvedPackages` is not installed.                                                                                                       |
| `…the Next config must enable productionBrowserSourceMaps.`          | Enable `productionBrowserSourceMaps` in the Next config. The source maps are then served along with the chunks.                                                    |
| `No chunk in … names a source map…`                                  | Something removes the source maps before the notices are written. Put `withThirdPartyLicenses` inside the wrapper that does.                                       |
| `The modules of the build name files in node_modules…`               | An Rsbuild module in `node_modules` belongs to no installed package. Check that the package has a `package.json` naming it and its version.                        |
| `The source maps of the client build name files in node_modules…`    | A package ships source maps naming files outside of it, outside the pnpm virtual store. Set `experimental.turbopackInputSourceMaps` to `false` in the Next config. |

## Supported licenses

- **Notices from the package's own license file:** any license with a valid
  SPDX identifier.
- **Rebuilt notices** for packages that ship no license file: MIT, ISC,
  Apache-2.0 and OFL-1.1, and `AND` combinations of them.
- **Extra notice rules:** MPL-2.0 and GPL-2.0 (`GPL-2.0-only`,
  `GPL-2.0-or-later`).
- **Fail the build:** GPL-3.0, LGPL, AGPL and EUPL, in any form, until notice
  rules exist for them.

Licenses the plugin does not recognise as copyleft, such as EPL or CDDL, and
licenses that are not open source at all, such as the Hippocratic License,
pass through as stated. Reading the generated notices when dependencies change
is still worthwhile.

## Limitations

- **Vite 7 and 8, Next.js 16** with Turbopack or webpack, **and Rsbuild 2.**
  Other bundlers and frameworks are not supported.
- **npm packages in the bundle only.** Images, fonts and scripts loaded from a
  CDN are not covered, and belong in the application's own documentation.
- **Client code only.** Code that runs only on the server, such as the server
  bundles of a Next app and the `node_modules` of its standalone build, is not
  sent to browsers, and its notices are not part of this file. This holds
  while the server image is deployed and not handed to anyone else.
- **Bundled packages appear as the package that bundles them.** A package
  that bundles another one into its own files, such as Next with the copy of
  React the App Router runs, is listed with its own license file only.
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
| `OFL-1.1.txt`    | <https://openfontlicense.org/documents/OFL.txt>, verbatim from the title to the end, without the template header         |
| `GPL-2.0.txt`    | <https://www.gnu.org/licenses/old-licenses/gpl-2.0.txt>, verbatim                                                        |

The official OFL-1.1 text starts with a header for font authors to fill in,
with their copyright and Reserved Font Names, before the license itself. It is
left out, and a rebuilt OFL-1.1 notice states the author above the license
instead, as for Apache-2.0. A Reserved Font Name is never stated: a
package.json cannot name one, and the notices never invent it.

## License

MIT, see [LICENSE](./LICENSE).
