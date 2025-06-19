import * as vscode from 'vscode';
import * as winston from 'winston';
import { OutputChannelTransport, LogOutputChannelTransport } from 'winston-transport-vscode';

const { combine, timestamp, prettyPrint, simple } = winston.format;

const outputChannel = vscode.window.createOutputChannel('X4CodeComplete', {
  log: true,
});

export const logger = winston.createLogger({
  level: 'trace',
  levels: LogOutputChannelTransport.config.levels,
  format: LogOutputChannelTransport.format(),
  transports: [new LogOutputChannelTransport({ outputChannel })],
});
