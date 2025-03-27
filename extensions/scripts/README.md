# X4CodeComplete

## Version History

### 1.3

(1.3.0) Variables support

Go to Definition, Find All References, and Symbol Rename - i.e. F2 on variable name.
Notice: Doesn't support namespaces yet. Scope of variable now the whole file.

### 1.2

t-file text

(1.2.1) added preferred language display option and bug fix

(1.2.2) additional bug fixes and diff add handling

### 1.1

added documentation tooltips and bug fixes (whitespace changes too)

(1.1.1) typescript types and bug fixes

(1.1.2) added sorting and grouping

(1.1.3) bug fixes

## README

To install, go to releases & download the .vsix file. Then install it like any other program.
I highly recommend using this in conjunction with [these instructions](https://forum.egosoft.com/viewtopic.php?f=181&t=416621) by ledhead900, but it's not technically a requirement.

## Features

XML code complete for Visual Studio Code. Currently completes entries from scriptproperties.xml.

Hover documentation for script and xsd properties.

Hovertext for t-file references.

Basic support of variables, i.e. possibility to use next points in context menu on it:
`Go to Definition`, `Find All References`, and `Symbol Rename` - i.e. `F2` on variable name.
Can separately process with "usual" variables and "remote" ones or table fields.
**Notice:** Doesn't support namespaces yet. Scope of variable now the whole file.

## Extension Settings

Paths: extensions folder and vanilla extracted files folder. Default: none

Exceedingly Verbose: enables debug logging. Default: false

## Original Release Notes (thank you Cgetty)

### 1.0.0

Initial release. Supports scriptproperties.xml autocomplete

### 1.0.1

Major improvements; now has configuration & generates the entries at startup from scriptproperties.xml, removing the need for rerunning a python script when scriptproperties.xml updates.

### 1.0.2

Hopefully, no more duplicate suggestions. Also, Peek/Go to definition for script properties!
