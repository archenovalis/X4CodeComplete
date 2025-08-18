/**
 * X4CodeComplete Extension Configuration
 *
 * This module provides centralized configuration management for the X4CodeComplete extension.
 * It includes type definitions, validation, and utility functions for handling extension settings.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { logger } from '../logger/logger';

// ================================================================================================
// CONFIGURATION TYPE DEFINITIONS
// ================================================================================================

/** Extension configuration interface */
export interface X4CodeCompleteConfig {
  /** Path to unpacked X4 game files */
  unpackedFileLocation: string;
  /** Path to extensions folder */
  extensionsFolder: string;
  /** Enable debug logging */
  debug: boolean;
  /** Language number for language files (default: '44' for English) */
  languageNumber: string;
  /** Limit language output to prevent performance issues */
  limitLanguageOutput: boolean;
  /** Flag to trigger reloading of language data */
  reloadLanguageData: boolean;
}

// ================================================================================================
// CONFIGURATION CONSTANTS
// ================================================================================================

/** Configuration section name in VS Code settings */
export const CONFIG_SECTION = 'x4CodeComplete';

/** Required settings that must be configured for the extension to work */
export const REQUIRED_SETTINGS = ['unpackedFileLocation', 'extensionsFolder'] as const;

/** Extension name constant */
export const EXTENSION_NAME = 'X4CodeComplete';

// ================================================================================================
// CONFIGURATION CHANGE CALLBACKS
// ================================================================================================

/**
 * Configuration change callbacks interface
 * These callbacks are executed when specific configuration changes occur
 */
export interface ConfigChangeCallbacks {
  /** Called when debug setting changes */
  onDebugChanged?: (isDebugEnabled: boolean) => void;
  /** Called when language files need to be reloaded */
  onLanguageFilesReload?: (config: X4CodeCompleteConfig) => Promise<void>;
  /** Called when unpacked file location changes */
  onUnpackedFileLocationChanged?: (config: X4CodeCompleteConfig) => Promise<void>;
}

// ================================================================================================
// CONFIGURATION CLASS
// ================================================================================================

/**
 * X4CodeComplete Configuration Manager
 * Provides centralized configuration management with state tracking and change handling
 */
export class X4ConfigurationManager {
  private _config: X4CodeCompleteConfig;
  private _changeCallbacks: ConfigChangeCallbacks;
  private _disposables: vscode.Disposable[] = [];

  constructor() {
    this._config = this.createDefaultConfig();

    // Load initial configuration
    this.loadConfiguration();
  }

  public setCallbacks(callbacks: ConfigChangeCallbacks): void {
    this._changeCallbacks = callbacks;
  }

  /**
   * Gets the current configuration
   */
  get config(): X4CodeCompleteConfig {
    return { ...this._config };
  }

  /**
   * Gets the libraries path from current configuration
   */
  get librariesPath(): string {
    return path.join(this._config.unpackedFileLocation, 'libraries');
  }

  /**
   * Creates a default configuration object
   */
  private createDefaultConfig(): X4CodeCompleteConfig {
    return {
      unpackedFileLocation: '',
      extensionsFolder: '',
      debug: false,
      languageNumber: '44',
      limitLanguageOutput: false,
      reloadLanguageData: false,
    };
  }

  /**
   * Loads configuration from VS Code settings
   */
  private loadConfiguration(): void {
    const section = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const pick = <T>(key: keyof X4CodeCompleteConfig, fallback: T) => {
      const inspected = section.inspect<T>(key as string);
      if (!inspected) return fallback;
      // Ignore workspaceFolderValue intentionally – only honor workspace and global scopes
      if (inspected.workspaceValue !== undefined) return inspected.workspaceValue as T;
      if (inspected.globalValue !== undefined) return inspected.globalValue as T;
      return (inspected.defaultValue as T) ?? fallback;
    };

    this._config = {
      unpackedFileLocation: pick('unpackedFileLocation', ''),
      extensionsFolder: pick('extensionsFolder', ''),
      debug: pick('debug', false),
      languageNumber: pick('languageNumber', '44'),
      limitLanguageOutput: pick('limitLanguageOutput', false),
      reloadLanguageData: false,
    };
  }

