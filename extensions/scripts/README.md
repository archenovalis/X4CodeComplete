# X4 Code Complete extension for Visual Studio Code

## Version History

### 1.5

(1.5.3) First release on the Visual Studio Marketplace

- Added a logo and updated README for the Marketplace

(1.5.2) Bug fixes

- Recovered accidentally deleted registration of the `reference` and `rename` providers

(1.5.1) Partial completion for labels and actions

- Intelligent context-aware completion that prevents conflicts between completion types
- Refactored completion system with specialized completion detection

(1.5.0) Error diagnostics for labels and actions

- Real-time error diagnostics for undefined labels and actions
- Automatic creation of missing action definitions
- Quick fix code actions with similarity-based suggestions for undefined references

### 1.4

(1.4.1) Bug fixes

(1.4.0) AI Script Enhanced Support

- Added label completion and tracking for AI Scripts (`<resume>`, `<run_interrupt_script>`, `<abort_called_scripts>`)
- Added action completion and tracking for AI Scripts (`<include_interrupt_actions>`)
- Go to Definition, Find All References, and Symbol Rename for labels and actions
- Hover tooltips showing usage statistics for labels and actions

### 1.3

(1.3.3) Added completion for variables

- Intelligent variable completion with `$` trigger character
- Automatic suggestion display when typing variables in context
- Support for partial variable name matching and filtering

(1.3.2) Bug fixes

- Improved variable detection accuracy
- Fixed completion conflicts between different providers
- Enhanced error handling for malformed XML

(1.3.1) Internal code structure changes

- Refactored completion provider architecture
- Improved document tracking and caching
- Better separation of concerns between different completion types

(1.3.0) Variables support

- Go to Definition, Find All References, and Symbol Rename (F2) for variables
- Variable tracking across entire document with usage statistics
- Support for both regular variables and table key/remote variables
- Hover information showing variable type and usage count
- Notice: Doesn't support namespaces yet. Scope of variable now the whole file.

### 1.2

(1.2.2) Additional bug fixes and diff add handling

- Improved file change detection and processing
- Better handling of document modifications
- Enhanced language file parsing reliability

(1.2.1) Added preferred language display option and bug fix

- Configurable preferred language for t-file display
- Language filtering options for cleaner hover text output
- Fixed language file loading issues

(1.2.0) T-file text integration

- Hover tooltips for language file references
- Support for multiple t-file reference formats: `{pageId,textId}`, `readtext.{pageId}.{textId}`, `page="pageId" line="textId"`
- Multi-language support with automatic language detection
- Integration with both vanilla and extension language files

### 1.1

(1.1.3) Bug fixes

- Improved completion accuracy and performance
- Fixed memory leaks in language file processing
- Better error handling for corrupted files

(1.1.2) Added sorting and grouping

- Alphabetical sorting of completion items
- Grouping of similar properties and methods
- Improved completion item organization and display

(1.1.1) TypeScript types and bug fixes

- Enhanced type safety in internal code
- Fixed completion provider registration issues
- Improved error logging and debugging

(1.1.0) Added documentation tooltips and bug fixes

- Hover documentation for script properties and XSD elements
- Enhanced keyword and datatype information display
- Improved scriptproperties.xml parsing and processing
- Whitespace handling improvements

## README

- You can simple take this extension from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=X4CodeComplete.x4codecomplete)

