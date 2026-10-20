/**
 * 查 WorkBuddy 账号的剩余积分（credits）。
 *
 * 移植自 dsh-connect-workbuddy/src/upstream.ts 的 `fetchCredits()`：
 * 打的是**计费网关**，不是 chat 网关 —— 国内账号走 www.codebuddy.cn，
 * 国际账号走其 globalBase。接口：
 *
 *   POST {billingBase}/v2/billing/meter/get-user-resource
 *   { PageNumber: 1, PageSize: 100, ProductCode: 'p_tcaca', Status: [0,3],
 *     PackageEndTimeRangeBegin: 'YYYY-MM-DD HH:mm:ss',
 *     PackageEndTimeRangeEnd:   'YYYY-MM-DD HH:mm:ss' }
 *   → { code: 0, data: { Response: { Data: { Accounts: [...] } } } }
 *
 * 每一条 Account 是一个"套餐"：
 *  - CapacityType 4 = 每月周期额度（到期刷新，不消失）
 *  - CapacityType 1 = 一次性赠送额度（用完或到期就没了）
 *
 * 所有容量字段还同时提供 `<字段>Precise` 字符串，带着整数丢了的小数
 * （"96.61000218" 对应 96）。官方客户端用的是 precise 值，这里也一样。
 */

import type { WorkBuddyCredential } from './auth';
import {
	billingBase,
	billingHeaders,
	JSON_TIMEOUT_MS,
} from './protocol';

/** 一个仍在生效的额度包。 */
export interface CreditPackage {
	packageName: string;
	/** 剩余额度（已把负数截成 0） */
	remain: number;
	/** 这一包的容量上限 */
	size: number;
	/** true = 每月周期额度，false = 一次性赠送 */
	monthly: boolean;
	/** 周期额度：下次刷新的时间点 */
	refreshAtMs?: number;
	/** 赠送额度：过期时间点 */
	expiresAtMs?: number;
}

export interface WorkBuddyCredits {
	/** 所有仍可用额度之和 */
	total: number;
	packages: CreditPackage[];
	/** 3 天内会过期的额度合计 */
	expiringSoon: number;
	/** 最近的一次过期（不含周期额度的刷新） */
	nearestExpiryMs?: number;
}

/** 3 天——和原项目一样，"快到期的额度"按这个窗口统计。 */
const SOON_MS = 3 * 24 * 60 * 60 * 1000;

const DATE_PAD = (value: number): string => String(value).padStart(2, '0');

/** 上游要的是本地时区的 `YYYY-MM-DD HH:mm:ss`（不是 ISO，没有 T/Z）。 */
function formatUpstreamDate(date: Date): string {
	const day = [
		date.getFullYear().toString().padStart(4, '0'),
		DATE_PAD(date.getMonth() + 1),
		DATE_PAD(date.getDate()),
	].join('-');
	const time = [DATE_PAD(date.getHours()), DATE_PAD(date.getMinutes()), DATE_PAD(date.getSeconds())].join(':');
	return `${day} ${time}`;
}

