// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { parseTTS } from "./CmakeTools/parse_cdk";
import { generateCMakeFromConfig, writeCMakeFile } from "./CmakeTools/parse_workspace";
import { log } from 'console';
import { HexReadonlyEditor } from './IntelHexViewer/hexReadonlyEditor';

let myStatusBarItem: vscode.StatusBarItem;
let genCmakesBarItem: vscode.StatusBarItem;
let buildBarItem: vscode.StatusBarItem;
let rebuildBarItem: vscode.StatusBarItem;
let cmakeTerminal: vscode.Terminal | undefined;

function getCMakeTerminal(): vscode.Terminal {
	if (!cmakeTerminal || cmakeTerminal.exitStatus !== undefined) {
		cmakeTerminal = vscode.window.createTerminal('CMake');
	}
	return cmakeTerminal;
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "test" is now active!');

	// 监听终端关闭事件
	vscode.window.onDidCloseTerminal(terminal => {
		if (terminal === cmakeTerminal) {
			cmakeTerminal = undefined;
		}
	});

	vscode.commands.registerCommand('test.genCMake', async () => {
		try {
			const cmake = await generateCMakeFromConfig(context.extensionPath);
			await writeCMakeFile(cmake);
		} catch (error) {
			vscode.window.showErrorMessage(`生成CMake失败: ${error}`);
		}
	});

	vscode.commands.registerCommand('test.cmakeConfigure', async () => {
		const terminal = getCMakeTerminal();
		terminal.show();
		terminal.sendText('cmake -S . -B build -G "Ninja"');
	});

	vscode.commands.registerCommand('test.cmakeBuild', async () => {
		const terminal = getCMakeTerminal();
		terminal.show();
		terminal.sendText('cmake -S . -B build -G "Ninja" && cmake --build build -j12');
	});

	vscode.commands.registerCommand('test.cmakeRebuild', async () => {
		const terminal = getCMakeTerminal();
		terminal.show();
		terminal.sendText('cmake --build build --target clean && cmake -S . -B build -G "Ninja" && cmake --build build -j12');
	});

	genCmakesBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	genCmakesBarItem.text = "$(file-code) Gen CMake";
	genCmakesBarItem.command = "test.genCMake";
	genCmakesBarItem.tooltip = "生成CMakeLists.txt";
	context.subscriptions.push(genCmakesBarItem);
	genCmakesBarItem.show();

	buildBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
	buildBarItem.text = "$(tools) Build";
	buildBarItem.command = "test.cmakeBuild";
	buildBarItem.tooltip = "构建项目";
	context.subscriptions.push(buildBarItem);
	buildBarItem.show();

	rebuildBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
	rebuildBarItem.text = "$(refresh) Rebuild";
	rebuildBarItem.command = "test.cmakeRebuild";
	rebuildBarItem.tooltip = "重新配置并构建";
	context.subscriptions.push(rebuildBarItem);
	rebuildBarItem.show();

	// hex preview
	context.subscriptions.push(HexReadonlyEditor.register(context));
}

// This method is called when your extension is deactivated
export function deactivate() { }
