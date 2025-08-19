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
  onLanguageFilesNeedToBeReload?: () => Promise<void>;
  /** Called when reloadLanguageData flag needs to be reset */
  onExternalDefinitionsNeedToBeReloaded?: () => Promise<void>;
  /** Called when unpacked file location changes */
  onUnpackedFileLocationChanged?: () => Promise<void>;
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
  /**
   * Tracks the last known scope that provided each config key's value.
   * Used to infer scope when a user reverts a value back to default (e.g., false),
   * which makes inspect().workspaceValue/globalValue become undefined.
   */
  private _lastKnownScopes: Partial<Record<keyof X4CodeCompleteConfig, vscode.ConfigurationTarget | undefined>> = {};

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
    this.getConfiguration(section, true);
    logger.debug('Loaded configuration:', this._config);
  }

  /**
   * Resolves a configuration value with correct typing and scope, ignoring workspaceFolder scope.
   */
  private resolveConfigValue<K extends keyof X4CodeCompleteConfig>(
    section: vscode.WorkspaceConfiguration,
    key: K,
    fallback?: X4CodeCompleteConfig[K],
    update: boolean = false,
    exactScope: vscode.ConfigurationTarget | undefined = undefined
  ): { value: X4CodeCompleteConfig[K]; scope: vscode.ConfigurationTarget | undefined } {
    // Type parameter is inferred from key via indexed access type
    const inspected = section.inspect<X4CodeCompleteConfig[K]>(key as string);
    if (!inspected) return { value: (fallback as X4CodeCompleteConfig[K])!, scope: undefined };

    let result: { value: X4CodeCompleteConfig[K]; scope: vscode.ConfigurationTarget | undefined };
    if (inspected.workspaceValue !== undefined && (exactScope === undefined || exactScope === vscode.ConfigurationTarget.Workspace))
      result = { value: inspected.workspaceValue as X4CodeCompleteConfig[K], scope: vscode.ConfigurationTarget.Workspace };
    else if (inspected.globalValue !== undefined && (exactScope === undefined || exactScope === vscode.ConfigurationTarget.Global))
      result = { value: inspected.globalValue as X4CodeCompleteConfig[K], scope: vscode.ConfigurationTarget.Global };
    else result = { value: (inspected.defaultValue as X4CodeCompleteConfig[K]) ?? (fallback as X4CodeCompleteConfig[K])!, scope: undefined };

    if (update && result.scope !== undefined && this._config[key] !== result.value) {
      this._config[key] = result.value;
    }

    return result;
  }

  /**
   * Computes configuration values (same resolution logic as loadConfiguration) and returns ONLY the
   * fields whose resolved value differs from the current in-memory this._config. Folder-scope
   * (workspaceFolderValue) differences are ignored. Each returned entry contains:
   * { value: <newValue>, scope: 'workspace' | 'global' | 'default' }
   * Note: property name 'value' matches user request.
   */
  public getConfiguration(
    section?: vscode.WorkspaceConfiguration,
    update: boolean = false
  ): Partial<{
    [K in keyof X4CodeCompleteConfig]: { value: X4CodeCompleteConfig[K]; scope: vscode.ConfigurationTarget | undefined };
  }> {
    section = section ?? vscode.workspace.getConfiguration(CONFIG_SECTION);
    const result: Partial<{
      [K in keyof X4CodeCompleteConfig]: { value: X4CodeCompleteConfig[K]; scope: vscode.ConfigurationTarget | undefined };
    }> = {};

    const keys: (keyof X4CodeCompleteConfig)[] = Object.keys(this._config) as (keyof X4CodeCompleteConfig)[];

    for (const key of keys) {
      const previousValue = this._config[key];
      const { value, scope } = this.resolveConfigValue(section, key, this._config[key], update);

      if (previousValue !== value && scope !== undefined) {
        (result as any)[key] = { value, scope };
        if ((key === 'debug' || key === 'limitLanguageOutput') && value && scope === vscode.ConfigurationTarget.Global) {
          section.update(key, value, scope);
        }
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

    logger.debug('Configuration changed. Processing changes...');

    const configurationChanged = this.getConfiguration(section);
    // Collect changed keys as an array and apply them to in-memory config
    const changedKeys = Object.keys(configurationChanged) as (keyof X4CodeCompleteConfig)[];

    if (changedKeys.length === 0) {
      // No relevant configuration changes detected
      return;
    }

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
      if (configurationChanged.reloadLanguageData.value) {
        await section.update('reloadLanguageData', false, configurationChanged.reloadLanguageData.scope);
      }
      if (!changedKeys.includes('reloadLanguageData') || configurationChanged.reloadLanguageData.value) {
        if (this._changeCallbacks.onLanguageFilesNeedToBeReload) {
          try {
            await this._changeCallbacks.onLanguageFilesNeedToBeReload();
          } catch (error) {
            logger.error('Failed to reload language files:', error);
          }
        }
      }
    }

    if (['unpackedFileLocation', 'extensionsFolder'].filter((x) => changedKeys.includes(x as keyof X4CodeCompleteConfig)).length > 0) {
      await this.promptToSetFolder(section, configurationChanged);
    }
  }

  /** Prompts user to select a folder if a path key changed manually (not by programmatic update) */
  private async promptToSetFolder(
    section: vscode.WorkspaceConfiguration,
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
    let isFolderSelected = false;
    if (config[key]?.scope === vscode.ConfigurationTarget.Workspace && config[key]?.value === '') {
      // Prompt user to set folder if changed manually
      const value = this.resolveConfigValue(section, key, config[key]?.value, false, vscode.ConfigurationTarget.Global).value;
      if (value && this._config[key] !== value) {
        this._config[key] = value;
        section.update(key, undefined, vscode.ConfigurationTarget.Workspace);
        isFolderSelected = true;
      }
    } else {
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
      isFolderSelected = selection && selection.length > 0;
      if (isFolderSelected) {
        this._config[key] = selection[0].fsPath;
      }
      await this.syncToConfigValue(key, config[key]?.scope ?? vscode.ConfigurationTarget.Global);
    }
    if (isFolderSelected) {
      if (key === 'extensionsFolder' && this._changeCallbacks.onLanguageFilesNeedToBeReload) {
        this._changeCallbacks.onLanguageFilesNeedToBeReload();
        this._changeCallbacks.onExternalDefinitionsNeedToBeReloaded();
      } else if (key === 'unpackedFileLocation' && this._changeCallbacks.onUnpackedFileLocationChanged) {
        this._changeCallbacks.onUnpackedFileLocationChanged();
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
      // Update last-known scope when we explicitly set a value
      this._lastKnownScopes[key] = target;
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
