import * as vscode from 'vscode';
import { HexParser } from './hexParser';

export class HexVirtualDocProvider implements vscode.TextDocumentContentProvider {
    private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this._onDidChange.event;

    provideTextDocumentContent(uri: vscode.Uri): string {
        const sourceUri = vscode.Uri.parse(uri.query);
        const document = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === sourceUri.toString());
        
        if (!document) {
            return '无法读取文件';
        }

        const blocks = HexParser.parse(document.getText());
        let result = '';

        for (let i = 0; i < blocks.length; i++) {
            const block = blocks[i];
            const startAddr = block.address;
            const endAddr = block.address + block.length - 1;
            result += `block${i} start 0x${startAddr.toString(16).padStart(8, '0').toUpperCase()} `;
            result += `end 0x${endAddr.toString(16).padStart(8, '0').toUpperCase()} `;
            result += `len ${block.length}\n`;
        }

        result += '\n';

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
                result += `0x${addr.toString(16).padStart(8, '0').toUpperCase()} : ${words.join(' ')}\n`;
                addr += 16;
            }
        }

        return result;
    }

    update(uri: vscode.Uri) {
        this._onDidChange.fire(uri);
    }
}
