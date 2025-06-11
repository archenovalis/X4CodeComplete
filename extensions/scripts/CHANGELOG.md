# Change Log

All notable changes to the "x4codecomplete" extension will be documented in this file.

## [1.5.3](https://github.com/archenovalis/X4CodeComplete/compare/X4CodeComplete@v1.5.2...X4CodeComplete@v1.5.3) (2025-06-11)


### Code Refactoring

* **scripts:** add icon and update description and publisher in package.json ([5f8940b](https://github.com/archenovalis/X4CodeComplete/commit/5f8940bb66bfffc9a3e89ad34c6b0810ab6babb5))

## [1.5.2](https://github.com/archenovalis/X4CodeComplete/compare/X4CodeComplete@v1.5.1...X4CodeComplete@v1.5.2) (2025-06-06)


### Bug Fixes

* **reference:** recover reference and rename providers ([0201cdb](https://github.com/archenovalis/X4CodeComplete/commit/0201cdb32e75f6cb243ff332b3ee61088e513faa))


### Documentation

* **README:** update version history for 1.5.1 and 1.5.0 to reflect accurate feature descriptions ([209d5ac](https://github.com/archenovalis/X4CodeComplete/commit/209d5ac2931f41ae05c41db84e9d8414c817e8a9))
* **scripts:** add missing version entry for 1.4.1 bug fixes ([d7d85bf](https://github.com/archenovalis/X4CodeComplete/commit/d7d85bf0b2671eb3c4fd6b391d6bf3ce94407a3f))
* **scripts:** add video demonstration links for features up to 1.4.1 and 1.5.1 ([31f01dc](https://github.com/archenovalis/X4CodeComplete/commit/31f01dc931d3f8efc54cd2d8ea70cf395275ee08))
* **scripts:** update README to version 1.5.2 ([bd23d1a](https://github.com/archenovalis/X4CodeComplete/commit/bd23d1ae2091b3e5d6cd3c9eca32bd2709e8988b))
* **script:** update version history and enhance feature descriptions for clarity ([e5a9cb3](https://github.com/archenovalis/X4CodeComplete/commit/e5a9cb33231310393051c51f4e3ede70d9c6c0f5))

## [1.5.1](https://github.com/archenovalis/X4CodeComplete/compare/X4CodeComplete@v1.5.0...X4CodeComplete@v1.5.1) (2025-06-01)


### Code Refactoring

* **script:** enhance label and action completion with partial text filtering ([4a5b8b7](https://github.com/archenovalis/X4CodeComplete/commit/4a5b8b74751252da1bee97145f62b51e9bf59cf3))
* **script:** enhance label and action filtering with regex fallback for partial text ([f79972a](https://github.com/archenovalis/X4CodeComplete/commit/f79972aef4de8e996b13cc696dcc5ba48657f180))
* **script:** implement specialized completion for variables, labels, and actions ([7ebdec7](https://github.com/archenovalis/X4CodeComplete/commit/7ebdec74042469fe1febde3cd1547c0a0542d115))

## [1.5.0](https://github.com/archenovalis/X4CodeComplete/compare/X4CodeComplete@v1.4.1...X4CodeComplete@v1.5.0) (2025-06-01)


### Features

* **scripts:** add diagnostics for undefined label and action references ([43b1082](https://github.com/archenovalis/X4CodeComplete/commit/43b10824433d74c107e94d468c7a124275ed3250))


### Code Refactoring

* remove action creation for label diagnostics ([f2f1b1f](https://github.com/archenovalis/X4CodeComplete/commit/f2f1b1f8c5d36810fb552ec1c00e620cdd06ee51))

## [1.4.1](https://github.com/archenovalis/X4CodeComplete/compare/X4CodeComplete@v1.4.0...X4CodeComplete@v1.4.1) (2025-05-14)


### Bug Fixes

* **scripts:** skipped references before definition in LabelTracker and ActionTracker ([3b872f1](https://github.com/archenovalis/X4CodeComplete/commit/3b872f13f89d2cd19508e7a07542c74983f627fa))

## [1.4.0](https://github.com/archenovalis/X4CodeComplete/compare/X4CodeComplete@v1.3.3...X4CodeComplete@v1.4.0) (2025-05-14)


### Features

* **scripts:** implement ActionTracker for AIScript library actions and its references ([e481e57](https://github.com/archenovalis/X4CodeComplete/commit/e481e5793aba67f7ac2fcf1f1648b4664dba3cc4))
* **scripts:** implement label tracking and completion for aiscript ([77f3712](https://github.com/archenovalis/X4CodeComplete/commit/77f371285987d85df34f308b7f5023602214c9ef))


### Bug Fixes

* **scripts:** include '(' in variable start index check as valid precedence symbol ([e788d6d](https://github.com/archenovalis/X4CodeComplete/commit/e788d6d9e69f282133c2c3308290e0e2c81137b3))

## [1.3.3](https://github.com/archenovalis/X4CodeComplete/compare/X4CodeComplete@v1.3.2...X4CodeComplete@v1.3.3) (2025-03-31)


### Bug Fixes

* **scripts:** by some reason completion wasn't work inside an xml attributes values on edit (on creation it was working fine) ([9d26e7e](https://github.com/archenovalis/X4CodeComplete/commit/9d26e7e32f87bc966eb4fc95fd31c440348357a9))
* **scripts:** vscode types dependency was not comply with engine ([8d7075b](https://github.com/archenovalis/X4CodeComplete/commit/8d7075b2ab052d809bdb2013c109cac0cb0a83a2))


### Code Refactoring

* **scripts:** added basic completion provider for variables ([8942f5e](https://github.com/archenovalis/X4CodeComplete/commit/8942f5ecc259e1c6a53a6dc41468b58fe327999a))
* **scripts:** not propose as completion a currently edited variable (exact value) ([9d26e7e](https://github.com/archenovalis/X4CodeComplete/commit/9d26e7e32f87bc966eb4fc95fd31c440348357a9))


### Miscellaneous Chores

* **scripts:** added logging into the appropriate vscode output instead of console logging by using the winston and appropriate transport ([fbdfd2f](https://github.com/archenovalis/X4CodeComplete/commit/fbdfd2fc849dcbae412c086f10c25d1c05e3d111))

## [1.3.3](https://github.com/archenovalis/X4CodeComplete/compare/X4CodeComplete@v1.3.2...X4CodeComplete@v1.3.3) (2025-03-31)


### Bug Fixes

* **scripts:** by some reason completion wasn't work inside an xml attributes values on edit (on creation it was working fine) ([9d26e7e](https://github.com/archenovalis/X4CodeComplete/commit/9d26e7e32f87bc966eb4fc95fd31c440348357a9))


### Code Refactoring

* **scripts:** added basic completion provider for variables ([8942f5e](https://github.com/archenovalis/X4CodeComplete/commit/8942f5ecc259e1c6a53a6dc41468b58fe327999a))
* **scripts:** not propose as completion a currently edited variable (exact value) ([9d26e7e](https://github.com/archenovalis/X4CodeComplete/commit/9d26e7e32f87bc966eb4fc95fd31c440348357a9))


### Miscellaneous Chores

* **scripts:** added logging into the appropriate vscode output instead of console logging by using the winston and appropriate transport ([fbdfd2f](https://github.com/archenovalis/X4CodeComplete/commit/fbdfd2fc849dcbae412c086f10c25d1c05e3d111))

## [1.3.2](https://github.com/archenovalis/X4CodeComplete/compare/X4CodeComplete@v1.3.1...X4CodeComplete@v1.3.2) (2025-03-27)


### Miscellaneous Chores

* **scripts:** implement webpack to make an extensions self-sufficient ([1bf131f](https://github.com/archenovalis/X4CodeComplete/commit/1bf131f6a87f449dc9e76bacd5fbea25aea9e311))
* **scripts:** make it started on startup ([1bf131f](https://github.com/archenovalis/X4CodeComplete/commit/1bf131f6a87f449dc9e76bacd5fbea25aea9e311))

## 1.0

- Initial release
