/**
 * WorkBuddy 桌面端「落盘加密」凭据的解密（移植自 dsh-connect-workbuddy/src/at-rest.ts）。
 *
 * 从 WorkBuddy 5.6.0 起，桌面端不再把 `auth.accessToken` / `auth.refreshToken`
 * 存成明文字符串，而是写成一个字段包装：
 *
 *   { "$wbEncrypted": 1, "envelope": "<base64 of a JSON envelope>" }
 *
 * envelope 是 `{suite, keyId, nonce, authTag, ciphertext}`，对应 AES-256-GCM、
 * 12 字节 nonce、16 字节 tag；AAD 是对 scheme/suite/keyId/帧格式做长度前缀的
 * 转录（见 {@link fieldAad}），所以密文只能在它被封装时的那个字段形状下打开。
 *
 * 字段密钥本身**不是**用户机密，而是编译进 App 自带 Electron 原生模块
 * （`electron_browser_workbuddy_storage`）的构建期常量。App 通过 `loggerGet()`
 * 取出它，并对返回的 base64 **字符串**（不是解码后的字节）做 SHA-256 得到 32
 * 字节密钥；`keyId` 是该密钥 SHA-256 的前 16 位 hex。
 *
 * 本模块用同样的方式向"已安装的那个 App 自己"要 payload 来重新推导同一把密钥，
 * 并在进程生命周期内缓存。不落盘，也不打印 payload。
 */
import { execFile, execFileSync } from 'node:child_process';
import { createDecipheriv, createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, win32 } from 'node:path';

/** `{$wbEncrypted:1,envelope}` 包装；本模块只认这一种形状。 */
export interface WorkBuddyEncryptedField {
	$wbEncrypted: 1;
	envelope: string;
}

/** 信封帧格式名 → 单字节 AAD 帧码。 */
const FRAMING_CODE: Readonly<Record<string, number>> = {
	file: 1,
	field: 2,
	record: 3,
	stream: 4,
};

/** 标准（对称）格式标识，转录进 AAD。 */
const STANDARD_FORMAT_ID: Readonly<Record<string, string>> = {
	file: 'WBEF1',
	field: 'WBEV1',
	record: 'WBER1',
	stream: 'WBES1',
};

/** AAD 转录的域分隔前缀。 */
const AAD_DOMAIN = Buffer.from('WB-AAD\0', 'ascii');

/** 本模块负责打开的对称信封 scheme 名。 */
const SYMMETRIC_SCHEME = 'sym-v1';

/** 环境变量：手工指向 WorkBuddy 桌面端可执行文件。 */
export const WORKBUDDY_APP_EXECUTABLE_ENV = 'WORKBUDDY_APP_EXECUTABLE';

/** 等待 App 交出密钥 payload 的上限。 */
const KEY_FETCH_TIMEOUT_MS = 10_000;

/**
 * Windows 上桌面端可执行文件的可能文件名。
 *
 * `WorkBuddy.exe` 是国内版；国际版是 `WorkBuddyAI` 目录下的
 * `WorkBuddyAI.exe`。同一套名字判断也被注册表值校验复用，所以保持为列表。
 */
const APP_EXECUTABLE_NAMES: readonly string[] = ['WorkBuddy.exe', 'WorkBuddyAI.exe'];

/** 规范可执行文件名（列表第一项）。 */
const APP_EXECUTABLE_NAME = APP_EXECUTABLE_NAMES[0];

/**
 * Windows 上桌面端的安装目录（相对 `%LOCALAPPDATA%` / `%ProgramFiles%`
 * 等基目录），按探测顺序排列。
 */
const WINDOWS_APP_SUBDIRECTORIES: readonly (readonly string[])[] = [
	['Programs', 'WorkBuddy'],
	['WorkBuddy'],
	['Programs', 'WorkBuddyAI'],
	['WorkBuddyAI'],
];

/** macOS 上桌面端的 bundle 目录名（国内版 / 国际版）。 */
const MACOS_APP_BUNDLE_NAMES: readonly string[] = ['WorkBuddy.app', 'WorkBuddy AI.app'];

/** macOS bundle 的 CFBundleIdentifier 前缀，用于确认身份后才 exec。 */
const APP_BUNDLE_IDENTIFIER_PREFIXES: readonly string[] = ['com.tencent.workbuddy', 'com.workbuddy'];

