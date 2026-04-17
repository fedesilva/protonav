import * as vscode from "vscode";
import { LogLevel } from "./config";

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
};

export class ProtoNavLogger {
  private level: LogLevel;

  constructor(private readonly channel: vscode.OutputChannel, level: LogLevel) {
    this.level = level;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  error(message: string): void {
    this.log("error", message);
  }

  warn(message: string): void {
    this.log("warn", message);
  }

  info(message: string): void {
    this.log("info", message);
  }

  debug(message: string): void {
    this.log("debug", message);
  }

  private log(level: LogLevel, message: string): void {
    if (LOG_LEVEL_ORDER[level] > LOG_LEVEL_ORDER[this.level]) {
      return;
    }

    const timestamp = new Date().toISOString();
    this.channel.appendLine(`[${timestamp}] [${level.toUpperCase()}] ${message}`);
  }
}