  /**
   * Computes configuration values (same resolution logic as loadConfiguration) and returns ONLY the
   * fields whose resolved value differs from the current in-memory this._config. Folder-scope
   * (workspaceFolderValue) differences are ignored. Each returned entry contains:
   * { value: <newValue>, scope: 'workspace' | 'global' | 'default' }
   * Note: property name 'value' matches user request.
   */
  public getConfiguration(): Partial<{
    [K in keyof X4CodeCompleteConfig]: { value: X4CodeCompleteConfig[K]; scope: vscode.ConfigurationTarget | undefined };
  }> {
    const section = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const result: Partial<{
      [K in keyof X4CodeCompleteConfig]: { value: X4CodeCompleteConfig[K]; scope: vscode.ConfigurationTarget | undefined };
    }> = {};

    const keys: (keyof X4CodeCompleteConfig)[] = Object.keys(this._config) as (keyof X4CodeCompleteConfig)[];

    for (const key of keys) {
      const inspected = section.inspect<any>(key as string);
      if (!inspected) continue;
      // Resolve value ignoring folder scope (same precedence as loadConfiguration)
      let value: any;
      let scope: vscode.ConfigurationTarget | undefined;
      if (inspected.workspaceValue !== undefined) {
        value = inspected.workspaceValue;
        scope = vscode.ConfigurationTarget.Workspace;
      } else if (inspected.globalValue !== undefined) {
        value = inspected.globalValue;
        scope = vscode.ConfigurationTarget.Global;
      } else {
        value = inspected.defaultValue;
        scope = undefined;
      }

      if (this._config[key] !== value) {
        (result as any)[key] = { value: value, scope: scope };
      }
    }
    return result;
  }

  /**
   * Validates that all required extension settings are configured
   */
  public validateSettings(): boolean {
    let isValid = true;
    REQUIRED_SETTINGS.forEach((setting) => {
      if (!this._config[setting]) {
        vscode.window.showErrorMessage(`Missing required setting: ${setting}. Please update your VSCode settings.`);
        isValid = false;
      }
    });
    return isValid;
  }

  /**
   * Handles configuration changes and executes appropriate callbacks
   */
  public async handleConfigurationChange(event: vscode.ConfigurationChangeEvent): Promise<void> {
    const section = vscode.workspace.getConfiguration(CONFIG_SECTION);
    if (!event.affectsConfiguration(CONFIG_SECTION)) {
      return;
    }

    logger.info('Configuration changed. Reloading settings...');

    // Store previous state
    const previousConfig = { ...this._config };

    const configurationChanged = this.getConfiguration();
    // Collect changed keys as an array and apply them to in-memory config
    const changedKeys = Object.keys(configurationChanged) as (keyof X4CodeCompleteConfig)[];
    // Load new configuration
    // this.loadConfiguration();

    // Handle debug setting changes
    if (changedKeys.includes('debug')) {
      if (this._changeCallbacks.onDebugChanged) {
        this._config.debug = configurationChanged.debug?.value ?? false;
        this._changeCallbacks.onDebugChanged(this._config.debug);
      }
    }

    // Check if language files need to be reloaded

    const languageRelatedChanges = ['languageNumber', 'limitLanguageOutput', 'reloadLanguageData'].filter((x) =>
      changedKeys.includes(x as keyof X4CodeCompleteConfig)
    );

    if (languageRelatedChanges.length > 0) {
      ['languageNumber', 'limitLanguageOutput']
        .filter((x) => changedKeys.includes(x as keyof X4CodeCompleteConfig))
        .forEach((key) => {
          this._config[key] = configurationChanged[key]?.value ?? this._config[key];
        });
      if (configurationChanged.reloadLanguageData?.value) {
        await this.setConfigValue('reloadLanguageData', false, configurationChanged.reloadLanguageData.scope);
      }
      if (!changedKeys.includes('reloadLanguageData') || configurationChanged.reloadLanguageData.value) {
        if (this._changeCallbacks.onLanguageFilesReload) {
          try {
            await this._changeCallbacks.onLanguageFilesReload(this._config);
          } catch (error) {
            logger.error('Failed to reload language files:', error);
          }
        }
      }
    }

    if (
      ['unpackedFileLocation', 'extensionsFolder'].filter(
        (x) => changedKeys.includes(x as keyof X4CodeCompleteConfig) && configurationChanged[x]?.scope !== undefined
      ).length > 0
    ) {
      await this.promptToSetFolder(configurationChanged);
    }
  }

