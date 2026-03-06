import * as vscode from "vscode";
import { buildDocumentSymbols } from "./documentSymbols";
import { readConfig } from "./config";
import { ProtoNavLogger } from "./logging";
import { parseProto } from "./protoParser";
import { IndexedProtoSymbol, ProtoIndex } from "./protoIndex";

interface ProtoQuickPickItem extends vscode.QuickPickItem {
  entry: IndexedProtoSymbol;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const channel = vscode.window.createOutputChannel("ProtoNav");
  const initialConfig = readConfig();
  const logger = new ProtoNavLogger(channel, initialConfig.logLevel);
  const index = new ProtoIndex(initialConfig, logger);
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusItem.command = "protonav.rebuildIndex";
  statusItem.show();

  context.subscriptions.push(channel, index, statusItem);

  await index.initialize();
  renderStatus(statusItem, index.getStatus());

  context.subscriptions.push(
    index.onDidChangeStatus((status) => {
      renderStatus(statusItem, status);
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("protonav")) {
        return;
      }

      const nextConfig = readConfig();
      logger.setLevel(nextConfig.logLevel);
      void index.applyConfig(nextConfig);
    })
  );

  context.subscriptions.push(
    vscode.languages.registerWorkspaceSymbolProvider({
      provideWorkspaceSymbols: (query, _token) => {
        return index.searchSymbols(query).map((entry) => index.toSymbolInformation(entry));
      }
    })
  );

  context.subscriptions.push(
    vscode.languages.registerDocumentSymbolProvider({ language: "protobuf" }, {
      provideDocumentSymbols: (document, _token) => {
        const parsed = parseProto(document.uri.fsPath, document.getText());
        return buildDocumentSymbols(parsed);
      }
    })
  );

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider({ scheme: "file" }, {
      provideDefinition: (document, position, _token) => {
        if (!index.getConfig().preferProtoDefinitions) {
          return undefined;
        }

        const token = extractToken(document, position);
        if (!token) {
          return undefined;
        }

        const matches = index.findDefinitions(token, document.uri);
        if (matches.length === 0) {
          return undefined;
        }

        return matches.map((entry) => index.toLocation(entry));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("protonav.findProtoSymbol", async () => {
      await showProtoQuickPick(index);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("protonav.rebuildIndex", async () => {
      try {
        await index.rebuildNow();
        const status = index.getStatus();
        const details = `${status.indexedFiles} files, ${status.indexedSymbols} symbols`;
        void vscode.window.setStatusBarMessage(`ProtoNav rebuilt: ${details}`, 4000);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`ProtoNav rebuild failed: ${message}`);
      }
    })
  );
}

export function deactivate(): void {
  // no-op
}

function extractToken(document: vscode.TextDocument, position: vscode.Position): string | undefined {
  const range = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_.]*/);
  if (!range) {
    return undefined;
  }

  const token = document.getText(range).trim();
  return token.length > 0 ? token : undefined;
}

async function showProtoQuickPick(index: ProtoIndex): Promise<void> {
  const quickPick = vscode.window.createQuickPick<ProtoQuickPickItem>();
  quickPick.title = "ProtoNav: Find Proto Symbol";
  quickPick.placeholder = "Search by short name or fully-qualified proto symbol";
  quickPick.matchOnDescription = true;
  quickPick.matchOnDetail = true;

  const refresh = (value: string): void => {
    const items = index.searchSymbols(value, 200).map((entry) => ({
      label: entry.symbol.name,
      description: entry.symbol.fqName,
      detail: entry.uri.fsPath,
      entry
    }));

    quickPick.items = items;
  };

  const disposables: vscode.Disposable[] = [];

  disposables.push(
    quickPick.onDidChangeValue((value) => {
      refresh(value);
    })
  );

  disposables.push(
    quickPick.onDidAccept(() => {
      const selected = quickPick.selectedItems[0];
      if (!selected) {
        return;
      }

      quickPick.hide();
      void openEntry(selected.entry);
    })
  );

  disposables.push(
    quickPick.onDidHide(() => {
      quickPick.dispose();
      for (const disposable of disposables) {
        disposable.dispose();
      }
    })
  );

  refresh("");
  quickPick.show();
}

async function openEntry(entry: IndexedProtoSymbol): Promise<void> {
  const document = await vscode.workspace.openTextDocument(entry.uri);
  const editor = await vscode.window.showTextDocument(document, { preview: true });
  const range = new vscode.Range(
    entry.symbol.selectionRange.startLine,
    entry.symbol.selectionRange.startChar,
    entry.symbol.selectionRange.endLine,
    entry.symbol.selectionRange.endChar
  );

  editor.selection = new vscode.Selection(range.start, range.end);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
}

function renderStatus(item: vscode.StatusBarItem, status: ReturnType<ProtoIndex["getStatus"]>): void {
  if (status.isIndexing) {
    item.text = "$(sync~spin) ProtoNav indexing";
    item.tooltip = "ProtoNav is rebuilding the proto index.";
    return;
  }

  if (status.rootCount === 0) {
    item.text = "$(warning) ProtoNav no roots";
    item.tooltip = status.lastWarning || "No valid ProtoNav index roots. Check protonav.focusFolder.";
    return;
  }

  item.text = `$(symbol-namespace) ProtoNav ${status.indexedFiles}/${status.indexedSymbols}`;
  const warningLine = status.lastWarning ? `\nWarning: ${status.lastWarning}` : "";
  item.tooltip = `Proto files: ${status.indexedFiles}\nSymbols: ${status.indexedSymbols}\nRoots: ${status.rootCount}\nClick to rebuild.${warningLine}`;
}
