# Change Log

All notable changes to the "x4codecomplete" extension will be documented in this file.

## [1.6.0](https://github.com/archenovalis/X4CodeComplete/compare/X4CodeComplete@v1.5.4...X4CodeComplete@v1.6.0) (2025-08-09)


### Features

* **completion:** add forced completion setting for simple edits ([9a62ff8](https://github.com/archenovalis/X4CodeComplete/commit/9a62ff85c026b7ebcdb8dd9fc0fe2b6606820f1b))
* implemented hover for element name and attribute name ([6ce4d4e](https://github.com/archenovalis/X4CodeComplete/commit/6ce4d4e9837d91f79f7f659ed1f8e0b030b9e3a0))
* **ScriptProperties:** inject additional keyword definitions into raw XML data ([af061b4](https://github.com/archenovalis/X4CodeComplete/commit/af061b4c328daa587f3a048d2d86bf663e102983))
* **ScriptProperties:** preliminary implement expansion of &lt;keyword&gt; to real values in completion ([f8582b0](https://github.com/archenovalis/X4CodeComplete/commit/f8582b0fae92331942fb984c20fbe5b99226b71b))
* **ScriptProperties:** preliminary implement step-by-step expression analysis for improved completion suggestions ([a822f33](https://github.com/archenovalis/X4CodeComplete/commit/a822f33ea016711d65db987a27522697de67ea8a))
* **scriptUtilities:** add functions for enclosing bracket pair indices ([239e149](https://github.com/archenovalis/X4CodeComplete/commit/239e149973b82f3eaa15c9fc72de10e4fafb2f22))
* **TypeEntry:** add filterPropertiesByPrefix method to retrieve properties by prefix ([a39a5b3](https://github.com/archenovalis/X4CodeComplete/commit/a39a5b3ab2759c6589a7ff7ba1a7ce10278c3479))
* **TypeEntry:** add hasProperty and getProperty method to retrieve properties by name ([c0b527c](https://github.com/archenovalis/X4CodeComplete/commit/c0b527ca1f00f5b035ddf6f3910d8524f5286816))
* **xml:** preliminary implement XML structure tracking and context-aware completions ([0eab4ff](https://github.com/archenovalis/X4CodeComplete/commit/0eab4ff9744473f32adf05485c88cb05178e0837))


### Bug Fixes

* **dependencies:** update xsd-lookup to version 1.4.1 in package.json and package-lock.json ([e0bf680](https://github.com/archenovalis/X4CodeComplete/commit/e0bf680b75f024caab551d1f1e4cad2b514dc7ce))
* **extension:** finally recover pre xsd_lookup functionality ([aff0d2b](https://github.com/archenovalis/X4CodeComplete/commit/aff0d2bec7c9994f063f2a3c6a6d9979a2cc36d0))
* **PropertyEntry:** escape &lt; and &gt; characters in description output ([c88b650](https://github.com/archenovalis/X4CodeComplete/commit/c88b650dab8ba19d19ab464190bd1963ffdda37a))
* **PropertyEntry:** improve getDescription and putAsCompletionItem methods for better markdown formatting ([a822f33](https://github.com/archenovalis/X4CodeComplete/commit/a822f33ea016711d65db987a27522697de67ea8a))
* **ScriptCompletion, Hover:** fix completion and hover logic to handle comments and single-quoted strings ([53a317a](https://github.com/archenovalis/X4CodeComplete/commit/53a317a3125a805a85b501626448b2911815c248))
* **ScriptProperties:** adjust completion logic to correctly handle property name splits ([a939065](https://github.com/archenovalis/X4CodeComplete/commit/a939065385e5d5f2db3d8536d175fc33687c6d4a))
* **ScriptProperties:** enhance hover content for specific variable pattern matching ([cb76af9](https://github.com/archenovalis/X4CodeComplete/commit/cb76af9b0e21e75cdd27dd42548b63ba7a788df2))
* **ScriptProperties:** handle missing keyword extraction by using placeholder name as fallback ([a0ad259](https://github.com/archenovalis/X4CodeComplete/commit/a0ad259c11a531ff1e12b505cf8838b5c30986c0))
* **ScriptProperties:** preparing completion for a long properties ([0e354fa](https://github.com/archenovalis/X4CodeComplete/commit/0e354fae6968d3fa59e8daea49952f310e5a42b6))
* **ScriptProperties:** refine placeholder expansion logic and improve keyword extraction ([5336106](https://github.com/archenovalis/X4CodeComplete/commit/533610676d05000d5152e9cd9d461858c2237f56))
* **ScriptProperties:** remove redundant completion candidate check for last part of property ([8b2c60b](https://github.com/archenovalis/X4CodeComplete/commit/8b2c60bb3668cf49447d4565a4bac358e61865cd))
* **ScriptProperties:** rename variable for clarity in completion generation logic ([cddb032](https://github.com/archenovalis/X4CodeComplete/commit/cddb032aaf3c3fa952335c87cc52ae83503dc94b))
* **ScriptProperties:** restrict placeholder expansion to the end of property names (temporary) ([1a607f6](https://github.com/archenovalis/X4CodeComplete/commit/1a607f64bef2b1e7bd3508f33baba2fc6b4dc534))
* **ScriptProperties:** update expanded completion description format ([c88b650](https://github.com/archenovalis/X4CodeComplete/commit/c88b650dab8ba19d19ab464190bd1963ffdda37a))
* **scripts:** fixed parent detection on scripts xml source  parsing ([e45f808](https://github.com/archenovalis/X4CodeComplete/commit/e45f8085284fcaf4929c4b0e9e312237556665bb))
* **scripts:** get rid of exceedinglyVerbose variable and make logger.debug working right way, only if debug is enabled ([893683c](https://github.com/archenovalis/X4CodeComplete/commit/893683c5136dd6e803058110cfabc2bd086277c5))
* **scriptUtilities:** add '@' as a valid break symbol for variables and expressions ([2527649](https://github.com/archenovalis/X4CodeComplete/commit/2527649a2aaa1ceabb5bdfded633a2219ede6d5a))
* **TypeEntry:** remove supertype property filtering from filterPropertiesByPrefix method as it covered by getProperties ([77c1686](https://github.com/archenovalis/X4CodeComplete/commit/77c1686308cebf3a8aa57c328265febd06f0c534))
* **TypeEntry:** update filterPropertiesByPrefix to accept optional withDot parameter for prefix matching ([22e939c](https://github.com/archenovalis/X4CodeComplete/commit/22e939c3ac2fcc0c7defc8a39eed4b057e392719))
* **TypeEntry:** update filterPropertiesByPrefix to handle dotted prefix correctly ([b7dfffe](https://github.com/archenovalis/X4CodeComplete/commit/b7dfffef9b8a6e160b08ea1259ca5ffa3e6b9b24))
* **TypeEntry:** update filterPropertiesByPrefix to handle prefixes with trailing dot right way ([0e354fa](https://github.com/archenovalis/X4CodeComplete/commit/0e354fae6968d3fa59e8daea49952f310e5a42b6))
* **XmlStructureTracker:** fix detection UnclosedAttributes and offsets separation ([d88403a](https://github.com/archenovalis/X4CodeComplete/commit/d88403a3d4ceb7b20a07bfffc58b11f123fdcb24))


### Code Refactoring

* **actions:** streamline action tracking by renaming methods and simplifying data structures ([b945ed3](https://github.com/archenovalis/X4CodeComplete/commit/b945ed3505318db5d02943685032e4042196b7ab))
* **activate:** remove commented-out code for action creation logic ([41ab4af](https://github.com/archenovalis/X4CodeComplete/commit/41ab4af84943935c1ce4984ed64a766fbc1dfd21))
* **activate:** simplify document tracking logic by removing commented-out code ([5284daa](https://github.com/archenovalis/X4CodeComplete/commit/5284daaf2f9ac25b92bbffe26c85b6f4dc7dd977))
* another turn to work with xsd ([e268964](https://github.com/archenovalis/X4CodeComplete/commit/e268964045411a7b89b7765392924e2ad74636e4))
* change source structure for scalability and maintainability ([e7c6a36](https://github.com/archenovalis/X4CodeComplete/commit/e7c6a36804534fa510b087178a11ffbd988762e2))
* clean up code formatting and improve markdown string usage across multiple files ([4ae97db](https://github.com/archenovalis/X4CodeComplete/commit/4ae97dbb8f31e0d3c21d9d5749988c8f27e7eb03))
* **completion:** enhance completion item creation and handling for better documentation ([e0bf680](https://github.com/archenovalis/X4CodeComplete/commit/e0bf680b75f024caab551d1f1e4cad2b514dc7ce))
* **completion:** fully switched to ScriptCompletion provider ([9a62ff8](https://github.com/archenovalis/X4CodeComplete/commit/9a62ff85c026b7ebcdb8dd9fc0fe2b6606820f1b))
* **completion:** preliminary partially worked version of ScriptCompletion provider ([3193c29](https://github.com/archenovalis/X4CodeComplete/commit/3193c29d22f144a4445635b0b0467bc2380201e8))
* **completion:** preparation to implement comprehensive completion via new ScriptCompletion ([cc07f56](https://github.com/archenovalis/X4CodeComplete/commit/cc07f562aed1270ec1fe66a045d49a5dca566325))
* **CompletionProvider:** update trigger characters for script completion to handle variables prefixes ([cd91f10](https://github.com/archenovalis/X4CodeComplete/commit/cd91f10c2567ffbcfaaa6cbe395d5b1fdc3ed570))
* **completion:** re-enable range usage for element name completions ([8f5bc25](https://github.com/archenovalis/X4CodeComplete/commit/8f5bc254d2ce5af6cfe3751956956d9e7b27a853))
* **completion:** update element name completion to use provided range, but commented ([8d4b7ba](https://github.com/archenovalis/X4CodeComplete/commit/8d4b7bac25cfa9a5e19a693da647682e1861845b))
* **deactivation:** enhance memory management by adding dispose methods to trackers and clearing data on extension deactivation ([dc0ebfe](https://github.com/archenovalis/X4CodeComplete/commit/dc0ebfede41a1d12be5e8ad726606c2170248600))
* **dependencies:** update xsd-lookup to version 1.6.0 ([530f0bf](https://github.com/archenovalis/X4CodeComplete/commit/530f0bf76137a999e9fb10dff43f5c64bccb9236))
* **documentTracking:** move document tracking and validation into ScriptDocumentTracker for improved clarity and maintainability ([d88403a](https://github.com/archenovalis/X4CodeComplete/commit/d88403a3d4ceb7b20a07bfffc58b11f123fdcb24))
* **extension, scriptReferencedItems:** improve logging for document activation and enhance markdown formatting for definitions ([25c3f51](https://github.com/archenovalis/X4CodeComplete/commit/25c3f511619cfaeecd0fb6b3bd832c4fdeb686c6))
* **extension, scriptReferencedItems:** streamline script completion and document tracking by consolidating trackers in trackers registry ([3a0879e](https://github.com/archenovalis/X4CodeComplete/commit/3a0879e7157f20ae3046fa772620a036b9454fd4))
* **extension:** centralize configuration management by creating X4ConfigurationManager and related utilities ([8c81bc6](https://github.com/archenovalis/X4CodeComplete/commit/8c81bc69c9f29da0c9d76447ae4c9c62fc20c5f6))
* **extension:** enhance code organization and improve documentation for clarity and maintainability ([9e05bd2](https://github.com/archenovalis/X4CodeComplete/commit/9e05bd2433e579b9711063b86d8eb3c0277edfc3))
* **extension:** enhance configuration management by creation respective interface and functions and improve type definitions for clarity ([d251fb2](https://github.com/archenovalis/X4CodeComplete/commit/d251fb2b8bf67829aa578a95ed29f90d2a0881b2))
* **Extension:** optimize startup process by deferring heavy service initialization and restructuring language provider registrations ([3bfd56f](https://github.com/archenovalis/X4CodeComplete/commit/3bfd56f7b752437ddeea8026aee6b58465648037))
* **Extension:** refactor  document change processing by making processQueuedDocumentChanges be called outside ([d1e4ded](https://github.com/archenovalis/X4CodeComplete/commit/d1e4ded2b8245240878b9c18ee0d9ca4a1a4d730))
* **extension:** rewrite VariableTracker, ActionTracker and LabelTracker to use WeakMap ([aff0d2b](https://github.com/archenovalis/X4CodeComplete/commit/aff0d2bec7c9994f063f2a3c6a6d9979a2cc36d0))
* **extension:** shifted open document tracking to own event handler, to process it our of extension activation ([d88403a](https://github.com/archenovalis/X4CodeComplete/commit/d88403a3d4ceb7b20a07bfffc58b11f123fdcb24))
* **Extension:** store script completion  characters as constant ([d1e4ded](https://github.com/archenovalis/X4CodeComplete/commit/d1e4ded2b8245240878b9c18ee0d9ca4a1a4d730))
* **Hover:** enhance hover functionality for XML elements and attributes by limiting areas of applicability, especially - single quoted string is excluded ([c097931](https://github.com/archenovalis/X4CodeComplete/commit/c0979318f3519d4a5f73eb52f7d602d0de87c6b7))
* **labels:** enhance label tracking by restructuring data types and improving validation logic ([a3e894f](https://github.com/archenovalis/X4CodeComplete/commit/a3e894fa41d6122b9c103fb5df9074a32c3819c2))
* **LanguageFileProcessor, ScriptProperties:** enhance language text handling and streamline property processing with language conversion ([c97d153](https://github.com/archenovalis/X4CodeComplete/commit/c97d15350632c88eb4f3c89218e45c3001ce535a))
* **LanguageFileProcessor:** enhance language file loading logic with improved wildcard handling and language filtering ([c1eba6f](https://github.com/archenovalis/X4CodeComplete/commit/c1eba6fe5b92ece713b08ea80006baa29311d117))
* **LanguageFileProcessor:** enhance loadLanguageFiles method for improved directory handling and file parsing ([1ab03c7](https://github.com/archenovalis/X4CodeComplete/commit/1ab03c7d6ad6517881d06ae70f7c487e6c6b25a2))
* **languageFiles:** integrate a logic for language file management and enhance loading into LanguageFileProcessor class ([9506006](https://github.com/archenovalis/X4CodeComplete/commit/950600630b3b378223eb19c31b7e50d3945f79ef))
* **languageFiles:** move language file handling logic to languageFiles.ts and streamline loading process ([3ec9957](https://github.com/archenovalis/X4CodeComplete/commit/3ec9957cd9ef12463d6b3a781278aaa00ec0e1d6))
* **logger:** change default logger level to 'info' and ensure singleton pattern ([893683c](https://github.com/archenovalis/X4CodeComplete/commit/893683c5136dd6e803058110cfabc2bd086277c5))
* **logger:** make logger as separate module ([dccbb15](https://github.com/archenovalis/X4CodeComplete/commit/dccbb150b6bca138db32832ac21920815fa55533))
* **logging:** rename 'exceedinglyVerbose' setting to 'debug' for clarity and update related logic ([c607746](https://github.com/archenovalis/X4CodeComplete/commit/c607746d6d1a08bb178ace97b0a7c4ed57080442))
* **referenced-items:** enhance referenced item detection and completion logic by adding attribute type checks and consolidating related mappings ([2dd0f4b](https://github.com/archenovalis/X4CodeComplete/commit/2dd0f4ba4e28ca83f01f8ad92cbb1511e5d9be9c))
* **referenced-items:** implement ReferencedItemsTracker for managing item definitions and references, to use the same code for labels and actions ([81ccacd](https://github.com/archenovalis/X4CodeComplete/commit/81ccacd73dd60f5fbda55701af833eb93d4d47cf))
* **referencedItems:** implemented ReferencedItemsWithExternalTracker, currently with possibility to track such elements thru all opened documents (actions) ([d88403a](https://github.com/archenovalis/X4CodeComplete/commit/d88403a3d4ceb7b20a07bfffc58b11f123fdcb24))
* replace the xsdReference.ts  by xsd_lookup package for the XML structure  trucking, element validating and context-aware  completion ([7252e97](https://github.com/archenovalis/X4CodeComplete/commit/7252e974952c5ed2ab7f58a3a3241999132b710c))
* **scriptCompletion, scriptProperties:** enhance completion logic by introducing break symbol handling and updating processText method signature, to be prepared to improve it ([68e4d50](https://github.com/archenovalis/X4CodeComplete/commit/68e4d500bbfe5f728876de2d353d0f92f14533a2))
* **ScriptCompletion:** enhance completion logic to handle single-quoted strings ([c097931](https://github.com/archenovalis/X4CodeComplete/commit/c0979318f3519d4a5f73eb52f7d602d0de87c6b7))
* **scriptCompletion:** enhance element name completion logic using the previous sibling element after update xsd-lookup to version 1.5.0 ([39a9c86](https://github.com/archenovalis/X4CodeComplete/commit/39a9c861ac94dd98c6ede8f81f4c5f245ebf03f6))
* **ScriptCompletion:** exclude "comment" attribute from completion and hover generation ([f07bd77](https://github.com/archenovalis/X4CodeComplete/commit/f07bd77f9358f6fb3244402cbc1ae75d11fca008))
* **scriptCompletion:** improve cancellation handling in provideCompletionItems ([e278d4c](https://github.com/archenovalis/X4CodeComplete/commit/e278d4cdd9e1753fcaeba098beb986e1e71b4e0d))
* **scriptCompletion:** move ScriptCompletion class to scriptCompletion.ts ([395b83a](https://github.com/archenovalis/X4CodeComplete/commit/395b83a26bac9141be863bd650bde5ee493fe733))
* **ScriptCompletion:** rename prepareCompletion to provideCompletionItems for clarity ([ccf9236](https://github.com/archenovalis/X4CodeComplete/commit/ccf9236f6786d49dbde12722c9526a18fbad33bd))
* **scriptCompletion:** simplify getNearestBreakSymbolIndex method by removing unnecessary parameter and clean up related logic ([4d44db6](https://github.com/archenovalis/X4CodeComplete/commit/4d44db6e8637296d2bde7ed98bbf80593fd678ac))
* **ScriptCompletions:** process cached document changes on call for completion tracking ([d1e4ded](https://github.com/archenovalis/X4CodeComplete/commit/d1e4ded2b8245240878b9c18ee0d9ca4a1a4d730))
* **scriptCompletion:** streamline completion item creation and improve type handling ([2527649](https://github.com/archenovalis/X4CodeComplete/commit/2527649a2aaa1ceabb5bdfded633a2219ede6d5a))
* **ScriptDocumentTracker, ScriptProperties:** implement document change tracking in batch mode for improved performance ([43c4cbb](https://github.com/archenovalis/X4CodeComplete/commit/43c4cbb48d4841a5be223726663cb0e1b6011b02))
* **scriptDocumentTracker:** as filtering for completion a new variable name on it's  editing is done in scriptVariables, we will not skip to track it ... ([257e326](https://github.com/archenovalis/X4CodeComplete/commit/257e3268e4fd79df73ad065e8570585a324f2453))
* **scriptDocumentTracker:** enhance variable type determination logic for improved handling of table keys ([1a2d412](https://github.com/archenovalis/X4CodeComplete/commit/1a2d41258de2dfcb4f3c98e3d0f290fe2d0d2ecb))
* **ScriptDocumentTracker:** streamline variable and table key pattern handling by importing constants from scriptVariables ([d1e4ded](https://github.com/archenovalis/X4CodeComplete/commit/d1e4ded2b8245240878b9c18ee0d9ca4a1a4d730))
* **ScriptMetadata:** improve metadata handling and document tracking on startup ([65eeea2](https://github.com/archenovalis/X4CodeComplete/commit/65eeea2524f360a11b9b006b32f13885ad424dd5))
* **ScriptProperties, ScriptCompletion, XmlStructureTracker:** implement cancellation token support in methods ([9d5a5e8](https://github.com/archenovalis/X4CodeComplete/commit/9d5a5e81202f30917897cfef678cfd8a14fc3029))
* **ScriptProperties:** add defensible alert level keyword and update placeholder handling for reassigned keyword extraction ([3e70221](https://github.com/archenovalis/X4CodeComplete/commit/3e70221b12d5593b4b9e67d99f58dd45b966dc92))
* **ScriptProperties:** add stub to handle md.&lt;mdscriptname&gt;.&lt;cuename&gt; in hover generation ([91a0c62](https://github.com/archenovalis/X4CodeComplete/commit/91a0c623d49ced54a4bb696cb9ddb921c6e1d974))
* **scriptProperties:** adjust expression handling in makeCompletionsFromExpression ([5ffb678](https://github.com/archenovalis/X4CodeComplete/commit/5ffb678310361a95bff13b02d7da164f02a0597b))
* **ScriptProperties:** enhance completion logic and improve hover content generation by better type of property processing and $&lt;variable&gt; properties tracking ([d1e4ded](https://github.com/archenovalis/X4CodeComplete/commit/d1e4ded2b8245240878b9c18ee0d9ca4a1a4d730))
* **scriptProperties:** enhance expression handling in analyzeExpressionForHover ([18fb7ae](https://github.com/archenovalis/X4CodeComplete/commit/18fb7aea839e9e69cfa51404eae51d14906712a3))
* **scriptProperties:** enhance expression splitting logic ([08b2bb8](https://github.com/archenovalis/X4CodeComplete/commit/08b2bb8ec361e9f1f0468b50abe5e9a1c71926cc))
* **ScriptProperties:** enhance hover content by adding result type information ([9254bf9](https://github.com/archenovalis/X4CodeComplete/commit/9254bf9eb9d7eac084dbd24528c9903ce5cb7441))
* **ScriptProperties:** enhance keyword import processing to be more comply with property definition ([4f3836c](https://github.com/archenovalis/X4CodeComplete/commit/4f3836c150d14b0817bcdb919a104f45be609ac8))
* **ScriptProperties:** enhance property handling by introducing types not assignable to variables ([6b11ce7](https://github.com/archenovalis/X4CodeComplete/commit/6b11ce7dce2c650190b9aadbce505ab0ab764731))
* **ScriptProperties:** enhance property to handle a variables properties ([6b11ce7](https://github.com/archenovalis/X4CodeComplete/commit/6b11ce7dce2c650190b9aadbce505ab0ab764731))
* **scriptProperties:** enhance ScriptProperties class with XsdReference integration and improved property handling ([2527649](https://github.com/archenovalis/X4CodeComplete/commit/2527649a2aaa1ceabb5bdfded633a2219ede6d5a))
* **scriptProperties:** extend the KeywordEntry to handle script and type fields from scriptproperties.xml ([92fc544](https://github.com/archenovalis/X4CodeComplete/commit/92fc544a690ae027da979a0a26975f76a385db1f))
* **ScriptProperties:** extract logic for adding unique completions into a separate method for improved readability and maintainability and apply it on &lt;keyword&gt; constructions processing too ([6afcf88](https://github.com/archenovalis/X4CodeComplete/commit/6afcf886d638863625e856abbe7c4d341c9ef364))
* **ScriptProperties:** implement asynchronous initialization and reading of script properties to enhance performance ([b94a09f](https://github.com/archenovalis/X4CodeComplete/commit/b94a09f52a2f1450d828b5a4962c87a745447629))
* **ScriptProperties:** implement enhanced hover provider for improved expression analysis based on the same logic, as completion (step by step) ([41ff72e](https://github.com/archenovalis/X4CodeComplete/commit/41ff72ee04f8168cb82fb47cf7ea88d7fc4e90c9))
* **scriptProperties:** improve expression splitting in generateCompletionsFromProperties ([337108b](https://github.com/archenovalis/X4CodeComplete/commit/337108b29f42e7f8a5b886c9eb777aff4594ffb4))
* **ScriptProperties:** inject additional keyword definitions for improved functionality ([f5ff3cb](https://github.com/archenovalis/X4CodeComplete/commit/f5ff3cb2d95b8fcb6ad996ce14265b7d007566aa))
* **ScriptProperties:** move  filterPropertiesByPrefix method from TypeEntry for improved placeholder handling and matching logic to process the &lt;keyword&gt; constructions inside a complex property ([bbe40c4](https://github.com/archenovalis/X4CodeComplete/commit/bbe40c4da2d72ab9607f54e1737819714e100e63))
* **scriptProperties:** move all logic and definitions related to parsing and preparing the scriptProperties,xml to the scriptProperties.ta ([a6c867b](https://github.com/archenovalis/X4CodeComplete/commit/a6c867b8d31eb3290b4e868a1ec075d4cf436ded))
* **scriptProperties:** rename processText to makeCompletionsFromExpression method ([8427a99](https://github.com/archenovalis/X4CodeComplete/commit/8427a99ef034f200d157588ccfd73c1750838316))
* **ScriptProperties:** replace hardcoded properties with imports for dynamic data retrieval in keyword definitions ([c1000c9](https://github.com/archenovalis/X4CodeComplete/commit/c1000c966432908631e3bc478ee4dae05c72b729))
* **scriptProperties:** restructure ScriptProperties class and enhance scriptProperties.xm; processing logic ([5b31697](https://github.com/archenovalis/X4CodeComplete/commit/5b31697f80f25b458ba69b98d90dcb21b27fc625))
* **scriptProperties:** simplify completion logic in makeCompletionsFromExpression ([e278d4c](https://github.com/archenovalis/X4CodeComplete/commit/e278d4cdd9e1753fcaeba098beb986e1e71b4e0d))
* **ScriptProperties:** simplify property filtering logic and enhance hover content formatting ([91a0c62](https://github.com/archenovalis/X4CodeComplete/commit/91a0c623d49ced54a4bb696cb9ddb921c6e1d974))
* **scriptProperties:** starting adoption to the new logic ([d55c2dc](https://github.com/archenovalis/X4CodeComplete/commit/d55c2dca77447199493397ee1949d0aacc87374a))
* **ScriptProperties:** streamline completion item handling by removing unnecessary checks and improving regex definition ([0132daf](https://github.com/archenovalis/X4CodeComplete/commit/0132dafe2f070c66059b1022dfbb271cb816727a))
* **ScriptProperties:** streamline hover implementation by removing previous "global" hover implementation and unnecessary properties ([8152761](https://github.com/archenovalis/X4CodeComplete/commit/815276182f9d79d951e3cd6072464b236146c2d4))
* **ScriptProperties:** switch to use xpath and @xmldom/xmldom to parse keywords enums from the scriptproperties.xml, as most featured xpath ([f5ff3cb](https://github.com/archenovalis/X4CodeComplete/commit/f5ff3cb2d95b8fcb6ad996ce14265b7d007566aa))
* **scriptProperties:** update processText method to include schema parameter and enhance property retrieval based on it ([92fc544](https://github.com/archenovalis/X4CodeComplete/commit/92fc544a690ae027da979a0a26975f76a385db1f))
* **scriptProperties:** update scriptProperties type handling and enhance definition retrieval logic ([b910c27](https://github.com/archenovalis/X4CodeComplete/commit/b910c2714386b74b18ab0f0d41513b00d5560957))
* **scriptReferencedItems:** add noCompletion flag to disable item completion for definitions ([3061594](https://github.com/archenovalis/X4CodeComplete/commit/3061594fbbae379bf3d8430c8df2edd5672512f8))
* **scriptReferencedItems:** enhance item detail retrieval and add external item completion support ([585b8ed](https://github.com/archenovalis/X4CodeComplete/commit/585b8eddfc76b44e13c75a091d39516c81a91fa7))
* **scriptReferencedItems:** extend indirect processing trackers for such items ([00b2269](https://github.com/archenovalis/X4CodeComplete/commit/00b2269f0ae461a6d210d97a013dc08d8cb16b6f))
* **scriptReferencedItems:** extend item type to include 'handler' and update registry with handler definitions ([00b2269](https://github.com/archenovalis/X4CodeComplete/commit/00b2269f0ae461a6d210d97a013dc08d8cb16b6f))
* **scriptReferencedItems:** implement true external referencing from extracted folder ([a1168fc](https://github.com/archenovalis/X4CodeComplete/commit/a1168fc31e8af2ff6255aae493765dd03a999c99))
* **scriptReferencedItems:** rename ReferencedItemsWithExternalTracker to ReferencedItemsWithExternalDefinitionsTracker for clarity and ([a1168fc](https://github.com/archenovalis/X4CodeComplete/commit/a1168fc31e8af2ff6255aae493765dd03a999c99))
* **scriptReferencedItems:** streamline item type handling and initialize detection map, i.e. get rid of variables scriptReferencedItems types initialization ([1f04536](https://github.com/archenovalis/X4CodeComplete/commit/1f045360c2b77d423f7228b00e42ad6bc050c252))
* **scriptReferencedItems:** update filePrefix handling with multiple values ([cfb9f89](https://github.com/archenovalis/X4CodeComplete/commit/cfb9f89d79ac855fc4adb503c2e393644b0496b5))
* **scripts:** add parentName to AttributeRange for improved context ([13e8e50](https://github.com/archenovalis/X4CodeComplete/commit/13e8e50c6b2d628644213b45c71628db6a637d9a))
* **scripts:** added an `offsetsMap` to track changes in text offsets due to patching, allowing accurate position tracking during parsing. ([6ac8666](https://github.com/archenovalis/X4CodeComplete/commit/6ac86666268f1a6809460ebcf039b51c2ac82c9c))
* **scripts:** added xsd parsing and usage for the variable definition detection ([04ea834](https://github.com/archenovalis/X4CodeComplete/commit/04ea8347ebcf678ac908c851a9b668bf472c0fdb))
* **scripts:** another turn of enrichment methods for improved element handling. TODO: to find a way to define rights parents for standard actions under conditions, init, and actions (outside attention) ([edd27b9](https://github.com/archenovalis/X4CodeComplete/commit/edd27b90e6de8c3e9374a496ea7deeda2690dd87))
* **scripts:** apply approach from group enrichment of complex type by complex type enrichment ([59364cd](https://github.com/archenovalis/X4CodeComplete/commit/59364cdf0788772fa66bc3269918e9b8db13aa47))
* **scripts:** clear some garbage ([8c020a8](https://github.com/archenovalis/X4CodeComplete/commit/8c020a865e1e296731a386423c7121663e0a6531))
* **scripts:** enhance completion item provider to utilize parentName for attribute context ([0dd9bbc](https://github.com/archenovalis/X4CodeComplete/commit/0dd9bbc0831e0777e1e3a6c2eaf26139023f5a8a))
* **scripts:** enhance getAllPossibleAttributes to include parentName filtering ([b590f46](https://github.com/archenovalis/X4CodeComplete/commit/b590f4619a141903005da8e81304879230867e43))
* **scripts:** enhance nested element definition search with parent context ([c106328](https://github.com/archenovalis/X4CodeComplete/commit/c10632871717f510d6af6e7ec610e38bf348dbef))
* **scripts:** enhance Schema class with group reference handling and XPath improvements ([1f675e0](https://github.com/archenovalis/X4CodeComplete/commit/1f675e0d6ca323b3faa3f7deed45d1617e630057))
* **scripts:** enhance Schema class with pre-caching and enrichment methods for improved element and group handling ([fd6c618](https://github.com/archenovalis/X4CodeComplete/commit/fd6c6185103ba88220f97508a3fde78f1f1b0ac5))
* **scripts:** enhanced the `isInElementStartTag` method to improve element detection logic. ([6ac8666](https://github.com/archenovalis/X4CodeComplete/commit/6ac86666268f1a6809460ebcf039b51c2ac82c9c))
* **scripts:** finally implemented processing multiple variation of element attributes combinations ([e45f808](https://github.com/archenovalis/X4CodeComplete/commit/e45f8085284fcaf4929c4b0e9e312237556665bb))
* **scripts:** group content instead references in groups is rewritten ([1f675e0](https://github.com/archenovalis/X4CodeComplete/commit/1f675e0d6ca323b3faa3f7deed45d1617e630057))
* **scripts:** improve completion working inside the attribute value range ([04ea834](https://github.com/archenovalis/X4CodeComplete/commit/04ea8347ebcf678ac908c851a9b668bf472c0fdb))
* **scripts:** introduced a new function `patchUnclosedTags` to automatically close unclosed XML tags during parsing. ([6ac8666](https://github.com/archenovalis/X4CodeComplete/commit/6ac86666268f1a6809460ebcf039b51c2ac82c9c))
* **scriptsMetadata:** move all logic and definitions related to script types and metadata to scriptsMetadata.ts ([a6c867b](https://github.com/archenovalis/X4CodeComplete/commit/a6c867b8d31eb3290b4e868a1ec075d4cf436ded))
* **scriptsMetadata:** use regex instead sax to detect script files ([213a41c](https://github.com/archenovalis/X4CodeComplete/commit/213a41cf98001adc3062cbc94355bacee214dc0a))
* **scripts:** modified the `getElements` method to return elements based on their range, ensuring the correct element is identified. ([6ac8666](https://github.com/archenovalis/X4CodeComplete/commit/6ac86666268f1a6809460ebcf039b51c2ac82c9c))
* **scripts:** optimize schema loading by caching included schemas ([96cabd6](https://github.com/archenovalis/X4CodeComplete/commit/96cabd63f7f2cbc530af444306c956d0ee875864))
* **scripts:** refactor getting possible attribute values to be comply with multiple element attributes sets definition ([2e346bb](https://github.com/archenovalis/X4CodeComplete/commit/2e346bb6ea1125f3a9d7d734a566ec1f9f8f3fb2))
* **scripts:** streamline schema processing by reorganizing group and type application logic ([6c0dd98](https://github.com/archenovalis/X4CodeComplete/commit/6c0dd987bb8fd796d7d65ddd14dc4ae09fcc6048))
* **scripts:** update caching logic in Schema class for improved type and element handling ([7056599](https://github.com/archenovalis/X4CodeComplete/commit/7056599aa7ffe10bd2d2c8fb0077ed32bf4dba30))
* **scripts:** update element and attribute handling to support multiple definitions ([b3507f7](https://github.com/archenovalis/X4CodeComplete/commit/b3507f70e0a1522716d6c97fa4e94aa598114885))
* **scripts:** update element structure to use parentId and parentName for better clarity ([2e346bb](https://github.com/archenovalis/X4CodeComplete/commit/2e346bb6ea1125f3a9d7d734a566ec1f9f8f3fb2))
* **scripts:** updated the `XmlStructureTracker` class to utilize the new patching function, ensuring more robust XML handling. ([6ac8666](https://github.com/archenovalis/X4CodeComplete/commit/6ac86666268f1a6809460ebcf039b51c2ac82c9c))
* **scripts:** use manual xPath to avoid cycling in xsd structures searches ([0dd9bbc](https://github.com/archenovalis/X4CodeComplete/commit/0dd9bbc0831e0777e1e3a6c2eaf26139023f5a8a))
* **scripts:** XML parsing and enhance error handling ([6ac8666](https://github.com/archenovalis/X4CodeComplete/commit/6ac86666268f1a6809460ebcf039b51c2ac82c9c))
* **scriptUtilities:** improve bracket pair index detection ([5ffb678](https://github.com/archenovalis/X4CodeComplete/commit/5ffb678310361a95bff13b02d7da164f02a0597b))
* **scriptUtilities:** improve breakout handling for expressions and variables with clearer structure ([92fc544](https://github.com/archenovalis/X4CodeComplete/commit/92fc544a690ae027da979a0a26975f76a385db1f))
* **scriptUtilities:** introduce utility functions for handling break symbols in variables and expressions ([d55c2dc](https://github.com/archenovalis/X4CodeComplete/commit/d55c2dca77447199493397ee1949d0aacc87374a))
* **ScriptUtilities:** update breakouts for expressions and add single-quote handling functions ([c097931](https://github.com/archenovalis/X4CodeComplete/commit/c0979318f3519d4a5f73eb52f7d602d0de87c6b7))
* **scriptVariables, scriptsMetadata:** update script type handling ([213a41c](https://github.com/archenovalis/X4CodeComplete/commit/213a41cf98001adc3062cbc94355bacee214dc0a))
* **scriptVariables:** improve variable detail formatting and clean up code ([2527649](https://github.com/archenovalis/X4CodeComplete/commit/2527649a2aaa1ceabb5bdfded633a2219ede6d5a))
* **scriptVariables:** move there regular expressions for variable pattern matching ([d1e4ded](https://github.com/archenovalis/X4CodeComplete/commit/d1e4ded2b8245240878b9c18ee0d9ca4a1a4d730))
* **scriptVariables:** move VariableTracker class and related types for variable management to scriptVariables.ts ([22ea972](https://github.com/archenovalis/X4CodeComplete/commit/22ea9724db034623168d82cb286803e29712071d))
* **scriptVariables:** update variablePatternExact regex to allow optional '@' prefix ([91a0c62](https://github.com/archenovalis/X4CodeComplete/commit/91a0c623d49ced54a4bb696cb9ddb921c6e1d974))
* **trackScriptDocument:** restore functionality after switching to the xsd_lookup related to lvalue ([8c020a8](https://github.com/archenovalis/X4CodeComplete/commit/8c020a865e1e296731a386423c7121663e0a6531))
* **trackScriptDocument:** streamline label and action handling logic ([68d7696](https://github.com/archenovalis/X4CodeComplete/commit/68d769671378306eb6a52b7d90329da5ca90b0cf))
* **TypeEntry:** enhance prepareItems method to support cancellation token for improved UI responsiveness ([fe7a6fd](https://github.com/archenovalis/X4CodeComplete/commit/fe7a6fd9b1c456b57e078eefab85a5cf8d10d003))
* **TypeEntry:** make it possible to work with {} part in properties ... ([2b326c7](https://github.com/archenovalis/X4CodeComplete/commit/2b326c76555f15a624f2f5fc10e721c4964707e8))
* **TypeEntry:** rename withDot parameter to appendDot in filterPropertiesByPrefix for clarity ([a822f33](https://github.com/archenovalis/X4CodeComplete/commit/a822f33ea016711d65db987a27522697de67ea8a))
* update xsd-lookup package to version 1.2.1 and enhance attribute names and possible values handling in completion logic ([8695a76](https://github.com/archenovalis/X4CodeComplete/commit/8695a76145a90f1cd612fc6cccecc6cc37b9c4ec))
* update xsd-lookup package to version 1.2.4 and adjust dependencies ([ea0cb7d](https://github.com/archenovalis/X4CodeComplete/commit/ea0cb7d7890842c85191aad31c741ab46c9a7418))
* update xsd-lookup package to version 1.3.0 ([6ce4d4e](https://github.com/archenovalis/X4CodeComplete/commit/6ce4d4e9837d91f79f7f659ed1f8e0b030b9e3a0))
* **validation:** initial realization of  diagnostic for xml elements ([20b2c40](https://github.com/archenovalis/X4CodeComplete/commit/20b2c40ed845cd29c4ea023590676ab5523aa032))
* **variables, labels:** enhance variable and label tracking by adding definitions and references, and streamlining retrieval methods ([d5560e6](https://github.com/archenovalis/X4CodeComplete/commit/d5560e61bdfc8f9439ce8f48dbeb5e3eae50209f))
* **variables:** enhance variable tracking by consolidating details and updating method signatures ([9e3d066](https://github.com/archenovalis/X4CodeComplete/commit/9e3d0661fa5bc855716eff3be7987b8a32d1bc9e))
* **variableTracker, scriptsMetadata:** rename 'scheme' to 'schema' for consistency across the codebase ([e18221a](https://github.com/archenovalis/X4CodeComplete/commit/e18221a272aa4e340ee4e18005427f4f4bedcdd1))
* **variableTracker:** update getAllVariablesForDocumentMap to exclude current value of variable name, if it currently edited ([6620cfa](https://github.com/archenovalis/X4CodeComplete/commit/6620cfa677f5eaf60180fa50aae7c8a6d63412c5))
* **xml-structure-tracker:** enhance attribute handling by adding range property and improving unclosed attribute patching logic ([702f1b1](https://github.com/archenovalis/X4CodeComplete/commit/702f1b1825902f0ea5ead452401b1d9a40857d7f))
* **xml:** optimize XML structure tracking with improved parsing logic and document change detection ([28f764a](https://github.com/archenovalis/X4CodeComplete/commit/28f764a004e9f07f66b7ed23f3b2d6c4b5e0abe6))
* **XmlStructureTracker:** enhance attribute retrieval methods to accept optional element parameter for improved context handling ([d1e4ded](https://github.com/archenovalis/X4CodeComplete/commit/d1e4ded2b8245240878b9c18ee0d9ca4a1a4d730))
* **XmlStructureTracker:** improve code formatting and consistency in xmlStructureTracker.ts ([91b8616](https://github.com/archenovalis/X4CodeComplete/commit/91b8616b913f1f70f160567c4218dbceb40595d6))
* **xmlStructureTracker:** rename ElementRange to XmlElement, AttributeRange to XmlElementAttribute ([e0bf680](https://github.com/archenovalis/X4CodeComplete/commit/e0bf680b75f024caab551d1f1e4cad2b514dc7ce))
* **xmlStructureTracker:** simplify parent-child relationships by using references instead of IDs ([e0bf680](https://github.com/archenovalis/X4CodeComplete/commit/e0bf680b75f024caab551d1f1e4cad2b514dc7ce))
* **xmlStructureTracker:** streamline xml tracking by renaming methods ([b945ed3](https://github.com/archenovalis/X4CodeComplete/commit/b945ed3505318db5d02943685032e4042196b7ab))
* **xmlStructureTracker:** unify the parsed element store in WeakMap attribute ([aff0d2b](https://github.com/archenovalis/X4CodeComplete/commit/aff0d2bec7c9994f063f2a3c6a6d9979a2cc36d0))
* **xsd_lookup:** update version of xsd_lookup to 1.4.0 ([dc0ebfe](https://github.com/archenovalis/X4CodeComplete/commit/dc0ebfede41a1d12be5e8ad726606c2170248600))


### Miscellaneous Chores

* **dependencies:** update xsd-lookup to version 1.5.1 to handle the inline enumeration types definitions ([540a02d](https://github.com/archenovalis/X4CodeComplete/commit/540a02de556743c15ac90d854fa7d5e784e66cf2))
* migrate out deprecated vscode package ([0b187c8](https://github.com/archenovalis/X4CodeComplete/commit/0b187c85e9d239c047c8f9a33f271b69a58b150c))
* **scripts:** update dependencies ([3b1b306](https://github.com/archenovalis/X4CodeComplete/commit/3b1b3063dc18dc1c7b125935f0f8bace8010667e))

## [1.5.4](https://github.com/archenovalis/X4CodeComplete/compare/X4CodeComplete@v1.5.3...X4CodeComplete@v1.5.4) (2025-06-18)


### Bug Fixes

* **scripts:** correct typos in comments and variable names for clarity ([0f9de3d](https://github.com/archenovalis/X4CodeComplete/commit/0f9de3db698babde2fb56d3275cee5d8396435d1))
* **scripts:** correct variable position calculation in variable tracking logic ([2821a8f](https://github.com/archenovalis/X4CodeComplete/commit/2821a8f3ec7f4f52a34b3b53ecd5fba4c025926b))
* **scripts:** enhance token parsing and property handling in completion logic for literals ([92ae5d5](https://github.com/archenovalis/X4CodeComplete/commit/92ae5d59549f1b646dbb5e4e40f2d2a468df1e0b))
* **scripts:** restore and enhance properties completion logic ([efd653f](https://github.com/archenovalis/X4CodeComplete/commit/efd653f8527ecc99e38bc35368c62089df71e718))


### Code Refactoring

* **scripts:** preliminary add variable definition detection for variables - non parameters of aiscript ([9b863c2](https://github.com/archenovalis/X4CodeComplete/commit/9b863c2390e8244a77bf091b7337f2eed725fd76))
* **scripts:** simplify property building logic and improve token matching ([c4f9220](https://github.com/archenovalis/X4CodeComplete/commit/c4f9220239ce55bc4b7d53cd10cec8195cd1f8ea))
* **variables:** enhance variable tracking with definitions and priorities ([18ec57c](https://github.com/archenovalis/X4CodeComplete/commit/18ec57c493b497f807eff4a5724a072500d7e6af))
* **variables:** improve variable tracking structure and enhance completion logic ([4dfe91e](https://github.com/archenovalis/X4CodeComplete/commit/4dfe91e15f7a9e283b73c8bc884c2d16bac3f51d))


### Documentation

* **bbcode:** Update bbcode files ([c2132ed](https://github.com/archenovalis/X4CodeComplete/commit/c2132ed8f98d0addda01f19d5a170b9613732c54))
* **bbcode:** Update bbcode files ([5eae635](https://github.com/archenovalis/X4CodeComplete/commit/5eae635b8c34f486a3621cb8bdebda065f5d4daf))
* **bbcode:** Update bbcode files ([4daee79](https://github.com/archenovalis/X4CodeComplete/commit/4daee79f6fd5e2cf8a3ddbe4eea583534501f5ed))
* **scripts:** refine README.md for clarity on Marketplace usage ([af6787f](https://github.com/archenovalis/X4CodeComplete/commit/af6787fe37678edce367d20d0aa191180bc8e676))
* **scripts:** update demo links for version 1.5.4 and enhance version history ([b7b678a](https://github.com/archenovalis/X4CodeComplete/commit/b7b678a7425ef428fdca44b3ae290ab423c037a6))
* **scripts:** update README.md ([3406998](https://github.com/archenovalis/X4CodeComplete/commit/3406998fc35fca49f9805dcc93e9eff6a6c4cdde))
* **scripts:** update README.md for version 1.5.3 release and installation instructions ([4fbb848](https://github.com/archenovalis/X4CodeComplete/commit/4fbb8485bc3a8318cec99f0e316a90fe3b864468))
* **scripts:** update README.md to clarify Marketplace usage ([4054949](https://github.com/archenovalis/X4CodeComplete/commit/4054949c96037a521f3b85a52433f9773a604c2e))
* **scripts:** update README.md to include logo addition and Marketplace details ([c40c1dc](https://github.com/archenovalis/X4CodeComplete/commit/c40c1dc5717af74d6d4d13aa2a700db991a59dc1))
* **scripts:** update version history to include variable position calculation fix ([da2cd07](https://github.com/archenovalis/X4CodeComplete/commit/da2cd07ec37e74af6e1345640adf520adb223083))
* **scripts:** update version history to reflect restoration of properties completion and variable definitions detection ([9b1a1f9](https://github.com/archenovalis/X4CodeComplete/commit/9b1a1f98abaa4b793875363c50ed84b4d8f30a49))

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
