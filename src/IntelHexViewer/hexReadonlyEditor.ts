import * as vscode from 'vscode';
import { HexParser } from './hexParser';

export class HexReadonlyEditor implements vscode.CustomReadonlyEditorProvider {
    public static register(context: vscode.ExtensionContext): vscode.Disposable {
        return vscode.window.registerCustomEditorProvider(
            'hexViewer.preview',
            new HexReadonlyEditor(),
            { webviewOptions: { retainContextWhenHidden: true } }
        );
    }

    async openCustomDocument(uri: vscode.Uri): Promise<vscode.CustomDocument> {
        return { uri, dispose: () => {} };
    }

    async resolveCustomEditor(
        document: vscode.CustomDocument,
        webviewPanel: vscode.WebviewPanel
    ): Promise<void> {
        webviewPanel.webview.options = { enableScripts: false };
        
        const updateWebview = async () => {
            const content = await vscode.workspace.fs.readFile(document.uri);
            const text = Buffer.from(content).toString('utf8');
            const blocks = HexParser.parse(text);
            webviewPanel.webview.html = this.getHtml(blocks);
        };

        updateWebview();

        const watcher = vscode.workspace.createFileSystemWatcher(document.uri.fsPath);
        watcher.onDidChange(() => updateWebview());
        webviewPanel.onDidDispose(() => watcher.dispose());
    }

    private getHtml(blocks: any[]): string {
        let content = '';
        
        for (let i = 0; i < blocks.length; i++) {
            const block = blocks[i];
            const startAddr = block.address;
            const endAddr = block.address + block.length - 1;
            content += `block${i} start 0x${startAddr.toString(16).padStart(8, '0').toUpperCase()} `;
            content += `end 0x${endAddr.toString(16).padStart(8, '0').toUpperCase()} `;
            content += `len ${block.length}\n`;
        }
        content += '\n';

        for (const block of blocks) {
            let addr = block.address;
            for (let i = 0; i < block.data.length; i += 32) {
                const lineData = block.data.substr(i, 32);
                const words = [];
                for (let j = 0; j < lineData.length; j += 8) {
                    const word = lineData.substr(j, 8);
                    if (word.length === 8) {
                        words.push('0x' + word);
                    }
                }
                content += `0x${addr.toString(16).padStart(8, '0').toUpperCase()} : ${words.join(' ')}\n`;
                addr += 16;
            }
        }

        return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: var(--vscode-editor-font-family, 'Consolas', 'Courier New', monospace);
            font-size: var(--vscode-editor-font-size, 14px);
            font-weight: var(--vscode-editor-font-weight, normal);
            line-height: var(--vscode-editor-line-height, 1.6);
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            padding: 0;
        }
        pre {
            margin: 0;
            padding: 20px;
            white-space: pre;
            font-family: inherit;
            font-size: inherit;
            line-height: inherit;
            tab-size: 4;
        }
    </style>
</head>
<body>
    <pre>${this.escapeHtml(content)}</pre>
</body>
</html>`;
    }

    private escapeHtml(text: string): string {
        return text.replace(/[&<>"']/g, (m) => {
            switch (m) {
                case '&': return '&amp;';
                case '<': return '&lt;';
                case '>': return '&gt;';
                case '"': return '&quot;';
                case "'": return '&#039;';
                default: return m;
            }
        });
    }
}
