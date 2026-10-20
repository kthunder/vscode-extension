/**
 * bytebuddy（WorkBuddy 桌面端背后的模型网关）协议定义。
 *
 * 请求：POST /v2/chat/completions
 *   请求头
 *     Authorization: Bearer <WorkBuddy 桌面端登录后的 API key>
 *     Content-Type:  application/json
 *     Accept:        text/event-stream
 *   请求体：标准 OpenAI JSON（见 encodeChatRequest）
 *   响应：text/event-stream，每条 data 是标准 OpenAI chunk
 *
 * 注意：这里不是 protobuf / lark 编码。实测以标准 OpenAI JSON 请求该端点会直接
 * 返回 200 + 标准 SSE；早先基于字节观察推出的 protobuf 方案是错的方向。
 */

import { randomUUID } from 'node:crypto';

export interface RegionConfig {
	/** 在 VS Code 里注册的 vendor id（全局唯一），chat 模型选择器里显示为 "WorkBuddy (国内)" */
	vendor: string;
	/** chat 模型选择器里显示的 provider 名 */
	label: string;
	/** bytebuddy 网关地址 */
	baseUrl: string;
}

export const REGIONS = {
	cn: {
		vendor: 'workbuddy',
		label: 'WorkBuddy (CN)',
		baseUrl: 'https://copilot.tencent.com',
	} as RegionConfig,
	global: {
		vendor: 'workbuddy-global',
		label: 'WorkBuddy (Global)',
		baseUrl: 'https://www.workbuddy.ai',
	} as RegionConfig,
};

export type RegionKey = keyof typeof REGIONS;

export const REGION_KEYS: RegionKey[] = ['cn', 'global'];

/** chat 端点。注意是 v2：`/v1/chat/completions` 在网关上不存在（404 Route Not Found）。 */
export const CHAT_PATH = '/v2/chat/completions';

// ---------------------------------------------------------------------------
// 区域判定与请求头（移植自 dsh-connect-workbuddy/src/upstream.ts）
// ---------------------------------------------------------------------------

/** 与官方 CLI 一致的 UA；部分网关形态会校验它。 */
export const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2';

/**
 * 凭据的 `domain` 决定打哪个网关。
 *
 * 国际账号在品牌域之间不可互换：`codebuddy.ai` 签发的 token 会被
 * `workbuddy.ai` 网关拒绝（反之亦然），所以 base 必须跟随凭据自己的 domain，
 * 不能写死一个主机。
 */
export function regionOf(domain: string | undefined): RegionKey {
	const lowered = (domain ?? '').trim().toLowerCase();
	if (lowered === 'workbuddy.ai' || lowered.endsWith('.workbuddy.ai')) {
		return 'global';
	}
	if (lowered === 'codebuddy.ai' || lowered.endsWith('.codebuddy.ai')) {
		return 'global';
	}
	return 'cn';
}

/** 国际网关：跟随凭据自己的品牌域，认不出来时回落到桌面端的网关。 */
export function globalBase(domain: string | undefined): string {
	const lowered = (domain ?? '').trim().toLowerCase();
	if (lowered === 'codebuddy.ai' || lowered.endsWith('.codebuddy.ai')) {
		return 'https://www.codebuddy.ai';
	}
	return REGIONS.global.baseUrl;
}

/** 该凭据实际要访问的 chat 网关。 */
export function chatBaseOf(credential: { domain?: string } | undefined): string {
	const domain = credential?.domain;
	return regionOf(domain) === 'global' ? globalBase(domain) : REGIONS.cn.baseUrl;
}

/** Origin / Referer 用的站点：国内指向 www.codebuddy.cn。 */
function originReferer(credential: { domain?: string }): string {
	return regionOf(credential.domain) === 'global' ? globalBase(credential.domain) : GLOBAL_CN_SITE;
}

/** 国内站点的 Origin/Referer 主机，与 CN chat 网关不同。 */
const GLOBAL_CN_SITE = 'https://www.codebuddy.cn';