- Or download the .vsix file from the [GitHub releases page](https://github.com/archenovalis/X4CodeComplete/releases) and then install it like any other program. (Or from "Extensions" in Visual Studio Code)

It's highly recommended to use this in conjunction with [these instructions](https://forum.egosoft.com/viewtopic.php?f=181&t=416621) by ledhead900, but it's not technically a requirement.

## Features

### Core Script Support

- **XML code completion** for Visual Studio Code supporting both AI Scripts and Mission Director Scripts
- **Autocompletion** from scriptproperties.xml with intelligent context-aware suggestions
- **Hover documentation** for script properties and XSD elements
- **Go to Definition** and **Peek Definition** support for script properties

### Language File Integration

- **T-file text display** with hover tooltips for language references
- Support for multiple formats: `{pageId,textId}`, `readtext.{pageId}.{textId}`, and `page="pageId" line="textId"`
- **Multi-language support** with configurable preferred language
- **Language filtering** options for cleaner output

### Variable Support

- **Intelligent variable completion** with `$` trigger for both AI Scripts and Mission Director Scripts
- **Variable tracking** across the entire document with usage statistics
- **Go to Definition**, **Find All References**, and **Symbol Rename** (F2) for variables
- **Hover information** showing variable usage count and type
- Support for both regular variables and table key/remote variables
- **Automatic variable detection** in XML attributes and parameter definitions

### AI Script Specific Features

- **Label completion** for AI Script elements (`<resume>`, `<run_interrupt_script>`, `<abort_called_scripts>`)
- **Action completion** for AI Script action references (`<include_interrupt_actions>`)
- **Label and Action tracking** with Go to Definition and Find All References
- **Hover tooltips** for labels and actions showing usage statistics
- **Error diagnostics** for undefined labels and actions with quick fix suggestions
- **Code actions** to create missing labels/actions or replace with similar existing ones

### Intelligent Context Detection

- **Context-aware completion** that automatically detects when you're typing variables, labels, or actions
- **Smart completion triggering** that prevents conflicts between different completion types
- **Automatic suggestion display** when typing in specialized contexts

### Error Detection and Quick Fixes

- **Real-time validation** of label and action references in AI Scripts
- **Quick fix suggestions** for undefined references with similarity-based recommendations
- **Code actions** to automatically create missing definitions
- **Diagnostic highlighting** of undefined references

## Extension Settings

| Setting                               | Description                                          | Default         |
| ------------------------------------- | ---------------------------------------------------- | --------------- |
| `x4CodeComplete.unpackedFileLocation` | Path to vanilla extracted files folder               | none (required) |
| `x4CodeComplete.extensionsFolder`     | Path to extensions folder                            | none (required) |
| `x4CodeComplete.exceedinglyVerbose`   | Enable debug logging                                 | false           |
| `x4CodeComplete.languageNumber`       | Preferred language ID for t-file display             | "44" (English)  |
| `x4CodeComplete.limitLanguageOutput`  | Show only preferred language in hover text           | false           |
| `x4CodeComplete.reloadLanguageData`   | Reload language files (resets to false after reload) | false           |

## Supported File Types

- **AI Scripts** (`.xml` files with `<aiscript>` root element)
- **Mission Director Scripts** (`.xml` files with `<mdscript>` root element)

## Video Demonstration

- All features up to version 1.4.1

  [![X4CodeComplete Demo: all features up to version 1.4.1](https://img.youtube.com/vi/0gBYUklBU_o/0.jpg)](https://www.youtube.com/watch?v=0gBYUklBU_o)

- Features added in version 1.5.1

  [![X4CodeComplete Demo: features added in version 1.5.1](https://img.youtube.com/vi/bTkF7GMg5gw/0.jpg)](https://www.youtube.com/watch?v=bTkF7GMg5gw)

## Usage Examples

### Variable Completion

```xml
<set_value name="$myVariable" />
<!-- Type $ to see all available variables -->
<!-- Hover over $myVariable to see usage statistics -->
```

### Label Support (AI Scripts)

```xml
<label name="start" />
<!-- ... -->
<resume label="start" /> <!-- Completion available after typing " -->
```

### Action Support (AI Scripts)

```xml
<library>
  <actions name="myAction">
    <!-- action content -->
  </actions>
</library>
<!-- ... -->
<include_interrupt_actions ref="myAction" /> <!-- Completion available -->
```

### Language File References

```xml
<!-- Hover over any of these to see translated text -->
<set_value name="$text" exact="{1001,100}" />
<debug_text text="readtext.{1001}.{100}" />
<speak actor="$ship" page="1001" line="100" />
```

## Known Limitations

- **Variable scope**: Currently limited to file scope (no namespace support)
- **Cross-file references**: Labels and actions are tracked per-file only
- **Complex expressions**: Advanced variable expressions in table lookups may not be fully parsed

## Original Release Notes (thank you Cgetty)

### 1.0.0

Initial release. Supports scriptproperties.xml autocomplete

### 1.0.1

Major improvements; now has configuration & generates the entries at startup from scriptproperties.xml, removing the need for rerunning a python script when scriptproperties.xml updates.

### 1.0.2

Hopefully, no more duplicate suggestions. Also, Peek/Go to definition for script properties!