function encodeUint32(value: number): Buffer {
	const bytes = Buffer.allocUnsafe(4);
	bytes.writeUInt32BE(value);
	return bytes;
}

/** 长度前缀 UTF-8 字符串：uint32 大端长度 + 内容。 */
function encodeLengthPrefixed(value: string): Buffer {
	const bytes = Buffer.from(value, 'utf8');
	return Buffer.concat([encodeUint32(bytes.length), bytes]);
}

/**
 * 一个 `sym-v1` FIELD 帧信封的 AAD。
 *
 * 只实现 field 帧：桌面端凭据字段用的就是它，而且它不会与整文件信封混淆，
 * 所以遇到别的帧格式应当直接报错，而不是悄悄拼一个错误的转录。
 */
function fieldAad(keyId: string, suite: number, scheme: string = SYMMETRIC_SCHEME): Buffer {
	if (!/^[0-9a-f]{16}$/u.test(keyId)) throw new Error('workbuddy: envelope keyId is malformed');
	return Buffer.concat([
		AAD_DOMAIN,
		Buffer.from([1]),
		encodeLengthPrefixed(STANDARD_FORMAT_ID['field']!),
		encodeLengthPrefixed(scheme),
		encodeUint32(suite),
		encodeLengthPrefixed(keyId),
		Buffer.from([FRAMING_CODE['field']!]),
		// encodeOptionalUint64(undefined)：field 帧不携带序列号。
		Buffer.from([0]),
		// final === undefined
		Buffer.from([0]),
	]);
}

/** 判断一个值是否是 App 的加密字段包装。 */
export function isEncryptedFieldWrapper(value: unknown): value is WorkBuddyEncryptedField {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}
	const wrapper = value as Record<string, unknown>;
	const keys = Object.keys(wrapper).sort();
	return (
		keys.length === 2 &&
		keys[0] === '$wbEncrypted' &&
		keys[1] === 'envelope' &&
		wrapper['$wbEncrypted'] === 1 &&
		typeof wrapper['envelope'] === 'string'
	);
}

/** 一把 32 字节密钥对应的 keyId：其 SHA-256 前 16 位 hex。 */
export function deriveAtRestKeyId(key: Buffer): string {
	return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/**
 * 从 App 的密钥 payload JSON 推导 32 字节字段密钥。
 *
 * App 哈希的是 payload 里 base64 **字符串**（不是解码后的字节），所以这里必须
 * 用同样的写法；哈希解码后的秘密会得到另一把密钥，导致每个字段都打不开。
 */
export function deriveAtRestKey(payloadJson: string): Buffer {
	let payload: unknown;
	try {
		payload = JSON.parse(payloadJson);
	} catch {
		throw new Error('workbuddy: at-rest key payload is not valid JSON');
	}
	if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
		throw new Error('workbuddy: at-rest key payload is not an object');
	}
	const secret = (payload as Record<string, unknown>)['atRestSecretKey'];
	if (typeof secret !== 'string' || secret === '') {
		throw new Error('workbuddy: at-rest key payload carries no atRestSecretKey');
	}
	return createHash('sha256').update(secret, 'utf8').digest();
}

/**
 * 用推导出的密钥打开一个加密字段，返回明文。
 *
 * 信封畸形、密钥不匹配、或认证失败都会抛错：GCM tag 不匹配意味着转录或密钥
 * 是错的，绝不能退化成半截 token。
 */
export function openEncryptedField(field: WorkBuddyEncryptedField, key: Buffer): string {
	let envelope: unknown;
	try {
		envelope = JSON.parse(Buffer.from(field.envelope, 'base64').toString('utf8'));
	} catch {
		throw new Error('workbuddy: encrypted field envelope is not valid JSON');
	}
	if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
		throw new Error('workbuddy: encrypted field envelope is not an object');
	}
	const record = envelope as Record<string, unknown>;
	const suite = record['suite'];
	const keyId = record['keyId'];
	const nonce = record['nonce'];
	const authTag = record['authTag'];
	const ciphertext = record['ciphertext'];
	if (typeof suite !== 'number' || typeof keyId !== 'string') {
		throw new Error('workbuddy: encrypted field envelope is missing suite or keyId');
	}
	if (typeof nonce !== 'string' || typeof authTag !== 'string' || typeof ciphertext !== 'string') {
		throw new Error('workbuddy: encrypted field envelope is missing nonce, authTag or ciphertext');
	}
	const expectedKeyId = deriveAtRestKeyId(key);
	if (keyId !== expectedKeyId) {
		throw new Error(
			`workbuddy: encrypted field belongs to key ${keyId}, not the available key ${expectedKeyId}`,
		);
	}
	const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64'), {
		authTagLength: 16,
	});
	decipher.setAAD(fieldAad(keyId, suite));
	decipher.setAuthTag(Buffer.from(authTag, 'base64'));
	return Buffer.concat([
		decipher.update(Buffer.from(ciphertext, 'base64')),
		decipher.final(),
	]).toString('utf8');
}