// ---------------------------------------------------------------------------
// 模型目录（移植自 dsh-connect-workbuddy/src/upstream.ts 的 fetchModels）
// ---------------------------------------------------------------------------

/**
 * 远程产品配置：CN 的首选模型目录，GLOBAL 的唯一来源。与旧目录文档字段兼容，
 * 一个解析器同时服务两者。CN 上正是 App 自己读的这份，所以本扩展的模型列表
 * 与 App 一致——这个一致性就是优先选它的原因。
 */
export const CONFIG_PATH = '/v3/config';

/** 旧的个人模型目录；`/v3` 失败时国内区的回退。 */
export const MODELS_CATALOG_PATH = '/v2/enterprises/personal/models';

/**
 * 桌面端 App 的 UA。
 *
 * `/v3/config` 按客户端渠道返回**不同的**产品配置。国际网关上这个差异决定哪些
 * 模型存在：CLI 渠道漏掉 `deepseek-v4.1-flash` / `gpt-6-astra`，桌面渠道则包含
 * 它们。本扩展模仿 CLI 渠道发 chat，但读桌面渠道的配置来获知账号真实模型列表。
 * 国内网关不需要这个开关。
 */
export const DESKTOP_UA = 'WorkBuddy/5.5.2';

export const JSON_TIMEOUT_MS = 30_000;

/** `reasoning` 字段归一后的形状（两种上游拼写都收敛到这里）。 */
export interface ReasoningInfo {
	/** 该模型接受的档位；`off` 不在其中，它由 canDisableThinking 单独管 */
	supportedEfforts: string[];
	/** 上游默认档位，不传 reasoning_effort 时用 */
	defaultEffort?: string;
	/** 是否接受 `reasoning_effort: 'off'`（关思考） */
	canDisableThinking?: boolean;
	/** 上游只给了单数 `effort` 且没给档位表：说明整条档位都可用 */
	singular?: boolean;
}

/** 上游返回的一个模型（只用得到的字段）。 */
export interface UpstreamModel {
	id: string;
	name: string;
	/** 上下文窗口 */
	contextWindow: number;
	/** 单次最大输出 */
	maxTokens: number;
	/** 计费倍率，如 x0.29 credits 的 0.29 */
	creditMultiplier?: number;
	supportsImages?: boolean;
	supportsToolCall?: boolean;
	/** `reasoning` 声明的档位 */
	efforts?: string[];
	reasoning?: ReasoningInfo;
}

/** 单数 `effort` 形态的模型实测接受整条档位（原项目 issue #7）。 */
export const SINGULAR_EFFORT_LADDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * 声明 `canDisableThinking: true` 却拒绝 `reasoning_effort: 'off'` 的模型 id
 * （原项目 issue #34，从 dsh-connect-workbuddy/src/off-thinking.ts 移植）。
 *
 * 按精确 id 而不是区域划分：拒绝与否跟模型家族走，不跟网关走。这里带来的成本并不对称：
 * 提供一个总会失败的档位会让该模型**每个请求**都失败，而多藏一个本可用的档位只损失一个选项，
 * 所以这张表宁可多藏。
 */
export const REFUSES_OFF_MODEL_IDS: ReadonlySet<string> = new Set([
	'deepseek-v4.1-flash',
	'deepseek-v4.1-flash-sg',
	'deepseek-v4-pro',
	'primary-model',
	'gpt-6-astra',
	'gpt-5.6-sol',
	'gpt-5.6-terra',
	'gpt-5.6-luna',
	'gemini-3.5-flash',
]);

/** 解析 `credits` 字符串的倍率；解析不出来就不给值，不瞎猜。 */
export function parseCreditMultiplier(value: unknown): number | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const match = /x\s*([0-9]*\.?[0-9]+)/iu.exec(value);
	if (match === null) {
		return undefined;
	}
	const parsed = Number(match[1]);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** 解析 reasoning 元数据；两种拼写（复数 supportedEfforts / 单数 effort）都归一。 */
