import * as vscode from 'vscode';
import * as fs from 'fs';
import { promises as fsp } from 'fs';
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

    const tDirectories: string[] = [];
    const rootTPath = path.join(basePath || '', 't');

    const pathIsDir = async (p: string): Promise<boolean> => {
      try {
        const stat = await fsp.stat(p);
        return stat.isDirectory();
      } catch {
        return false;
      }
    };

    // Collect root t directory
    if (basePath && (await pathIsDir(rootTPath))) {
      tDirectories.push(rootTPath);
    }

    // Collect all sub-extension t directories
    if (extensionsFolder && (await pathIsDir(extensionsFolder))) {
      try {
        const entries = await fsp.readdir(extensionsFolder, { withFileTypes: true });
        for (const dirent of entries) {
          if (!dirent.isDirectory()) continue;
          const tPath = path.join(extensionsFolder, dirent.name, 't');
          if (await pathIsDir(tPath)) {
            tDirectories.push(tPath);
          }
        }
      } catch (err) {
        logger.info(`Error reading extensions folder '${extensionsFolder}': ${err}`);
      }
    }

    // Build allowed language set when limiting output
    const allowedLanguageIds: Set<string> = new Set<string>(['*']);
    if (preferredLanguage) {
      allowedLanguageIds.add(preferredLanguage);
      if (preferredLanguage !== '44') allowedLanguageIds.add('44');
    } else {
      allowedLanguageIds.add('44');
    }

    // Gather files to parse
    const filesToParse: string[] = [];
    for (const tDir of tDirectories) {
      try {
        const files = await fsp.readdir(tDir);
        // Detect wildcard file presence in this directory (0001.xml -> '*')
        let hasWildcardInDir = false;
        for (const f of files) {
          if (!f.startsWith('0001') || !f.endsWith('.xml')) continue;
          const langId = this.getLanguageIdFromFileName(f);
          if (langId === '*') {
            hasWildcardInDir = true;
            break;
          }
        }

        // Build allowed set for this directory
        let allowedForDir = allowedLanguageIds;
        if (limitLanguage && preferredLanguage !== '44' && hasWildcardInDir && allowedLanguageIds.has('44')) {
          // If wildcard exists and 44 was only added implicitly, skip 44 in this dir
          allowedForDir = new Set(allowedLanguageIds);
          allowedForDir.delete('44');
        }
        for (const file of files) {
          if (!file.startsWith('0001') || !file.endsWith('.xml')) continue;
          const languageId = this.getLanguageIdFromFileName(file);
          // If the user enabled limiting, only include configured language and 44 (plus '*')
          if (limitLanguage && !allowedForDir.has(languageId)) continue;
          filesToParse.push(path.join(tDir, file));
        }
      } catch (err) {
        logger.info(`Error reading directory '${tDir}': ${err}`);
      }
      // Yield to the event loop to keep host responsive between directories
      await Promise.resolve();
    }

    if (filesToParse.length === 0) {
      logger.info(`No language files found across ${tDirectories.length} 't' directories.`);
      return;
    }

    // Parse files with moderate concurrency to avoid I/O bursts
    const concurrency = 8;
    let processed = 0;
    const runWorker = async (index: number) => {
      while (index < filesToParse.length) {
        const filePath = filesToParse[index];
        try {
          await this.parseLanguageFileAsync(filePath);
        } catch (e) {
          logger.info(`Error parsing language file '${filePath}': ${e}`);
        } finally {
          processed++;
        }
        index += concurrency;
        // Yield occasionally
        if (processed % 10 === 0) await Promise.resolve();
      }
    };

    // Launch workers
    await Promise.all(Array.from({ length: Math.min(concurrency, filesToParse.length) }, (_, i) => runWorker(i)));

    logger.info(`Loaded ${processed} language files from ${tDirectories.length} 't' directories.`);
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

  // Promise-based wrapper around parseLanguageFile for async/await usage
  private parseLanguageFileAsync(filePath: string): Promise<void> {
    return new Promise((resolve) => {
      this.parseLanguageFile(filePath, () => resolve());
    });
  }

  /**
   * Find language text for a given page and text ID
   * @param pageId The page ID to search for
   * @param textId The text ID to search for
   * @returns The formatted language text string
   */
  public findLanguageText(pageId: string, textId: string, getOnlyText: boolean = false): string {
    const config = vscode.workspace.getConfiguration('x4CodeComplete');
    let preferredLanguage: string = config.get('languageNumber') || '44';
    const limitLanguage: boolean = config.get('limitLanguageOutput') || getOnlyText || false;

    const textData: Map<string, string> = this.languageData.get(`${pageId}:${textId}`);
    let result: string = '';

    if (textData) {
      const textDataKeys = Array.from(textData.keys()).sort((a, b) =>
        a === preferredLanguage ? -1 : b === preferredLanguage ? 1 : (a === '*' ? 0 : parseInt(a)) - (b === '*' ? 0 : parseInt(b))
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
          result += (result == '' ? '' : `  \n`) + `${getOnlyText ? '' : language + ': '}${textData.get(language)}`;
        }
      }
    }
    return result;
  }

  private textReplacer(match, pageId, textId) {
    const languageText = this.findLanguageText(pageId, textId, true);
    return languageText || match;
  }

  private textHideComment(text: string): string {
    // Remove comments from the text
    const commentPattern = /\([^)]+\)/g;
    return text.replace(commentPattern, '').trim();
  }

  public replaceSimplePatternsByText(text: string): string {
    // Replace all simple {pageId,textId} patterns in the text with their language text
    const tPattern = /\{\s*(\d+)\s*,\s*(\d+)\s*\}/g;
    let result = text;
    while (tPattern.test(result)) {
      result = result.replace(tPattern, (match, pageId, textId) => this.textReplacer(match, pageId, textId));
    }
    return this.textHideComment(result);
  }

  public provideHover(document: vscode.TextDocument, position: vscode.Position, token?: vscode.CancellationToken): vscode.ProviderResult<vscode.Hover> {
    if (token?.isCancellationRequested) {
      return undefined;
    }
    const tPattern = /\{\s*(\d+)\s*,\s*(\d+)\s*\}|readtext\.\{\s*(\d+)\s*\}\.\{\s*(\d+)\s*\}|page="(\d+)"\s+line="(\d+)"/g;
    // matches:
    // {1015,7} or {1015, 7}
    // readtext.{1015}.{7}
    // page="1015" line="7"

    const range = document.getWordRangeAtPosition(position, tPattern);
    if (range) {
      if (token?.isCancellationRequested) {
        return undefined;
      }
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
          if (token?.isCancellationRequested) {
            return undefined;
          }
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