/** macOS bundle 内真实的可执行文件路径（读 bundle 自己的 Info.plist）。 */
export function macosBundleExecutable(bundle: string): string | undefined {
	let plist: string;
	try {
		plist = readFileSync(join(bundle, 'Contents', 'Info.plist'), 'utf8');
	} catch {
		return undefined;
	}
	const match = /<key>\s*CFBundleExecutable\s*<\/key>\s*<string>([^<]*)<\/string>/u.exec(plist);
	const name = match?.[1]?.trim();
	if (
		name === undefined ||
		name === '' ||
		name.includes('/') ||
		name.includes('\\') ||
		name === '.' ||
		name === '..'
	) {
		return undefined;
	}
	return join(bundle, 'Contents', 'MacOS', name);
}

/** 某个 bundle 是否自称是 WorkBuddy（按点边界匹配 bundle id）。 */
export function isWorkbuddyBundle(bundle: string): boolean {
	let plist: string;
	try {
		plist = readFileSync(join(bundle, 'Contents', 'Info.plist'), 'utf8');
	} catch {
		return false;
	}
	const match = /<key>\s*CFBundleIdentifier\s*<\/key>\s*<string>([^<]*)<\/string>/u.exec(plist);
	const identifier = match?.[1]?.trim().toLowerCase();
	if (identifier === undefined || identifier === '') {
		return false;
	}
	return APP_BUNDLE_IDENTIFIER_PREFIXES.some(
		prefix => identifier === prefix || identifier.startsWith(`${prefix}.`),
	);
}

/** 某个 applications 目录下**一层**子目录里的 WorkBuddy bundle。 */
export function macosNestedAppBundles(parent: string): string[] {
	let entries: string[];
	try {
		entries = readdirSync(parent);
	} catch {
		return [];
	}
	const bundles: string[] = [];
	for (const entry of entries) {
		const nested = join(parent, entry);
		for (const name of MACOS_APP_BUNDLE_NAMES) {
			const bundle = join(nested, name);
			try {
				if (!statSync(bundle).isDirectory()) {
					continue;
				}
			} catch {
				continue;
			}
			if (isWorkbuddyBundle(bundle)) {
				bundles.push(bundle);
			}
		}
	}
	return bundles;
}

/**
 * 从 Windows 卸载注册表读到可执行文件路径，或 undefined。
 *
 * 目录候选只覆盖默认安装布局；装在别处（例如第二个盘）的 App 会全部落空，
 * 于是"已登录"被报成"未登录"。安装器自己记下了路径，所以这里去问它。
 *
 * 三个卸载视图都查：按用户安装落在 HKCU，机器级落在 HKLM，32 位机器级落在
 * WOW6432Node。键不存在是正常情况，一律返回 undefined。
 */
export function windowsRegistryAppExecutable(
	query: (args: readonly string[]) => string | undefined = queryRegistry,
): string | undefined {
	// `DisplayIcon` 直接指向二进制，优先；`InstallLocation` 是没有图标值时的兜底。
	const keys = [
		'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
		'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
		'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
	];
	for (const root of keys) {
		const listing = query(['query', root, '/s', '/f', 'WorkBuddy', '/t', 'REG_SZ']);
		if (listing === undefined) {
			continue;
		}
		const executable = registryExecutableFromQuery(listing);
		if (executable !== undefined) {
			return executable;
		}
		const fromDirectory = registryInstallLocationFromQuery(listing);
		if (fromDirectory !== undefined) {
			return fromDirectory;
		}
	}
	return undefined;
}