export function parseReasoning(value: unknown): ReasoningInfo | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return undefined;
	}
	const raw = value as Record<string, unknown>;
	const effort = typeof raw['effort'] === 'string' ? raw['effort'] : undefined;
	const singular =
		effort !== undefined &&
		!Array.isArray(raw['supportedEfforts']) &&
		typeof raw['defaultEffort'] !== 'string' &&
		typeof raw['canDisableThinking'] !== 'boolean';
	let supportedEfforts: string[] = [];
	if (Array.isArray(raw['supportedEfforts'])) {
		supportedEfforts = raw['supportedEfforts'].filter((e): e is string => typeof e === 'string');
	} else if (effort !== undefined) {
		supportedEfforts = [...SINGULAR_EFFORT_LADDER];
	}
	const declaredDefault = typeof raw['defaultEffort'] === 'string' ? raw['defaultEffort'] : effort;
	const canDisableThinking =
		typeof raw['canDisableThinking'] === 'boolean'
			? raw['canDisableThinking']
			: singular
				? true
				: undefined;
	if (supportedEfforts.length === 0 && declaredDefault === undefined && canDisableThinking === undefined) {
		return undefined;
	}
	return {
		supportedEfforts,
		...(declaredDefault === undefined ? {} : { defaultEffort: declaredDefault }),
		...(canDisableThinking === undefined ? {} : { canDisableThinking }),
		...(singular ? { singular: true } : {}),
	};
}

/**
 * 该模型实际可用的推理档位。`off` 只在声明允许、且不在 {@link REFUSES_OFF_MODEL_IDS} 里时给出。
 */
export function usableEfforts(id: string, reasoning: ReasoningInfo | undefined): string[] {
	if (reasoning === undefined) {
		return [];
	}
	const out = [...reasoning.supportedEfforts];
	if (reasoning.canDisableThinking === true && !REFUSES_OFF_MODEL_IDS.has(id)) {
		out.push('off');
	}
	return out;
}

/**
 * 实际要发给上游的 `reasoning_effort`。
 *
 * **必须显式发送**：实测（2026-10-20，CN 网关）`glm-5.1` 在**不传**该字段时返回
 * `400 code=11150 "the reasoning effort value is not supported by the current model"`，
 * 传 low/high/max/off 全部 200 —— 说明这个模型自己没有可用的默认档位，
 * 依赖上游默认等于把该模型永久废掉。
 *
 * 优先用调用方请求的档位，其次上游声明的默认档位，最后从档位表里取一个。
 */
export function resolveReasoningEffort(
	model: UpstreamModel,
	requested?: string,
): string | undefined {
	const usable = usableEfforts(model.id, model.reasoning);
	if (usable.length === 0) {
		return undefined;
	}
	if (requested !== undefined && usable.includes(requested)) {
		return requested;
	}
	const fallback =
		model.reasoning?.defaultEffort ??
		usable.find(level => level !== 'off') ??
		usable[0];
	return usable.includes(fallback) ? fallback : usable[0];
}

/** 解析一条目录记录；没有可用 token 上限的条目丢弃。 */
export function parseUpstreamModel(value: unknown): UpstreamModel | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const raw = value as Record<string, unknown>;
	const id = typeof raw['id'] === 'string' ? raw['id'] : '';
	if (id === '' || raw['disabled'] === true) {
		return undefined;
	}
	const input = typeof raw['maxInputTokens'] === 'number' ? raw['maxInputTokens'] : 0;
	const output = typeof raw['maxOutputTokens'] === 'number' ? raw['maxOutputTokens'] : 0;
	// 生图模型（hunyuan-image-alpha 等）没有文本 token 上限，在 Chat 里根本用不了。
	if (input <= 0 || output <= 0) {
		return undefined;
	}
	const name = typeof raw['name'] === 'string' && raw['name'] !== '' ? raw['name'] : id;
	const creditMultiplier = parseCreditMultiplier(raw['credits']);
	const supportsImages =
		raw['disabledMultimodal'] === true
			? false
			: typeof raw['supportsImages'] === 'boolean'
				? raw['supportsImages']
				: undefined;
	const supportsToolCall = typeof raw['supportsToolCall'] === 'boolean' ? raw['supportsToolCall'] : undefined;
	const reasoning = parseReasoning(raw['reasoning']);
	const efforts = reasoning === undefined || reasoning.supportedEfforts.length === 0 ? undefined : reasoning.supportedEfforts;
	const out: UpstreamModel = {
		id,
		name,
		contextWindow: input,
		maxTokens: output,
		...(creditMultiplier === undefined ? {} : { creditMultiplier }),
		...(supportsImages === undefined ? {} : { supportsImages }),
		...(supportsToolCall === undefined ? {} : { supportsToolCall }),
		...(efforts === undefined ? {} : { efforts }),
	};
	// 单数形态也要带上：它的 defaultEffort 就是上游声明的档位。
	// 之前这里按 `!singular` 跳过了，结果 glm-5.1 / glm-5.2 / hy3-x 这些
	// 单数形态的模型一个档位都发不出去，glm-5.1 直接 400 code=11150。
	if (reasoning !== undefined) {
		out.reasoning = reasoning;
	}
	return out;
}

