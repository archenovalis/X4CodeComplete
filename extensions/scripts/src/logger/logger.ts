import * as vscode from 'vscode';
import * as winston from 'winston';
import { OutputChannelTransport, LogOutputChannelTransport } from 'winston-transport-vscode';

const { combine, timestamp, prettyPrint, simple } = winston.format;

const outputChannel = vscode.window.createOutputChannel('X4CodeComplete', {
  log: true,
});
declare global {
  var logger: winston.Logger;
}
if (!global.logger) {
  global.logger = winston.createLogger({
    level: 'info',
    levels: LogOutputChannelTransport.config.levels,
    format: LogOutputChannelTransport.format(),
    transports: [new LogOutputChannelTransport({ outputChannel })],
  });
}
export const logger = global.logger;
export function setLoggerLevel(level: string) {
  logger.level = level;
  logger.transports.forEach((transport) => {
    if (transport instanceof OutputChannelTransport) {
      transport.level = level;
    }
  });
}