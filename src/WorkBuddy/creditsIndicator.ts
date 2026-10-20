/**
 * 右下角的 WorkBuddy 剩余额度指示器。
 *
 * 只做一件事：定时查一次额度，查到了就显示"WorkBuddy 2,205.5"，查不到就
 * 静默隐藏状态栏项 —— 额度接口不可用不该影响对话，也不该弹错误提示。
 *
 * 点击状态栏项会弹出明细：每个仍在生效的额度包、3 天内会过期的部分、最近一次
 * 过期时间、最近一次的刷新时间。查不到时点击会重新拉一次。
 *
 * 失败原因只写进 `WorkBuddy` 输出面板，不打扰用户。
 */

import * as vscode from 'vscode';
import { resolveCredential, lastCredentialFailure, lastProbedPaths } from './auth';
import { fetchCredits, formatCredits, WorkBuddyCredits } from './credits';

/** 定时刷新间隔。额度变化很慢，30 分钟足够，也不会给计费接口添麻烦。 */
const REFRESH_INTERVAL_MS = 30 * 60 * 1000;

/** 启动后稍等再拉，别和首次注册模型撞在一起。 */
const FIRST_DELAY_MS = 3_000;

export interface CreditIndicatorOptions {
	output: vscode.OutputChannel;
}

export interface CreditIndicator {
	dispose(): void;
}

function formatWhen(ms: number): string {
	const date = new Date(ms);
	const pad = (value: number): string => String(value).padStart(2, '0');
	return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function describe(credits: WorkBuddyCredits): string {
	const lines: string[] = [];
	lines.push(`剩余额度：${formatCredits(credits.total)}`);
	if (credits.expiringSoon > 0) {
		lines.push(`其中 3 天内会过期：${formatCredits(credits.expiringSoon)}`);
	}
	if (credits.nearestExpiryMs !== undefined) {
		lines.push(`最近一次过期：${formatWhen(credits.nearestExpiryMs)}`);
	}
	lines.push('');
	const monthly = credits.packages.filter(p => p.monthly);
	const gifts = credits.packages.filter(p => !p.monthly);
	if (monthly.length > 0) {
		lines.push('周期额度：');
		for (const pkg of monthly) {
			const refresh = pkg.refreshAtMs === undefined ? '' : `，${formatWhen(pkg.refreshAtMs)} 刷新`;
			const size = pkg.size > 0 ? ` / ${formatCredits(pkg.size)}` : '';
			lines.push(`  ${pkg.packageName}：${formatCredits(pkg.remain)}${size}${refresh}`);
		}
	}
	if (gifts.length > 0) {
		lines.push('赠送额度：');
		for (const pkg of gifts) {
			const expire = pkg.expiresAtMs === undefined ? '' : `，${formatWhen(pkg.expiresAtMs)} 过期`;
			lines.push(`  ${pkg.packageName}：${formatCredits(pkg.remain)}${expire}`);
		}
	}
	if (credits.packages.length === 0) {
		lines.push('（没有仍在生效的额度包）');
	}
	return lines.join('\n');
}

export function registerCreditIndicator(
	context: vscode.ExtensionContext,
	options: CreditIndicatorOptions,
): CreditIndicator {
	const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
	item.name = 'WorkBuddy 额度';
	item.command = 'workbuddy.showCredits';
	item.hide();
	context.subscriptions.push(item);

	let latest: WorkBuddyCredits | undefined;
	let inflight: Promise<void> | undefined;
	let disposed = false;

	const refresh = (): Promise<void> => {
		// 单飞：定时器和点击可能同时触发。
		if (inflight !== undefined) {
			return inflight;
		}
		inflight = (async () => {
			try {
				if (disposed) {
					return;
				}
				const credential = await resolveCredential();
				if (credential === undefined) {
					// 没有账号：状态栏保持隐藏，这也是一种正常的"静默"。
					latest = undefined;
					item.hide();
					options.output.appendLine(
						`[credits] 跳过：没有凭据${lastCredentialFailure?.message ? `（${lastCredentialFailure.message}）` : ''}`,
					);
					return;
				}
				const credits = await fetchCredits(credential);
				if (disposed) {
					return;
				}
				latest = credits;
				const soon = credits.expiringSoon > 0 ? ` · ${formatCredits(credits.expiringSoon)} 将过期` : '';
				item.text = `$(symbol-numeric) WorkBuddy ${formatCredits(credits.total)}${soon}`;
				item.tooltip = `WorkBuddy 剩余额度\n\n${describe(credits)}`;
				item.show();
				options.output.appendLine(
					`[credits] ${credential.nickname ?? credential.uin ?? '账号'}：${formatCredits(credits.total)}（${credits.packages.length} 个套餐）`,
				);
			} catch (error) {
				// 静默策略：不弹窗、不显示错误，只写日志，状态栏维持原样（有旧值就继续显示旧值）。
				options.output.appendLine(
					`[credits] 查询失败，已忽略: ${error instanceof Error ? error.message : String(error)}`,
				);
				if (latest === undefined) {
					item.hide();
				}
			} finally {
				inflight = undefined;
			}
		})();
		return inflight;
	};

	const showDetail = async (): Promise<void> => {
		if (latest === undefined) {
			// 之前没查到，点一下重试。
			await refresh();
		}
		if (latest === undefined) {
			const probed = lastProbedPaths.length > 0 ? `\n已探测: ${lastProbedPaths.join(', ')}` : '';
			void vscode.window.showWarningMessage(
				`查不到 WorkBuddy 额度。请确认已登录 WorkBuddy 桌面端，且账号有可用额度。${probed}`,
			);
			return;
		}
		const choice = await vscode.window.showInformationMessage(
			describe(latest),
			{ modal: true, detail: '数据来自 WorkBuddy 计费接口，点击状态栏可随时刷新。' },
			'重新查询',
		);
		if (choice === '重新查询') {
			await refresh();
			await showDetail();
		}
	};

	context.subscriptions.push(vscode.commands.registerCommand('workbuddy.showCredits', showDetail));

	const timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
	context.subscriptions.push({ dispose: () => clearInterval(timer) });

	const firstTimer = setTimeout(() => void refresh(), FIRST_DELAY_MS);
	context.subscriptions.push({ dispose: () => clearTimeout(firstTimer) });

	return {
		dispose: () => {
			disposed = true;
			clearInterval(timer);
			clearTimeout(firstTimer);
			item.dispose();
		},
	};
}