/** 从 `reg query` 输出里取出 `DisplayIcon` 指向的可执行文件。 */
export function registryExecutableFromQuery(output: string): string | undefined {
	for (const rawLine of output.split(/\r?\n/u)) {
		const match = /^\s*DisplayIcon\s+REG_SZ\s+(.*?)\s*$/u.exec(rawLine);
		if (match === null) {
			continue;
		}
		const executable = normalizeRegistryExecutable(match[1]!);
		if (executable !== undefined) {
			return executable;
		}
	}
	return undefined;
}

/** 从 `reg query` 输出里取出 `InstallLocation` 目录再拼上可执行文件名。 */
export function registryInstallLocationFromQuery(output: string): string | undefined {
	for (const rawLine of output.split(/\r?\n/u)) {
		const match = /^\s*InstallLocation\s+REG_SZ\s+(.*?)\s*$/u.exec(rawLine);
		if (match === null) {
			continue;
		}
		const directory = stripRegistryQuotes(match[1]!);
		if (directory === undefined || directory === '') {
			continue;
		}
		return win32.join(directory, APP_EXECUTABLE_NAME);
	}
	return undefined;
}

/** 把 `DisplayIcon` 值规约成可用路径；不是桌面端二进制则拒绝。 */
export function normalizeRegistryExecutable(value: string): string | undefined {
	const unquoted = stripRegistryQuotes(value);
	if (unquoted === undefined || unquoted === '') {
		return undefined;
	}
	// 去掉末尾的 `,<index>`（图标序号），不碰路径里本身的逗号。
	const withoutIndex = unquoted.replace(/,\s*-?\d+\s*$/u, '');
	if (withoutIndex === '') {
		return undefined;
	}
	const base = win32.basename(withoutIndex).toLowerCase();
	if (!APP_EXECUTABLE_NAMES.some(name => name.toLowerCase() === base)) {
		return undefined;
	}
	return withoutIndex;
}

/** 取出注册表值里的路径（去引号）。 */
export function stripRegistryQuotes(value: string): string | undefined {
	const trimmed = value.trim();
	if (trimmed === '') {
		return undefined;
	}
	if (!trimmed.startsWith('"')) {
		return trimmed;
	}
	const closing = trimmed.indexOf('"', 1);
	if (closing === -1) {
		return undefined;
	}
	return trimmed.slice(1, closing).trim();
}

/**
 * 执行 `reg query` 并返回 stdout，失败返回 undefined。
 *
 * `windowsHide` 是必须的：VS Code 扩展宿主没有控制台，不设它会每探测一次就闪
 * 一个黑窗。`execFileSync` 让候选列表保持为输入的纯函数。
 */
function queryRegistry(args: readonly string[]): string | undefined {
	try {
		return execFileSync('reg', [...args], REGISTRY_PROBE_OPTIONS);
	} catch {
		// 键或值不存在时 `reg` 以非零退出，这是正常情况。
		return undefined;
	}
}

const REGISTRY_PROBE_OPTIONS = { encoding: 'utf8', windowsHide: true, timeout: 10_000 } as const;

/** 桌面端可执行文件的候选路径，按探测顺序排列。 */
export function workbuddyAppExecutableCandidates(
	platform: NodeJS.Platform = process.platform,
	home: string = homedir(),
	env: NodeJS.ProcessEnv = process.env,
	readBundleExecutable: (bundle: string) => string | undefined = macosBundleExecutable,
): string[] {
	const candidates: (string | undefined)[] = [env[WORKBUDDY_APP_EXECUTABLE_ENV]?.trim()];
	if (platform === 'win32') {
		const local = env['LOCALAPPDATA']?.trim();
		const programFiles = env['ProgramFiles']?.trim();
		const programFilesX86 = env['ProgramFiles(x86)']?.trim();
		// 这里用 `win32.join`：这些路径按构造就是 Windows 路径。
		const bases = [
			local === undefined || local === '' ? undefined : local,
			programFiles === undefined || programFiles === '' ? undefined : programFiles,
			programFilesX86 === undefined || programFilesX86 === '' ? undefined : programFilesX86,
		];
		for (const base of bases) {
			if (base === undefined) {
				continue;
			}
			for (const subdirectory of WINDOWS_APP_SUBDIRECTORIES) {
				for (const name of APP_EXECUTABLE_NAMES) {
					candidates.push(win32.join(base, ...subdirectory, name));
				}
			}
		}
	} else if (platform === 'darwin') {
		for (const name of MACOS_APP_BUNDLE_NAMES) {
			candidates.push(
				readBundleExecutable(join('/Applications', name)),
				readBundleExecutable(join(home, 'Applications', name)),
			);
		}
	}
	return candidates.filter(
		(candidate): candidate is string => candidate !== undefined && candidate !== '',
	);
}

