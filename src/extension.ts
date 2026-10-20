// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { HexReadonlyEditor } from './IntelHexViewer/hexReadonlyEditor';
import { registerWorkBuddyProviders } from './WorkBuddy/chatProvider';
import { registerCreditIndicator } from './WorkBuddy/creditsIndicator';
import { lastCredentialFailure, lastProbedPaths, resolveCredential } from './WorkBuddy/auth';
import { REGIONS, REGION_KEYS } from './WorkBuddy/protocol';

/**
 * 说明：CMake 相关工具（源码在 src/CmakeTools/ 与 templates/CMakeLists.cmake）
 * 目前不参与编译，也不会被打进 dist。之所以保留源码，是为了以后需要时能直接恢复：
 *   1. package.json 里重新贡献 test.genCMake 等命令
 *   2. tsconfig.json 的 exclude 去掉 "src/CmakeTools"
 *   3. 在 activate() 里重新 import 并注册 registerCMakeTools(context)
 * 依赖 glob / nunjucks / xml2js 仍保留在 package.json，未 import 时 webpack 不会打包。
 */

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "test" is now active!');

	// hex preview - 始终启用
	context.subscriptions.push(HexReadonlyEditor.register(context));

	// WorkBuddy 兼容层：注册成 Copilot Chat 的模型 provider
	registerWorkBuddy(context);
}

// This method is called when your extension is deactivated
export function deactivate() { }

/**
 * 注册 WorkBuddy 到 Copilot Chat 的模型选择器。
 *
 * 两个区域各注册一个 vendor（workbuddy / workbuddy-global），
 * 用户在 Copilot Chat 的模型下拉里就能看到 WorkBuddy 的模型。
 */
function registerWorkBuddy(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel('WorkBuddy');
	context.subscriptions.push(output);

	let registration: { providers: unknown[]; notifyConfigChanged: () => void };
	try {
		registration = registerWorkBuddyProviders(context, output);
	} catch (error) {
		// 老版本 VS Code 没有 lm.registerLanguageModelChatProvider，静默降级
		output.appendLine(`WorkBuddy 未注册: ${error}`);
		return;
	}

	// 用户改了相关工作区设置后刷新模型选择器
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('workbuddy')) {
				registration.notifyConfigChanged();
			}
		}),
	);

	// 诊断命令：看看 token 是从哪找到的
	context.subscriptions.push(
		vscode.commands.registerCommand('workbuddy.showStatus', async () => {
			let credential: Awaited<ReturnType<typeof resolveCredential>>;
			try {
				credential = await resolveCredential();
			} catch (error) {
				credential = undefined;
				output.appendLine(`[WorkBuddy] 读取凭据失败: ${error instanceof Error ? error.message : String(error)}`);
			}
			const lines: string[] = ['== WorkBuddy 诊断 =='];
			for (const key of REGION_KEYS) {
				lines.push(`区域 ${key}: ${REGIONS[key].label} → ${REGIONS[key].baseUrl}`);
				lines.push(`  vendor id: ${REGIONS[key].vendor}`);
			}
			if (credential) {
				lines.push(`凭据来源: ${credential.source}`);
				if (credential.filePath) {
					lines.push(`凭据文件: ${credential.filePath}`);
				}
				lines.push(`Token: ${credential.apiKey.slice(0, 4)}…${credential.apiKey.slice(-4)} (长度 ${credential.apiKey.length})`);
			} else {
				lines.push('凭据来源: 未找到');
				if (lastProbedPaths.length > 0) {
					lines.push('已探测:');
					lastProbedPaths.forEach(path => lines.push(`  ${path}`));
				}
				if (lastCredentialFailure?.message) {
					lines.push(`原因: ${lastCredentialFailure.message}`);
				}
				lines.push('  请先登录 WorkBuddy 桌面端，或设置环境变量 WORKBUDDY_API_KEY');
			}
			output.clear();
			lines.forEach(line => output.appendLine(line));
			output.show(true);
		}),
	);

	// 右下角的剩余额度指示器。查不到就保持隐藏，不影响对话。
	const indicator = registerCreditIndicator(context, { output });
	context.subscriptions.push({ dispose: () => indicator.dispose() });
}