  /** Prompts user to select a folder if a path key changed manually (not by programmatic update) */
  private async promptToSetFolder(
    config: Partial<{
      [K in keyof X4CodeCompleteConfig]: { value: X4CodeCompleteConfig[K]; scope: vscode.ConfigurationTarget | undefined };
    }>
  ): Promise<void> {
    // Only handle path keys where values are strings.
    const isPathKey = (k: keyof X4CodeCompleteConfig): k is 'unpackedFileLocation' | 'extensionsFolder' =>
      k === 'unpackedFileLocation' || k === 'extensionsFolder';

    const keys = Object.keys(config) as Array<keyof X4CodeCompleteConfig>;
    const key = keys.find(isPathKey);
    if (!key) {
      return; // No relevant key to handle
    }

    // If the new value seems valid (existing directory), skip prompting to avoid annoyance.
    let folder = this._config[key] || '';
    do {
      if (folder && fs.existsSync(folder) && fs.statSync(folder).isDirectory()) {
        break; // Valid folder found
      }
      try {
        folder = path.dirname(folder); // Move up one level
      } catch {
        folder = ''; // If dirname fails, fallback to empty string
      }
    } while (folder);

    const niceName = key === 'unpackedFileLocation' ? 'Unpacked Game Files Folder' : 'Extensions Folder';
    const selection = await vscode.window.showOpenDialog({
      defaultUri: folder ? vscode.Uri.file(folder) : undefined,
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: `Select ${niceName}`,
      title: `Select ${niceName}`,
    });
    const isFolderSelected = selection && selection.length > 0;
    if (isFolderSelected) {
      this._config[key] = selection[0].fsPath;
    }
    await this.syncToConfigValue(key, config[key]?.scope ?? vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('workbench.action.openSettings', 'x4codecomplete');
    if (isFolderSelected) {
      if (key === 'extensionsFolder' && this._changeCallbacks.onLanguageFilesReload) {
        await this._changeCallbacks.onLanguageFilesReload(this._config);
      } else if (key === 'unpackedFileLocation' && this._changeCallbacks.onUnpackedFileLocationChanged) {
        await this._changeCallbacks.onUnpackedFileLocationChanged(this._config);
      }
    }
  }

  /**
   * Registers configuration change listener
   */
  public registerConfigurationChangeListener(): vscode.Disposable {
    const disposable = vscode.workspace.onDidChangeConfiguration(async (event) => {
      await this.handleConfigurationChange(event);
    });
    this._disposables.push(disposable);
    return disposable;
  }

  /**
   * Sets a configuration value
   */
  public async setConfigValue<K extends keyof X4CodeCompleteConfig>(
    key: K,
    value: X4CodeCompleteConfig[K],
    target?: vscode.ConfigurationTarget
  ): Promise<void> {
    this._config[key] = value;
    if (target) {
      await this.syncToConfigValue(key, target);
    }
  }

  public async syncToConfigValue(key: keyof X4CodeCompleteConfig, target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Global): Promise<void> {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    await config.update(key, this._config[key], target);
  }

  /**
   * Gets a specific configuration value
   */
  public getConfigValue<T>(key: keyof X4CodeCompleteConfig): T | undefined {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    return config.get<T>(key);
  }

  /**
   * Gets configuration validation status
   */
  public getConfigurationStatus(): { isValid: boolean; missingSettings: string[] } {
    const missingSettings: string[] = [];

    REQUIRED_SETTINGS.forEach((setting) => {
      if (!this._config[setting]) {
        missingSettings.push(setting);
      }
    });

    return {
      isValid: missingSettings.length === 0,
      missingSettings,
    };
  }

  /**
   * Disposes of all resources
   */
  public dispose(): void {
    this._disposables.forEach((disposable) => disposable.dispose());
    this._disposables = [];
  }
}

export const configManager: X4ConfigurationManager = new X4ConfigurationManager();