/**
 * 从目录文档里挑出可对话的模型：先解析每条，再按 `cli` agent 声明的顺序保留。
 *
 * 没有可用的 `cli` 名单时暴露整份目录，而不是什么都不给——名单是可能变化的上游
 * 细节，空结果会静默地把 provider 废掉。
 */
export function selectCliModels(rawModels: unknown, agents: unknown): UpstreamModel[] {
	const byId = new Map<string, UpstreamModel>();
	for (const model of Array.isArray(rawModels) ? rawModels : []) {
		const parsed = parseUpstreamModel(model);
		if (parsed !== undefined) {
			byId.set(parsed.id, parsed);
		}
	}
	let cliIds: readonly string[] | undefined;
	for (const agent of Array.isArray(agents) ? agents : []) {
		if (typeof agent === 'object' && agent !== null) {
			const wrapped = agent as Record<string, unknown>;
			if (wrapped['name'] === 'cli' && Array.isArray(wrapped['models'])) {
				cliIds = wrapped['models'].filter((id): id is string => typeof id === 'string');
				break;
			}
		}
	}
	const ids = cliIds !== undefined && cliIds.length > 0 ? cliIds : [...byId.keys()];
	const models = ids
		.map(id => byId.get(id))
		.filter((model): model is UpstreamModel => model !== undefined);
	if (models.length === 0) {
		// 空名单是"这份文档没给东西"，交给 fetchModels 走回退；
		// 调用方自己拼信息时还能用上这里的原因。
		throw new Error('模型目录解析出空名单（models/agents 为空，或条目都缺 token 上限）');
	}
	return models;
}

/** 读一份目录文档并转成模型列表。 */
async function readCatalog(
	url: string,
	credential: { apiKey: string; uid?: string; domain?: string },
	extraHeaders: Record<string, string>,
): Promise<UpstreamModel[]> {
	const response = await fetch(url, {
		headers: {
			Authorization: `Bearer ${credential.apiKey}`,
			Accept: 'application/json',
			'X-Requested-With': 'XMLHttpRequest',
			...credential.uid === undefined || credential.uid === '' ? {} : { 'X-User-Id': credential.uid },
			...credential.domain === undefined || credential.domain === '' ? {} : { 'X-Domain': credential.domain },
			'X-Product': 'SaaS',
			...extraHeaders,
		} as Record<string, string>,
		signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`模型目录 ${url} 返回 ${response.status}`);
	}
	const document = (await response.json()) as Record<string, unknown>;
	if (typeof document['code'] === 'number' && document['code'] !== 0) {
		throw new Error(`模型目录 ${url} 业务错误 ${String(document['code'])}: ${String(document['msg'] ?? '')}`);
	}
	const data =
		typeof document['data'] === 'object' && document['data'] !== null
			? (document['data'] as Record<string, unknown>)
			: {};
	return selectCliModels(data['models'], data['agents']);
}

