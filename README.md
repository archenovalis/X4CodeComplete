## archie's updates

### 1.1

added documentation tooltips and bug fixes (whitespace changes too)

(1.1.1) typescript types and bug fixes

(1.1.2) added sorting and grouping

(1.1.3) bug fixes

### 1.2

t-file text

(1.2.1) added preferred language display option and bug fix

# x4codecomplete README

To install, go to releases & download the .vsix file. Then install it like any other program.
I highly recommend using this in conjunction with [these instructions](https://forum.egosoft.com/viewtopic.php?f=181&t=416621) by ledhead900, but it's not technically a requirement.

## Features

XML code complete for Visual Studio Code. Currently completes entries from scriptproperties.xml.

## Requirements

None yet

## Extension Settings

Exceedingly Verbose: enables debug logging. Defaults to false

Script Properties Location: Absolute path to scriptproperties.xml, including scriptproperties.xml in the path. REQUIRED, no default.

## Known Issues

None yet

## Release Notes

### 1.0.0

Initial release. Supports scriptproperties.xml autocomplete

### 1.0.1

Major improvements; now has configuration & generates the entries at startup from scriptproperties.xml, removing the need for rerunning a python script when scriptproperties.xml updates.

### 1.0.2

Hopefully, no more duplicate suggestions. Also, Peek/Go to definition for script properties!
