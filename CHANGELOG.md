# Changelog

## [0.2.0](https://github.com/City-of-Helsinki/license-notices/compare/license-notices-v0.1.0...license-notices-v0.2.0) (2026-10-26)


### Features

* Add projectLicenseFile and look up sass packages upward ([167fa32](https://github.com/City-of-Helsinki/license-notices/commit/167fa3200a1a9056e452f2a1d63cee3cbbee271a))
* Leave first-party packages out of the notices ([8143f77](https://github.com/City-of-Helsinki/license-notices/commit/8143f772ba1f14dd47066b6a8c2cad954e1f3e75))
* Read the bundled packages from rspack stats ([9e3e525](https://github.com/City-of-Helsinki/license-notices/commit/9e3e5256e2ceebc4cf23bd02aea99b70201676a5))
* Rebuild notices for OFL-1.1 and AND license expressions ([d0d66ab](https://github.com/City-of-Helsinki/license-notices/commit/d0d66ab68f608a7464e9c3553fd654d8b5c569ab))
* Support next.js builds ([2cc92c3](https://github.com/City-of-Helsinki/license-notices/commit/2cc92c3aa6d602102f8bb00721ebcc1e0d657d3f))
* Support rsbuild builds ([54e4f04](https://github.com/City-of-Helsinki/license-notices/commit/54e4f04574d2ace504bb8edab22a38a036365cb0))
* Support webpack builds ([b589cfe](https://github.com/City-of-Helsinki/license-notices/commit/b589cfe5271b20c3085a150844a32b9b165f4278))


### Bug Fixes

* Address copilot review findings ([30ba5c1](https://github.com/City-of-Helsinki/license-notices/commit/30ba5c108a73a3c3ece2eb54f3e41f67c17656c7))
* Find installed packages above the project for Vite ([d46d5f6](https://github.com/City-of-Helsinki/license-notices/commit/d46d5f671c09ebbb47c576dc7e5dc852e9967360))
* Include cached modules in webpack stats ([002f8d1](https://github.com/City-of-Helsinki/license-notices/commit/002f8d16369137d90a76ba526b7a30c494f44a1b))
* Match only standalone OR in declared licenses ([d971fc7](https://github.com/City-of-Helsinki/license-notices/commit/d971fc7f5c825fc41225648ae41b6a9ac1708659))
* Resolve linked packages outside node_modules ([567c554](https://github.com/City-of-Helsinki/license-notices/commit/567c554bbc4d182821d0402a1e6862fbe124d24c))
* Skip webpack stats modules without a file ([951debf](https://github.com/City-of-Helsinki/license-notices/commit/951debf090fdb23556c31d7087164fe60d04142f))
* Tell a missing package.json from a missing license field ([b8116b9](https://github.com/City-of-Helsinki/license-notices/commit/b8116b9d23e2397e53285b3358208d38e6b196dc))
* Use the text of the license a decision elects ([4577ad5](https://github.com/City-of-Helsinki/license-notices/commit/4577ad5a696c7cb35cadd3e193490e2d97407bc7))
* Validate the first-party packages of an rsbuild build ([81bcfc7](https://github.com/City-of-Helsinki/license-notices/commit/81bcfc7265d15cf61d9698a01784ed0e018e26e7))
* Validate the license decisions of an rsbuild build ([a60de41](https://github.com/City-of-Helsinki/license-notices/commit/a60de418af5ebb9ad17637cb8340983ba2d1f705))
* Write the notices of every browser environment ([0a46bf4](https://github.com/City-of-Helsinki/license-notices/commit/0a46bf40c321d80fc22f4f24c27f5742a495fe21))


### Documentation

* Describe the rsbuild setup ([3c35034](https://github.com/City-of-Helsinki/license-notices/commit/3c3503403b05ee423bed3be09af8ce93d812bac6))
* Describe the webpack setup ([2c89975](https://github.com/City-of-Helsinki/license-notices/commit/2c89975508c9948e815bafb1b7ec7b45ab127ba9))

## 0.1.0 (2026-10-07)


### Features

* Add vite plugin for third-party license notices ([5b958b6](https://github.com/City-of-Helsinki/license-notices/commit/5b958b61dff49b201e3355928130b6ed0a8eec88))
* Add vite plugin for third-party license notices ([bd225d1](https://github.com/City-of-Helsinki/license-notices/commit/bd225d144bbc868f96d20279c9aa03cc693f2c19))


### Documentation

* Add readme ([0f852e0](https://github.com/City-of-Helsinki/license-notices/commit/0f852e022c1d79012b065f60099fc2ce2b47dca6))