function parseDate(value: unknown): number | undefined {
	if (typeof value === 'number' && value > 1_000_000_000_000) {
		return value;
	}
	if (typeof value === 'string' && value !== '') {
		const parsed = Date.parse(value);
		if (!Number.isNaN(parsed)) {
			return parsed;
		}
	}
	return undefined;
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

/**
 * 查一次剩余额度。
 *
 * 失败就抛异常（调用方决定是静默隐藏还是报给用户）——不返回编造的数字。
 */
export async function fetchCredits(credential: WorkBuddyCredential): Promise<WorkBuddyCredits> {
	const now = new Date();
	const response = await fetch(`${billingBase(credential)}/v2/billing/meter/get-user-resource`, {
		method: 'POST',
		headers: billingHeaders(credential),
		body: JSON.stringify({
			PageNumber: 1,
			PageSize: 100,
			ProductCode: 'p_tcaca',
			Status: [0, 3],
			PackageEndTimeRangeBegin: formatUpstreamDate(now),
			// 上游要求给一个区间；原项目取 101 年，这里照搬。
			PackageEndTimeRangeEnd: formatUpstreamDate(new Date(now.getTime() + 365 * 101 * 24 * 3600 * 1000)),
		}),
		signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
	});

	const text = await response.text();
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(`额度接口返回了非 JSON（http ${response.status}）：${text.slice(0, 120)}`);
	}
	const envelope = record(parsed);
	const code = typeof envelope['code'] === 'number' ? envelope['code'] : 0;
	if (!response.ok || code !== 0) {
		const msg = typeof envelope['msg'] === 'string' ? envelope['msg'] : `http ${response.status}`;
		throw new Error(`额度接口拒绝（HTTP ${response.status}，code ${code}）：${msg.slice(0, 120)}`);
	}

	const inner = record(record(envelope['data'])['Response']);
	const data = record(inner['Data']);
	const rawAccounts = Array.isArray(data['Accounts']) ? data['Accounts'] : [];

	let total = 0;
	let nearestExpiryMs: number | undefined;
	let expiringSoon = 0;
	const packages: CreditPackage[] = [];

	for (const raw of rawAccounts) {
		if (typeof raw !== 'object' || raw === null) {
			continue;
		}
		const account = raw as Record<string, unknown>;
		const numberField = (key: string): number =>
			typeof account[key] === 'number' ? account[key] as number : 0;
		// 优先读 `*Precise` 字符串，退回整数字段。
		const preciseField = (key: string): number => {
			const precise = account[`${key}Precise`];
			if (typeof precise === 'string' && precise !== '') {
				const value = Number.parseFloat(precise);
				if (Number.isFinite(value)) {
					return value;
				}
			}
			if (typeof precise === 'number' && Number.isFinite(precise)) {
				return precise;
			}
			return numberField(key);
		};

		const monthly = numberField('CapacityType') === 4;
		const size = preciseField('CycleCapacitySize') || preciseField('CapacitySize');
		// 余额一律读周期字段（cycle family），没有才读普通的 CapacityRemain。
		// 这是原项目踩过的坑（issue #58）：只看 CapacityRemain 会把每月额度算错。
		const hasCycle =
			account['CycleCapacityRemain'] !== undefined || account['CycleCapacityRemainPrecise'] !== undefined;
		const remain = hasCycle ? preciseField('CycleCapacityRemain') : preciseField('CapacityRemain');
		const cappedRemain = remain < 0 ? 0 : remain;

		const cycleEndMs = parseDate(account['CycleEndTime']);
		// 周期额度没有"过期"，只有"刷新"；赠送额度才有 ExpiredTime。
		const expiresAtMs = monthly ? undefined : parseDate(account['ExpiredTime']) ?? cycleEndMs;
		const refreshAtMs = monthly && cycleEndMs !== undefined ? cycleEndMs + 1_000 : undefined;

		// 已经用完或过期的赠送额度直接丢，不占"最近过期"的名额。
		if (!monthly && (cappedRemain <= 0 || (expiresAtMs !== undefined && expiresAtMs <= Date.now()))) {
			continue;
		}

		total += cappedRemain;
		if (expiresAtMs !== undefined) {
			if (nearestExpiryMs === undefined || expiresAtMs < nearestExpiryMs) {
				nearestExpiryMs = expiresAtMs;
			}
			if (expiresAtMs - Date.now() <= SOON_MS) {
				expiringSoon += cappedRemain;
			}
		}
		packages.push({
			packageName: typeof account['PackageName'] === 'string' ? account['PackageName'] : '(未命名)',
			remain: cappedRemain,
			size,
			monthly,
			...(refreshAtMs === undefined ? {} : { refreshAtMs }),
			...(expiresAtMs === undefined ? {} : { expiresAtMs }),
		});
	}

	return {
		total,
		packages,
		expiringSoon,
		...(nearestExpiryMs === undefined ? {} : { nearestExpiryMs }),
	};
}

/** 把数字写成带千分位、至多一位小数的形式（2205.5 → "2,205.5"）。 */
export function formatCredits(value: number): string {
	const rounded = Math.round(value * 10) / 10;
	return rounded.toLocaleString('en-US', { maximumFractionDigits: 1 });
}