/**
 * 读取该凭据所属区域的模型目录。
 *
 * 两个区域都优先 `/v3/config`（App 自己消费的文档），但请求它的 UA 不同、而且这个
 * 差异是关键的：`/v3` 按客户端渠道返回不同名单。国内用 CLI 形态（{@link CLIENT_UA}），
 * 用桌面 UA 会被网关以 `400 / 12403 check ua` 拒掉。`/v3` 失败或名单为空时国内回退到
 * 旧路径，让"停用了新文档"的网关降级到上一份名单，而不是让区域变空。
 */
export async function fetchModels(
	credential: { apiKey: string; uid?: string; domain?: string },
	onFallback?: (message: string) => void,
): Promise<UpstreamModel[]> {
	const base = chatBaseOf(credential);
	const isGlobal = regionOf(credential.domain) === 'global';
	const configHeaders: Record<string, string> = {
		'User-Agent': isGlobal ? DESKTOP_UA : CLIENT_UA,
		Origin: originReferer(credential),
		Referer: `${originReferer(credential)}/`,
	};
	if (isGlobal) {
		return readCatalog(`${base}${CONFIG_PATH}`, credential, configHeaders);
	}
	try {
		return await readCatalog(`${base}${CONFIG_PATH}`, credential, configHeaders);
	} catch (configError) {
		// 国内 `/v3` 常常返回"成功但空的名单"——`models: null`、`agents: null`、
		// 没有任何错误码（2026-10-20 实测）。这不是异常，而是这份文档对本渠道
		// 什么都没给，必须当成失败去走回退，否则国内账号一个模型都看不到。
		onFallback?.(
			`模型目录 ${CONFIG_PATH} 不可用，回退到 ${MODELS_CATALOG_PATH}: ${configError instanceof Error ? configError.message : String(configError)}`,
		);
		const fallbackBase = globalBase(credential.domain);
		return readCatalog(`${fallbackBase}${MODELS_CATALOG_PATH}`, credential, configHeaders);
	}
}

/** 随每条上游请求发送的公共头。 */
export function commonHeaders(credential: { domain?: string }): Record<string, string> {
	const site = originReferer(credential);
	return {
		'Accept': 'application/json, text/plain, */*',
		'X-Requested-With': 'XMLHttpRequest',
		'Origin': site,
		'Referer': `${site}/`,
		'User-Agent': CLIENT_UA,
	};
}

/**
 * 会话身份三元组：chat 端点现在强制要求（上游业务码 11128 / conversation id missing）。
 *
 * 网关并不校验这三个 id 的来源，任何合法 UUID 都能通过，所以它们不是秘密、也不
 * 持久化；但必须每条请求新生成，与官方客户端每次 `randomUUID()` 的行为一致。
 * 三个都要给：只带 `X-Conversation-ID` 仍然会被拒。
 *
 * 国内网关目前容忍它们缺失，仍然两边都发——只在一边生效的头，正是历史上国际区
 * 才复现的缺陷的成因。
 */
function conversationHeaders(): Record<string, string> {
	return {
		'X-Conversation-ID': randomUUID(),
		'X-Conversation-Request-ID': randomUUID(),
		'X-Conversation-Message-ID': randomUUID(),
	};
}

/** chat 请求头，含官方 CLI 使用的 X-No-* 约定。 */
export function chatHeaders(credential: {
	domain?: string;
	uid?: string;
	uin?: string;
	enterpriseId?: string;
}): Record<string, string> {
	const uid = credential.uid ?? '';
	const enterpriseId = credential.enterpriseId ?? '';
	const domain = credential.domain ?? '';
	return {
		...commonHeaders(credential),
		'Content-Type': 'application/json',
		// 安全红线：chat 请求绝不携带 refresh token。
		...(uid === '' ? { 'X-No-User-Id': '1' } : { 'X-User-Id': uid }),
		...(enterpriseId === '' ? { 'X-No-Enterprise-Id': '1' } : { 'X-Enterprise-Id': enterpriseId }),
		...(domain === '' ? { 'X-No-Department-Info': '1' } : { 'X-Domain': domain }),
		'X-Product': 'SaaS',
		...conversationHeaders(),
	};
}

// ---------------------------------------------------------------------------
// 计费网关（额度查询）
// ---------------------------------------------------------------------------

