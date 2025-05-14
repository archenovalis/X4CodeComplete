# Change Log

All notable changes to the "x4codecomplete" extension will be documented in this file.

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
