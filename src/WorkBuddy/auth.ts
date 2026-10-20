/**
 * WorkBuddy 凭据发现（移植自 dsh-connect-workbuddy/src/auth.ts 的凭据部分）。
 *
 * 桌面端登录后把登录态写在
 *   %LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info
 * （macOS 为 ~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/，
 * Linux 为 $XDG_CONFIG_HOME/CodeBuddyExtension/Data/Public/auth/）。
 * 文件形状是 `{"auth":{...},"account":{...},...}`；Windows 新版把
 * `auth.accessToken` / `auth.refreshToken` 存成 `{$wbEncrypted:1,envelope}`
 * 加密包装，需要向桌面端 App 要密钥才能解开（见 at-rest.ts）。
 *
 * 探测顺序（找到第一个可用的就停）：
 *   1. 环境变量 WORKBUDDY_API_KEY
 *   2. 桌面端登录态文件（活文件优先，其次同名时间戳备份）
 *
 * 所有磁盘读取都做静默失败处理：没装 WorkBuddy 的用户不应看到任何报错。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
	isEncryptedFieldWrapper,
	openEncryptedField,
	readAtRestKey,
	WORKBUDDY_APP_EXECUTABLE_ENV,
} from './at-rest';

export interface WorkBuddyCredential {
	/** 给上游用的 access_token */
	apiKey: string;
	/** 来源描述，用于 UI 展示，如 "环境变量 WORKBUDDY_API_KEY" / "桌面端登录态" */
	source: string;
	/** 文件来源时的绝对路径 */
	filePath?: string;
	/** 可选的 refresh_token（设置/环境变量来源时为空） */
	refreshToken?: string;
	/** uid / uin / nickname，拼请求头或做状态展示用 */
	uid?: string;
	uin?: string;
	nickname?: string;
	/** 企业号；SSO 账号才有，用于 X-Enterprise-Id */
	enterpriseId?: string;
	/** 账号域，用来判断国内区还是全球区，如 www.workbuddy.cn */
	domain?: string;
	/** access token 过期时间（epoch ms，0 表示未知） */
	expiresAtMs?: number;
	/**
	 * 上游最后一次签发时间（`auth.lastRefreshTime`）。这是唯一可信的"新鲜度"
	 * 信号：上游吊销 token 时不会改 `expiresAt`，所以一个死掉的备份也可能声称
	 * 更晚的过期时间，只有活文件才该优先。
	 */
	lastRefreshAtMs?: number;
}

/** 桌面端活文件的名字。 */
export const WORKBUDDY_LIVE_FILENAME = 'workbuddy-desktop.info';

/** 环境变量：手工指向一个具体的登录态文件。 */
export const WORKBUDDY_AUTH_FILE_ENV = 'WORKBUDDY_AUTH_FILE';