/** 国内账号的计费网关；国际账号走其 globalBase。 */
const CN_BILLING_BASE = 'https://www.codebuddy.cn';

/**
 * 额度查询打的是**计费网关**，和 chat 网关是两个主机。
 *
 * 国际账号有自己的计费入口（globalBase），国内统一在 www.codebuddy.cn。
 */
export function billingBase(credential: { domain?: string }): string {
	return regionOf(credential.domain) === 'global' ? globalBase(credential.domain) : CN_BILLING_BASE;
}

/**
 * 计费接口的请求头。
 *
 * 和 chat 不同：不带会话三元组、不带 X-Product，但要把 enterpriseId 同时填进
 * `X-Tenant-Id`。原项目实测这套头才被计费侧接受。
 */
export function billingHeaders(credential: {
	apiKey: string;
	domain?: string;
	uid?: string;
	enterpriseId?: string;
}): Record<string, string> {
	const headers: Record<string, string> = {
		'Authorization': `Bearer ${credential.apiKey}`,
		'Accept': 'application/json',
		'Content-Type': 'application/json',
	};
	if (credential.uid !== undefined && credential.uid !== '') {
		headers['X-User-Id'] = credential.uid;
	}
	if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
		headers['X-Enterprise-Id'] = credential.enterpriseId;
		headers['X-Tenant-Id'] = credential.enterpriseId;
	}
	if (credential.domain !== undefined && credential.domain !== '') {
		headers['X-Domain'] = credential.domain;
	}
	return headers;
}

// ---------------------------------------------------------------------------
// OpenAI 兼容的 chat 请求 / 响应
// ---------------------------------------------------------------------------

/** chat 流式响应里的一条事件。 */
export type StreamEvent =
	| { kind: 'text'; text: string }
	| { kind: 'thinking'; text: string }
	| { kind: 'toolCall'; index: number; callId: string; name: string; argumentsJson: string }
	| { kind: 'usage'; inputTokens?: number; outputTokens?: number }
	| { kind: 'error'; message: string }
	| { kind: 'done' };

export interface WireToolCall {
	id: string;
	name: string;
	/** 已拼好的 JSON 字符串 */
	argumentsJson: string;
}

export interface WireMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	/** 纯文本内容；有 tool_calls 的 assistant 消息可以为 undefined */
	content?: string;
	toolCalls?: WireToolCall[];
	/** role === 'tool' 时必填 */
	toolCallId?: string;
	/** 多模态内容；有图片时 content 变成 part 数组 */
	parts?: Array<{ type: 'text'; text: string } | { type: 'image_url'; dataUrl: string }>;
}

export interface WireTool {
	name: string;
	description: string;
	/** 原始 JSON schema 字符串 */
	parametersJson: string;
}

export interface WireRequest {
	model: string;
	messages: WireMessage[];
	tools?: WireTool[];
	temperature?: number;
	maxOutputTokens?: number;
	/**
	 * 推理档位。**必须显式给**：不给时上游会用自己的默认值，而 `glm-5.1`
	 * 实测没有可用默认值，会直接 400（见 {@link resolveReasoningEffort}）。
	 */
	reasoningEffort?: string;
	/** tool_choice: 'required' 时强制调用工具 */
	requireToolCall?: boolean;
}

/**
 * 把请求转成上游要的 OpenAI JSON 字符串。
 *
 * 这里**不做** lark/protobuf 编码：实测以标准 OpenAI JSON 请求
 * `POST /v2/chat/completions` 会直接返回标准 SSE（`data: {...}`），
 * 之前那套 protobuf 编码是错的方向。
 */
