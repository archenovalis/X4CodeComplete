import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as sax from 'sax';
import { logger } from '../logger/logger';

export class LanguageFileProcessor {
  private languageData: Map<string, Map<string, string>> = new Map();

  /**
   * Load and parse language files from specified directories
   * @param basePath The base path containing the 't' directory
   * @param extensionsFolder The extensions folder path containing subdirectories with 't' folders
   * @returns Promise that resolves when all language files are loaded
   */
  public async loadLanguageFiles(basePath: string, extensionsFolder: string): Promise<void> {
    const config = vscode.workspace.getConfiguration('x4CodeComplete');
    const preferredLanguage: string = config.get('languageNumber') || '44';
    const limitLanguage: boolean = config.get('limitLanguageOutput') || false;

    this.languageData.clear();
    logger.info('Loading Language Files.');

    return new Promise((resolve, reject) => {
      try {
        const tDirectories: string[] = [];
        let pendingFiles = 0; // Counter to track pending file parsing operations
        let countProcessed = 0; // Counter to track processed files

        // Collect all valid 't' directories
        const rootTPath = path.join(basePath, 't');
        if (fs.existsSync(rootTPath) && fs.statSync(rootTPath).isDirectory()) {
          tDirectories.push(rootTPath);
        }

        // Check 't' directories under languageFilesFolder subdirectories
        if (fs.existsSync(extensionsFolder) && fs.statSync(extensionsFolder).isDirectory()) {
          const subdirectories = fs
            .readdirSync(extensionsFolder, { withFileTypes: true })
            .filter((item) => item.isDirectory())
            .map((item) => item.name);

          for (const subdir of subdirectories) {
            const tPath = path.join(extensionsFolder, subdir, 't');
            if (fs.existsSync(tPath) && fs.statSync(tPath).isDirectory()) {
              tDirectories.push(tPath);
            }
          }
        }

        // Process all found 't' directories
        for (const tDir of tDirectories) {
          const files = fs.readdirSync(tDir).filter((file) => file.startsWith('0001') && file.endsWith('.xml'));

          for (const file of files) {
            const languageId = this.getLanguageIdFromFileName(file);
            if (limitLanguage && languageId !== preferredLanguage && languageId !== '*' && languageId !== '44') {
              // always show 0001.xml and 0001-0044.xml (any language and english, to assist with creating translations)
              continue;
            }
            const filePath = path.join(tDir, file);
            pendingFiles++; // Increment the counter for each file being processed

            try {
              this.parseLanguageFile(filePath, () => {
                pendingFiles--; // Decrement the counter when a file is processed
                countProcessed++; // Increment the counter for processed files
                if (pendingFiles === 0) {
                  logger.info(`Loaded ${countProcessed} language files from ${tDirectories.length} 't' directories.`);
                  resolve(); // Resolve the promise when all files are processed
                }
              });
            } catch (fileError) {
              logger.info(`Error reading ${file} in ${tDir}: ${fileError}`);
              pendingFiles--; // Decrement the counter even if there's an error
              if (pendingFiles === 0) {
                resolve(); // Resolve the promise when all files are processed
              }
            }
          }
        }

        if (pendingFiles === 0) {
          resolve(); // Resolve immediately if no files are found
        }
      } catch (error) {
        logger.info(`Error loading language files: ${error}`);
        reject(error); // Reject the promise if there's an error
      }
    });
  }

  /**
   * Extract language ID from filename
   * @param fileName The filename to extract language ID from
   * @returns The language ID string
   */
  private getLanguageIdFromFileName(fileName: string): string {
    const match = fileName.match(/0001-[lL]?(\d+).xml/);
    return match && match[1] ? match[1].replace(/^0+/, '') : '*';
  }

  /**
   * Parse a single language file
   * @param filePath Path to the language file
   * @param onComplete Callback to execute when parsing is complete
   */
  private parseLanguageFile(filePath: string, onComplete: () => void): void {
    const parser = sax.createStream(true); // Create a streaming parser in strict mode
    let currentPageId: string | null = null;
    let currentTextId: string | null = null;
    const fileName: string = path.basename(filePath);
    const languageId: string = this.getLanguageIdFromFileName(fileName);

    parser.on('opentag', (node) => {
      if (node.name === 'page' && node.attributes.id) {
        currentPageId = node.attributes.id as string;
      } else if (node.name === 't' && currentPageId && node.attributes.id) {
        currentTextId = node.attributes.id as string;
      }
    });

    parser.on('text', (text) => {
      if (currentPageId && currentTextId) {
        const key = `${currentPageId}:${currentTextId}`;
        const textData: Map<string, string> = this.languageData.get(key) || new Map<string, string>();
        textData.set(languageId, text.trim());
        this.languageData.set(key, textData);
      }
    });

    parser.on('closetag', (nodeName) => {
      if (nodeName === 't') {
        currentTextId = null; // Reset text ID after closing the tag
      } else if (nodeName === 'page') {
        currentPageId = null; // Reset page ID after closing the tag
      }
    });

    parser.on('end', () => {
      onComplete(); // Notify that this file has been fully processed
    });

    parser.on('error', (err) => {
      logger.info(`Error parsing standard language file ${filePath}: ${err.message}`);
      onComplete(); // Notify even if there's an error
    });

    fs.createReadStream(filePath).pipe(parser);
  }