/** 第一个真实存在的候选；全部落空则回落到注册表 / 嵌套 bundle 扫描。 */
export function findWorkbuddyAppExecutable(
	platform: NodeJS.Platform = process.platform,
	home: string = homedir(),
	env: NodeJS.ProcessEnv = process.env,
	readRegistryAppPath: () => string | undefined = windowsRegistryAppExecutable,
): string | undefined {
	for (const candidate of workbuddyAppExecutableCandidates(platform, home, env)) {
		try {
			if (existsSync(candidate)) {
				return candidate;
			}
		} catch {
			// 不可读：试下一个。
		}
	}
	if (platform === 'win32') {
		const fromRegistry = readRegistryAppPath();
		if (fromRegistry !== undefined) {
			try {
				if (existsSync(fromRegistry)) {
					return fromRegistry;
				}
			} catch {
				// 不可读：落到 undefined。
			}
		}
	}
	if (platform === 'darwin') {
		for (const parent of ['/Applications', join(home, 'Applications')]) {
			for (const bundle of macosNestedAppBundles(parent)) {
				const executable = macosBundleExecutable(bundle);
				if (executable === undefined) {
					continue;
				}
				try {
					if (existsSync(executable)) {
						return executable;
					}
				} catch {
					// 不可读：试下一个。
				}
			}
		}
	}
	return undefined;
}

/**
 * 让已安装的桌面端以纯 Node 模式（`ELECTRON_RUN_AS_NODE`）运行它自己的二进制，
 * 调用原生 binding 拿密钥 payload。
 *
 * binding 是这个值在 App 自己的公开出口，所以本扩展不必内置任何构建期常量：
 * 它问的就是写出那个文件的同一份构建。子进程不给 stdin、有硬超时，只读 stdout。
 */
export function fetchAtRestKeyPayload(executable: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const source =
			"try{process.stdout.write(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet())}" +
			'catch(e){process.exitCode=3;process.stderr.write(String(e&&e.message||e))}';
		execFile(
			executable,
			['-e', source],
			{
				env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
				timeout: KEY_FETCH_TIMEOUT_MS,
				windowsHide: true,
				maxBuffer: 1024 * 1024,
			},
			(error, stdout, stderr) => {
				if (error !== null) {
					reject(
						new Error(
							`workbuddy: the desktop app did not provide its at-rest key (${stderr.trim() || error.message})`,
						),
					);
					return;
				}
				const payload = stdout.trim();
				if (payload === '') {
					reject(new Error('workbuddy: the desktop app returned an empty at-rest key payload'));
					return;
				}
				resolve(payload);
			},
		);
	});
}

/** 进程级密钥缓存；永不落盘。 */
let cachedKey: Buffer | undefined;
let inflightKey: Promise<Buffer | undefined> | undefined;

/**
 * 桌面端的落盘字段密钥；拿不到就返回 undefined（App 未装、旧构建没有该原生
 * 模块、或未来构建换了 payload）。成功后缓存，因此每个进程最多拉起一次 App；
 * 失败不缓存，因为用户可能在这期间装上或启动 App。
 */
export function readAtRestKey(): Promise<Buffer | undefined> {
	if (cachedKey !== undefined) {
		return Promise.resolve(cachedKey);
	}
	inflightKey ??= (async () => {
		const executable = findWorkbuddyAppExecutable();
		if (executable === undefined) {
			return undefined;
		}
		const payload = await fetchAtRestKeyPayload(executable);
		const key = deriveAtRestKey(payload);
		cachedKey = key;
		return key;
	})().finally(() => {
		inflightKey = undefined;
	});
	return inflightKey;
}

/** 丢弃缓存的密钥；仅测试与诊断用。 */
export function clearAtRestKeyCache(): void {
	cachedKey = undefined;
	inflightKey = undefined;
}
