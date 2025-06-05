// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { parseTTS } from "./parse_cdk";
import { log } from 'console';

let myStatusBarItem: vscode.StatusBarItem;

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "test" is now active!');

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	let disposableParse = vscode.commands.registerCommand('test.parse', () => {
		// The code you place here will be executed every time your command is executed
		// Display a message box to the user
		let workspaceFolders = vscode.workspace.workspaceFolders;
		if (workspaceFolders) {
			let inf = workspaceFolders[0];
			vscode.window.showInformationMessage(`当前工作区目录是: ${inf.uri.fsPath}`);

		}
		parseTTS();
		// const mySetting = vscode.workspace.getConfiguration().get('test.demo_setting');
		// vscode.window.showInformationMessage('test.demo_setting : '+mySetting);
	});

	context.subscriptions.push(disposableParse);

	myStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	myStatusBarItem.text = "鱼塘建造中...";
	myStatusBarItem.command = "test.parse";
	context.subscriptions.push(myStatusBarItem);
	myStatusBarItem.show();
}

// This method is called when your extension is deactivated
export function deactivate() { }