  /**
   * Find language text for a given page and text ID
   * @param pageId The page ID to search for
   * @param textId The text ID to search for
   * @returns The formatted language text string
   */
  public findLanguageText(pageId: string, textId: string): string {
    const config = vscode.workspace.getConfiguration('x4CodeComplete');
    let preferredLanguage: string = config.get('languageNumber') || '44';
    const limitLanguage: boolean = config.get('limitLanguageOutput') || false;

    const textData: Map<string, string> = this.languageData.get(`${pageId}:${textId}`);
    let result: string = '';

    if (textData) {
      const textDataKeys = Array.from(textData.keys()).sort((a, b) =>
        a === preferredLanguage
          ? -1
          : b === preferredLanguage
            ? 1
            : (a === '*' ? 0 : parseInt(a)) - (b === '*' ? 0 : parseInt(b))
      );

      if (limitLanguage && !textData.has(preferredLanguage)) {
        if (textData.has('*')) {
          preferredLanguage = '*';
        } else if (textData.has('44')) {
          preferredLanguage = '44';
        }
      }

      for (const language of textDataKeys) {
        if (!limitLanguage || language == preferredLanguage) {
          result += (result == '' ? '' : `\n\n`) + `${language}: ${textData.get(language)}`;
        }
      }
    }
    return result;
  }

  public provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.Hover> {
    const tPattern =
      /\{\s*(\d+)\s*,\s*(\d+)\s*\}|readtext\.\{\s*(\d+)\s*\}\.\{\s*(\d+)\s*\}|page="(\d+)"\s+line="(\d+)"/g;
    // matches:
    // {1015,7} or {1015, 7}
    // readtext.{1015}.{7}
    // page="1015" line="7"

    const range = document.getWordRangeAtPosition(position, tPattern);
    if (range) {
      const text = document.getText(range);
      const matches = tPattern.exec(text);
      tPattern.lastIndex = 0; // Reset regex state

      if (matches && matches.length >= 3) {
        let pageId: string | undefined;
        let textId: string | undefined;
        if (matches[1] && matches[2]) {
          // {1015,7} or {1015, 7}
          pageId = matches[1];
          textId = matches[2];
        } else if (matches[3] && matches[4]) {
          // readtext.{1015}.{7}
          pageId = matches[3];
          textId = matches[4];
        } else if (matches[5] && matches[6]) {
          // page="1015" line="7"
          pageId = matches[5];
          textId = matches[6];
        }

        if (pageId && textId) {
          logger.debug(`Matched pattern: ${text}, pageId: ${pageId}, textId: ${textId}`);
          const languageText = this.findLanguageText(pageId, textId);
          if (languageText) {
            const hoverText = new vscode.MarkdownString();
            hoverText.appendMarkdown('```plaintext\n');
            hoverText.appendMarkdown(languageText);
            hoverText.appendMarkdown('\n```');
            return new vscode.Hover(hoverText, range);
          }
        }
        return undefined;
      }
    }
  }

  /**
   * Clear all loaded language data
   */
  public dispose(): void {
    this.languageData.clear();
    logger.info('Language data cleared.');
  }

  /**
   * Get the size of loaded language data
   * @returns Number of loaded language entries
   */
  public getDataSize(): number {
    return this.languageData.size;
  }

  /**
   * Check if language data has been loaded
   * @returns True if language data is available
   */
  public hasData(): boolean {
    return this.languageData.size > 0;
  }

  /**
   * Get all available page IDs
   * @returns Array of unique page IDs
   */
  public getAvailablePageIds(): string[] {
    const pageIds = new Set<string>();
    for (const key of this.languageData.keys()) {
      const pageId = key.split(':')[0];
      pageIds.add(pageId);
    }
    return Array.from(pageIds).sort();
  }

  /**
   * Get all available text IDs for a specific page
   * @param pageId The page ID to get text IDs for
   * @returns Array of text IDs for the specified page
   */
  public getAvailableTextIds(pageId: string): string[] {
    const textIds = new Set<string>();
    for (const key of this.languageData.keys()) {
      if (key.startsWith(`${pageId}:`)) {
        const textId = key.split(':')[1];
        textIds.add(textId);
      }
    }
    return Array.from(textIds).sort();
  }

  /**
   * Get available languages for a specific page and text ID
   * @param pageId The page ID
   * @param textId The text ID
   * @returns Array of available language IDs
   */
  public getAvailableLanguages(pageId: string, textId: string): string[] {
    const textData = this.languageData.get(`${pageId}:${textId}`);
    return textData ? Array.from(textData.keys()).sort() : [];
  }
}
