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
  /** Called when reloadLanguageData flag needs to be reset */
  onResetReloadFlag?: () => Promise<void>;
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
      reloadLanguageData: false
    };
  }

  /**
   * Loads configuration from VS Code settings
   */
  private loadConfiguration(): void {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    this._config = {
      unpackedFileLocation: config.get('unpackedFileLocation') || '',
      extensionsFolder: config.get('extensionsFolder') || '',
      debug: config.get('debug') || false,
      forcedCompletion: config.get('forcedCompletion') || false,
      languageNumber: config.get('languageNumber') || '44',
      limitLanguageOutput: config.get('limitLanguageOutput') || false,
      reloadLanguageData: config.get('reloadLanguageData') || false
    };
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
   * Checks if configuration setting affects language file loading
   */
  public static affectsLanguageFiles(settingName: string): boolean {
    const languageFileSettings = [
      'x4CodeComplete.unpackedFileLocation',
      'x4CodeComplete.extensionsFolder',
      'x4CodeComplete.languageNumber',
      'x4CodeComplete.limitLanguageOutput',
      'x4CodeComplete.reloadLanguageData'
    ];
    return languageFileSettings.includes(settingName);
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
    if (this._config.debug !== previousConfig.debug) {
      if (this._changeCallbacks.onDebugChanged) {
        this._changeCallbacks.onDebugChanged(this._config.debug);
      }
    }

    // Check if language files need to be reloaded
    const shouldReloadLanguageFiles =
      event.affectsConfiguration(`${CONFIG_SECTION}.unpackedFileLocation`) ||
      event.affectsConfiguration(`${CONFIG_SECTION}.extensionsFolder`) ||
      event.affectsConfiguration(`${CONFIG_SECTION}.languageNumber`) ||
      event.affectsConfiguration(`${CONFIG_SECTION}.limitLanguageOutput`) ||
      event.affectsConfiguration(`${CONFIG_SECTION}.reloadLanguageData`);

    if (shouldReloadLanguageFiles) {
      if (this._changeCallbacks.onLanguageFilesReload) {
        try {
          await this._changeCallbacks.onLanguageFilesReload(this._config);
        } catch (error) {
          logger.error('Failed to reload language files:', error);
        }
      }

      // Reset the reloadLanguageData flag to false after processing
      if (event.affectsConfiguration(`${CONFIG_SECTION}.reloadLanguageData`)) {
        if (this._changeCallbacks.onResetReloadFlag) {
          try {
            await this._changeCallbacks.onResetReloadFlag();
          } catch (error) {
            logger.error('Failed to reset reload flag:', error);
          }
        }
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
      missingSettings
    };
  }

  /**
   * Disposes of all resources
   */
  public dispose(): void {
    this._disposables.forEach(disposable => disposable.dispose());
    this._disposables = [];
  }
}