export function encodeChatRequest(req: WireRequest): string {
	const body: Record<string, unknown> = {
		model: req.model,
		messages: req.messages.map(message => {
			const out: Record<string, unknown> = { role: message.role };
			if (message.parts !== undefined && message.parts.length > 0) {
				out['content'] = message.parts.map(part =>
					part.type === 'text'
						? { type: 'text', text: part.text }
						: { type: 'image_url', image_url: { url: part.dataUrl } },
				);
			} else if (message.content !== undefined) {
				out['content'] = message.content;
			} else {
				out['content'] = null;
			}
			if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
				out['tool_calls'] = message.toolCalls.map(call => ({
					id: call.id,
					type: 'function',
					function: { name: call.name, arguments: call.argumentsJson },
				}));
			}
			if (message.toolCallId !== undefined) {
				out['tool_call_id'] = message.toolCallId;
			}
			return out;
		}),
		stream: true,
		stream_options: { include_usage: true },
	};
	if (req.temperature !== undefined) {
		body['temperature'] = req.temperature;
	}
	if (req.maxOutputTokens !== undefined) {
		body['max_tokens'] = req.maxOutputTokens;
	}
	if (req.reasoningEffort !== undefined) {
		body['reasoning_effort'] = req.reasoningEffort;
	}
	if (req.tools !== undefined && req.tools.length > 0) {
		body['tools'] = req.tools.map(tool => ({
			type: 'function',
			function: {
				name: tool.name,
				description: tool.description,
				parameters: safeParseJson(tool.parametersJson, { type: 'object', properties: {} }),
			},
		}));
		if (req.requireToolCall === true) {
			body['tool_choice'] = 'required';
		}
	}
	return JSON.stringify(body);
}

function safeParseJson(text: string, fallback: unknown): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return fallback;
	}
}

/**
 * 解析一行 SSE 的 data 载荷。非 JSON 或 `[DONE]` 时返回空数组 / 结束事件。
 *
 * 实测的上游 chunk 形状（标准 OpenAI）：
 *   {"id":"…","model":"deepseek-v4-pro","object":"chat.completion.chunk",
 *    "choices":[{"index":0,"delta":{"role":"assistant","content":"",
 *    "reasoning_content":"",…}}]}
 */
export function decodeJsonEvent(payload: string): StreamEvent[] {
	const trimmed = payload.trim();
	if (trimmed === '') {
		return [];
	}
	if (trimmed === '[DONE]') {
		return [{ kind: 'done' }];
	}
	let obj: any;
	try {
		obj = JSON.parse(trimmed);
	} catch {
		return [];
	}
	if (obj?.error !== undefined) {
		const message =
			typeof obj.error === 'string' ? obj.error : String(obj.error?.message ?? JSON.stringify(obj.error));
		return [{ kind: 'error', message }];
	}
	const out: StreamEvent[] = [];
	const choice = obj?.choices?.[0];
	const delta = choice?.delta ?? choice?.message;
	if (typeof delta?.content === 'string' && delta.content !== '') {
		out.push({ kind: 'text', text: delta.content });
	}
	if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content !== '') {
		out.push({ kind: 'thinking', text: delta.reasoning_content });
	}
	for (const call of delta?.tool_calls ?? []) {
		// 分片到达：首片带 id/name，后续片只有 arguments 的增量，
		// 所以 name 允许为空、arguments 这里是**片段**而不是完整 JSON。
		out.push({
			kind: 'toolCall',
			index: typeof call?.index === 'number' ? call.index : 0,
			callId: typeof call?.id === 'string' ? call.id : '',
			name: typeof call?.function?.name === 'string' ? call.function.name : '',
			argumentsJson: typeof call?.function?.arguments === 'string' ? call.function.arguments : '',
		});
	}
	if (obj?.usage !== undefined && obj.usage !== null) {
		out.push({
			kind: 'usage',
			inputTokens: typeof obj.usage.prompt_tokens === 'number' ? obj.usage.prompt_tokens : undefined,
			outputTokens: typeof obj.usage.completion_tokens === 'number' ? obj.usage.completion_tokens : undefined,
		});
	}
	if (typeof choice?.finish_reason === 'string' && choice.finish_reason !== '') {
		out.push({ kind: 'done' });
	}
	return out;
}

export const textPart = (text: string): WireMessage => ({ role: 'user', content: text });
export const toolCallPart = (callId: string, name: string, args: string): WireToolCall => ({
	id: callId,
	name,
	argumentsJson: args,
});
