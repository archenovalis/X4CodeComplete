/**
 * X4CodeComplete Extension Configuration
 *
 * This module provides centralized configuration management for the X4CodeComplete extension.
 * It includes type definitions, validation, and utility functions for handling extension settings.
 */

import * as vscode from 'vscode';
import * as path from 'path';
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
  /** Force completion suggestions */
  forcedCompletion: boolean;
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

  constructor(callbacks?: ConfigChangeCallbacks) {
    this._config = this.createDefaultConfig();
    this._changeCallbacks = callbacks || {};

    // Load initial configuration
    this.loadConfiguration();
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
      forcedCompletion: false,
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
      forcedCompletion: pick('forcedCompletion', false),
      languageNumber: pick('languageNumber', '44'),
      limitLanguageOutput: pick('limitLanguageOutput', false),
      reloadLanguageData: pick('reloadLanguageData', false),
    };
  }

  /**
   * Returns true if a specific configuration item has changed compared to the provided previous snapshot.
   * Usage: hasConfigItemChanged(previousConfig, 'debug')
   * Only two parameters are required because the current value is taken from this._config.
   */
  public hasConfigItemChanged(prev: X4CodeCompleteConfig, key: keyof X4CodeCompleteConfig): boolean {
    return prev[key] !== this._config[key];
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
    if (!event.affectsConfiguration(CONFIG_SECTION)) {
      return;
    }

    logger.info('Configuration changed. Reloading settings...');

    // Store previous state
    const previousConfig = { ...this._config };

    // Load new configuration
    this.loadConfiguration();

    // Handle debug setting changes
    if (this.hasConfigItemChanged(previousConfig, 'debug')) {
      if (this._changeCallbacks.onDebugChanged) {
        this._changeCallbacks.onDebugChanged(this._config.debug);
      }
    }

    // Check if language files need to be reloaded
    const shouldReloadLanguageFiles =
      this.hasConfigItemChanged(previousConfig, 'unpackedFileLocation') ||
      this.hasConfigItemChanged(previousConfig, 'extensionsFolder') ||
      this.hasConfigItemChanged(previousConfig, 'languageNumber') ||
      this.hasConfigItemChanged(previousConfig, 'limitLanguageOutput') ||
      this.hasConfigItemChanged(previousConfig, 'reloadLanguageData');

    if (shouldReloadLanguageFiles) {
      if (!this.hasConfigItemChanged(previousConfig, 'reloadLanguageData') || this._config.reloadLanguageData) {
        if (this._changeCallbacks.onLanguageFilesReload) {
          try {
            await this._changeCallbacks.onLanguageFilesReload(this._config);
          } catch (error) {
            logger.error('Failed to reload language files:', error);
          }
        }
      }

      // Reset the reloadLanguageData flag to false after processing
      if (this.hasConfigItemChanged(previousConfig, 'reloadLanguageData')) {
        try {
          await this.resetReloadLanguageDataFlag();
        } catch (error) {
          logger.error('Failed to reset reload flag (internal helper):', error);
        }
      }
    }

    if (this.hasConfigItemChanged(previousConfig, 'unpackedFileLocation')) {
      if (this._changeCallbacks.onUnpackedFileLocationChanged) {
        this._changeCallbacks.onUnpackedFileLocationChanged(this._config);
      }
    }
  }

  /**
   * Resets a boolean flag to false in the most specific scope where it is currently set.
   * Priority order:
   * 1. Any workspace folder(s) where the value is true
   * 2. Workspace
   * 3. Global (user)
   * If no scope has an explicit true (already false / undefined everywhere), nothing is written.
   */
  private async resetFlagInOriginalScope(key: keyof X4CodeCompleteConfig): Promise<void> {
    const section = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const inspected = section.inspect<boolean>(key as string);
    if (!inspected) return;

    const updates: Array<Promise<void>> = [];

    // 1. Workspace folder level: need to inspect each folder separately
    // Ignored

    // 2. Workspace level
    if (inspected.workspaceValue === true) {
      await section.update(key, false, vscode.ConfigurationTarget.Workspace);
      return;
    }

    // 3. Global level
    if (inspected.globalValue === true) {
      await section.update(key, false, vscode.ConfigurationTarget.Global);
      return;
    }
    // Nothing explicitly set to true; nothing to do
  }

  /** Convenience wrapper specifically for reloadLanguageData flag */
  public async resetReloadLanguageDataFlag(): Promise<void> {
    await this.resetFlagInOriginalScope('reloadLanguageData');
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
  public async setConfigValue<T>(
    key: keyof X4CodeCompleteConfig,
    value: T,
    target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Global
  ): Promise<void> {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    await config.update(key, value, target);
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
