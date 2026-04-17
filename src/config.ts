import * as vscode from "vscode";

export type LogLevel = "error" | "warn" | "info" | "debug";

export interface ProtoNavConfig {
  preferProtoDefinitions: boolean;
  maxIndexFiles: number;
  excludeGlobs: string[];
  focusFolder: string;
  logLevel: LogLevel;
}

export function readConfig(): ProtoNavConfig {
  const config = vscode.workspace.getConfiguration("protonav");

  const excludeCandidate = config.get<unknown>("excludeGlobs");
  const excludeGlobs = Array.isArray(excludeCandidate)
    ? excludeCandidate.filter((item): item is string => typeof item === "string")
    : [];

  const level = config.get<string>("logLevel", "warn");
  const logLevel: LogLevel =
    level === "error" || level === "warn" || level === "info" || level === "debug"
      ? level
      : "warn";

  return {
    preferProtoDefinitions: config.get<boolean>("preferProtoDefinitions", true),
    maxIndexFiles: Math.max(100, config.get<number>("maxIndexFiles", 20000)),
    excludeGlobs,
    focusFolder: (config.get<string>("focusFolder", "") || "").trim(),
    logLevel
  };
}