/** 桌面端登录态目录（按平台），找不到时返回空数组。 */
export function defaultDesktopAuthDirs(
	platform: NodeJS.Platform = process.platform,
	home: string = homedir(),
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	if (platform === 'darwin') {
		return [join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth')];
	}
	if (platform === 'win32') {
		const local = nonEmptyEnv(env['LOCALAPPDATA']) ?? join(home, 'AppData', 'Local');
		const roaming = nonEmptyEnv(env['APPDATA']) ?? join(home, 'AppData', 'Roaming');
		return [
			join(local, 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
			join(roaming, 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
		];
	}
	if (platform === 'linux') {
		const config = nonEmptyEnv(env['XDG_CONFIG_HOME']) ?? join(home, '.config');
		return [join(config, 'CodeBuddyExtension', 'Data', 'Public', 'auth')];
	}
	return [];
}

function nonEmptyEnv(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** 过期时间规约到 ms（上游有时给秒、有时给毫秒）。 */
export function expiryToMs(value: number): number {
	if (value <= 0) {
		return 0;
	}
	return value > 1e12 ? value : value * 1000;
}

/**
 * 解析一个字符串字段，必要时打开桌面端的加密包装。
 *
 * Windows 新版把 `accessToken` / `refreshToken` 存成 `{$wbEncrypted:1,envelope}`；
 * 只认字符串的读取器会完全看不到凭据，把已登录的账号报成未登录。`nickname`
 * 同样是加密的。`key` 为 undefined 时（没拿到密钥）加密字段解析为 undefined，
 * 而不是伪造一个值。
 */
function credentialField(value: unknown, key: Buffer | undefined): string | undefined {
	if (typeof value === 'string') {
		return value;
	}
	if (!isEncryptedFieldWrapper(value)) {
		return undefined;
	}
	if (key === undefined) {
		return undefined;
	}
	return openEncryptedField(value, key);
}

/**
 * 可缺省字段：缺失、非字符串且非包装、包装但打不开，都表示"未知"，不应让整份
 * 文档判为无效。`account.phoneNumber` 故意从不读取。
 */
function optionalCredentialField(value: unknown, key: Buffer | undefined): string | undefined {
	if (typeof value === 'string') {
		return value === '' ? undefined : value;
	}
	if (!isEncryptedFieldWrapper(value)) {
		return undefined;
	}
	if (key === undefined) {
		return undefined;
	}
	try {
		return openEncryptedField(value, key);
	} catch {
		return undefined;
	}
}

/**
 * 解析桌面端登录态文档，兼容两种落盘形状：插件 OAuth 的嵌套形式
 * `{"auth":{...},"account":{...}}` 与扁平面板形式。没有 access token 时返回
 * undefined。`atRestKey` 用于读取加密字段。
 */
export function parseWorkBuddyAuth(
	text: string,
	filePath: string,
	atRestKey?: Buffer,
): WorkBuddyCredential | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		return undefined;
	}
	const document = parsed as Record<string, unknown>;
	let auth: Record<string, unknown>;
	let identity: Record<string, unknown>;
	if (typeof document['auth'] === 'object' && document['auth'] !== null) {
		auth = document['auth'] as Record<string, unknown>;
		identity =
			typeof document['account'] === 'object' && document['account'] !== null
				? (document['account'] as Record<string, unknown>)
				: {};
	} else {
		auth = document;
		identity = document;
	}
	let accessToken: string | undefined;
	let refreshToken: string | undefined;
	try {
		accessToken = credentialField(auth['accessToken'], atRestKey);
		refreshToken = credentialField(auth['refreshToken'], atRestKey);
	} catch {
		// 信封畸形、密钥不匹配、认证失败，都等同于"这份文档不可读"，绝不能退化成
		// 半解密的凭据。
		return undefined;
	}
	if (accessToken === undefined || accessToken === '') {
		return undefined;
	}
	const expiresAtMs = typeof auth['expiresAt'] === 'number' ? expiryToMs(auth['expiresAt']) : 0;
	const refreshExpiresAtMs =
		typeof auth['refreshExpiresAt'] === 'number' ? expiryToMs(auth['refreshExpiresAt']) : undefined;
	const lastRefreshAtMs =
		typeof auth['lastRefreshTime'] === 'number' ? expiryToMs(auth['lastRefreshTime']) : undefined;
	const nickname = optionalCredentialField(identity['nickname'], atRestKey);
	const uin = optionalCredentialField(identity['uin'], atRestKey);
	const uid = optionalCredentialField(identity['uid'], atRestKey);
	const enterpriseId = optionalCredentialField(identity['enterpriseId'], atRestKey);
	const domain = optionalCredentialField(auth['domain'], atRestKey);
	void refreshExpiresAtMs;
	return {
		apiKey: accessToken,
		refreshToken: refreshToken ?? '',
		source: '桌面端登录态',
		filePath,
		...(domain === undefined ? {} : { domain }),
		...(uid === undefined ? {} : { uid }),
		...(uin === undefined ? {} : { uin }),
		...(nickname === undefined ? {} : { nickname }),
		...(enterpriseId === undefined ? {} : { enterpriseId }),
		expiresAtMs,
		...(lastRefreshAtMs === undefined ? {} : { lastRefreshAtMs }),
	};
}

/**
 * 文档里是否有需要解密才能读的字段（token 或身份字段）。
 *
 * 先判断这个再向 App 要密钥，可以让明文场景（macOS、旧版 Windows、插件自己写
 * 的副本）不必每次读凭据都拉起一个子进程。
 */
export function hasEncryptedCredentialFields(text: string): boolean {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return false;
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		return false;
	}
	const document = parsed as Record<string, unknown>;
	const auth =
		typeof document['auth'] === 'object' && document['auth'] !== null
			? (document['auth'] as Record<string, unknown>)
			: document;
	const identity =
		typeof document['account'] === 'object' && document['account'] !== null
			? (document['account'] as Record<string, unknown>)
			: document;
	return (
		isEncryptedFieldWrapper(auth['accessToken']) ||
		isEncryptedFieldWrapper(auth['refreshToken']) ||
		isEncryptedFieldWrapper(identity['nickname']) ||
		isEncryptedFieldWrapper(identity['uin']) ||
		isEncryptedFieldWrapper(identity['uid']) ||
		isEncryptedFieldWrapper(identity['enterpriseId']) ||
		isEncryptedFieldWrapper(auth['domain'])
	);
}

/** 文件名（兼容 Windows / POSIX 分隔符）。 */
export function authFileName(path: string): string {
	const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	return separator === -1 ? path : path.slice(separator + 1);
}

/** 活文件排名 0，备份排名 1：活文件永远优先。 */
function fileRank(path: string): number {
	return authFileName(path) === WORKBUDDY_LIVE_FILENAME ? 0 : 1;
}

/**
 * `candidate` 是否比 `incumbent` 更适合同一账号。
 *
 * 优先级从强到弱：1) 活文件（App 当前登录）；2) 最近的 `lastRefreshAtMs`
 * （上游自己的签发时间）；3) `expiresAtMs`，仅作为缺字段时的兜底。
 */
function isFresher(candidate: WorkBuddyCredential, incumbent: WorkBuddyCredential): boolean {
	const rankDiff = fileRank(candidate.filePath ?? '') - fileRank(incumbent.filePath ?? '');
	if (rankDiff !== 0) {
		return rankDiff < 0;
	}
	const candidateRefresh = candidate.lastRefreshAtMs;
	const incumbentRefresh = incumbent.lastRefreshAtMs;
	if (candidateRefresh !== undefined && incumbentRefresh !== undefined) {
		if (candidateRefresh !== incumbentRefresh) {
			return candidateRefresh > incumbentRefresh;
		}
	} else if (candidateRefresh !== undefined) {
		return true;
	} else if (incumbentRefresh !== undefined) {
		return false;
	}
	return (candidate.expiresAtMs ?? 0) > (incumbent.expiresAtMs ?? 0);
}

/**
 * 读一个登录态文件：先按明文解析，只有文档确实带加密包装时才向 App 要密钥。
 * 读不到或解析不了时返回 undefined（并把原因放进 lastCredentialFailure）。
 */
export function probeAuthFile(
	path: string,
	resolveAtRestKey: () => Promise<Buffer | undefined> = readAtRestKey,
): Promise<WorkBuddyCredential | undefined> {
	return (async () => {
		let text: string;
		try {
			text = readFileSync(path, 'utf8');
		} catch (error) {
			lastCredentialFailure = {
				path,
				reason: (error as NodeJS.ErrnoException | null)?.code === 'ENOENT' ? 'missing' : 'unreadable',
			};
			return undefined;
		}
		const plain = parseWorkBuddyAuth(text, path);
		if (plain !== undefined) {
			return plain;
		}
		if (!hasEncryptedCredentialFields(text)) {
			lastCredentialFailure = { path, reason: 'invalid' };
			return undefined;
		}
		let key: Buffer | undefined;
		try {
			key = await resolveAtRestKey();
		} catch (error) {
			lastCredentialFailure = {
				path,
				reason: 'encrypted',
				message: error instanceof Error ? error.message : String(error),
			};
			return undefined;
		}
		if (key === undefined) {
			lastCredentialFailure = {
				path,
				reason: 'encrypted',
				message: `凭据字段是加密的，且拿不到解密密钥；需要本机装有 WorkBuddy 桌面端（或设置 ${WORKBUDDY_APP_EXECUTABLE_ENV}）`,
			};
			return undefined;
		}
		const decrypted = parseWorkBuddyAuth(text, path, key);
		if (decrypted === undefined) {
			lastCredentialFailure = {
				path,
				reason: 'invalid',
				message: '加密的凭据字段无法用桌面端的密钥解开',
			};
		}
		return decrypted;
	})();
}

/** 最近一次扫描中，某个候选文件为什么没有产出凭据（诊断用，不含 token）。 */
export interface WorkBuddyCredentialFailure {
	path: string;
	reason: 'missing' | 'unreadable' | 'invalid' | 'encrypted';
	message?: string;
}

/** 最近一次 `resolveCredential()` 中失败的原因；成功后为 undefined。 */
export let lastCredentialFailure: WorkBuddyCredentialFailure | undefined;

/** 已被探测过的候选文件（诊断用）。 */
export let lastProbedPaths: readonly string[] = [];

/** 时间戳兄弟备份：同一个目录下其它 `*.info` 文件，按文件名倒序。 */
function backupsBeside(path: string): string[] {
	const dir = dirname(path);
	const base = authFileName(path);
	try {
		return readdirSync(dir)
			.filter(name => name !== base && name.endsWith('.info'))
			.sort()
			.reverse()
			.map(name => join(dir, name));
	} catch {
		return [];
	}
}

/** 所有候选登录态文件：活文件在前，备份在后。 */
export function candidateAuthFiles(
	dirs: readonly string[] = defaultDesktopAuthDirs(),
): string[] {
	const explicit = nonEmptyEnv(process.env[WORKBUDDY_AUTH_FILE_ENV]);
	if (explicit !== undefined) {
		return [explicit];
	}
	const files: string[] = [];
	for (const dir of dirs) {
		const live = join(dir, WORKBUDDY_LIVE_FILENAME);
		if (existsSync(live)) {
			files.push(live);
		}
		for (const backup of backupsBeside(live)) {
			files.push(backup);
		}
	}
	return files;
}

/**
 * 解析当前可用的 WorkBuddy 凭据（异步：加密凭据需要先向桌面端要密钥）。
 *
 * 来源优先级：环境变量 WORKBUDDY_API_KEY → 桌面端登录态文件。
 */
export async function resolveCredential(
	dirs: readonly string[] = defaultDesktopAuthDirs(),
): Promise<WorkBuddyCredential | undefined> {
	lastCredentialFailure = undefined;
	lastProbedPaths = [];

	const envKey = process.env.WORKBUDDY_API_KEY?.trim();
	if (envKey && envKey.length >= 8) {
		return { apiKey: envKey, source: '环境变量 WORKBUDDY_API_KEY' };
	}

	const files = candidateAuthFiles(dirs);
	lastProbedPaths = files;
	const byFile = new Map<string, WorkBuddyCredential>();
	for (const file of files) {
		const credential = await probeAuthFile(file);
		if (credential === undefined) {
			continue;
		}
		// 同一个账号（uin 优先，其次 uid）只保留最新的一份。
		const id = credential.uin ?? credential.uid ?? file;
		const existing = byFile.get(id);
		if (existing === undefined || isFresher(credential, existing)) {
			byFile.set(id, credential);
		}
	}
	const found = [...byFile.values()];
	if (found.length > 0) {
		lastCredentialFailure = undefined;
		return found[0];
	}
	if (lastCredentialFailure === undefined) {
		lastCredentialFailure = {
			path: dirs.join('; ') || '(none)',
			reason: 'missing',
			message: `没有找到 ${WORKBUDDY_LIVE_FILENAME}；请先登录 WorkBuddy 桌面端`,
		};
	}
	return undefined;
}
