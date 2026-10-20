/**
 * 把 WorkBuddy 的 bytebuddy 网关包装成 VS Code 的 LanguageModelChatProvider，
 * 这样在 Copilot Chat 的模型选择器里就能直接选 WorkBuddy 的模型。
 *
 * 关键点：
 *  - VS Code 1.104+ 提供 `lm.registerLanguageModelChatProvider(vendor, provider)`，
 *    用户选中的模型会被 Copilot Chat 直接调用。
 *  - 上游只认 WorkBuddy 桌面端登录后的 token，所以 key 由 auth.ts 自动从
 *    桌面端配置文件里发现，用户基本不需要手动填。
 *  - 流式响应用 fetch + SSE 解析，逐段通过 progress.report() 推给 Copilot Chat。
 */

import * as vscode from 'vscode';
import { createHash } from 'crypto';
import { SseDecoder } from './lark';
import {
	CHAT_PATH,
	REGIONS,
	RegionConfig,
	RegionKey,
	REGION_KEYS,
	UpstreamModel,
	WireMessage,
	WireTool,
	WireToolCall,
	decodeJsonEvent,
	encodeChatRequest,
	resolveReasoningEffort,
	usableEfforts,
	textPart,
	toolCallPart,
	chatBaseOf,
	chatHeaders,
	fetchModels,
	regionOf,
} from './protocol';
import { lastCredentialFailure, lastProbedPaths, resolveCredential } from './auth';

/** 模型元信息（用于选择器展示和 token 预算）。 */
interface ModelSpec {
	id: string;
	name: string;
	family: string;
	version: string;
	maxInputTokens: number;
	maxOutputTokens: number;
	toolCalling: boolean;
	imageInput: boolean;
	/** 该模型实际接受的推理档位（含可能的 `off`） */
	efforts: string[];
}

/**
 * 模型列表缓存时长。
 *
 * 模型清单由上游按账号/渠道下发，写死一份会和 WorkBuddy 里显示的完全不同；拉取
 * 失败时退回上一次成功的结果，而不是给一份猜出来的清单（用不存在的模型名请求
 * chat 会被网关当成 401 `{"message":"not_found"}`）。
 */
const MODELS_TTL_MS = 5 * 60 * 1000;

/** 粗粒度 token 估算：英文约 4 字符/token，中文约 1.5 字符/token。 */
export function estimateTokens(text: string): number {
	if (!text) {
		return 0;
	}
	let wideChars = 0;
	for (const ch of text) {
		if (ch.charCodeAt(0) > 0x2e80) {
			wideChars++;
		}
	}
	const asciiChars = text.length - wideChars;
	return Math.ceil(asciiChars / 4 + wideChars / 1.5);
}

/** 把 VS Code 的消息内容拍平成文本（token 计数 / tool 结果用）。 */
function flattenContent(content: ReadonlyArray<unknown>): string {
	const parts: string[] = [];
	for (const part of content) {
		const text = partText(part);
		if (text !== undefined) {
			parts.push(text);
		}
	}
	return parts.join('\n');
}

/**
 * 把单个 part 转成文本。
 * 用鸭子类型而不是 instanceof：不同 VS Code 版本 / 不同扩展宿主里
 * 拿到的类实例不一定和本模块的 vscode 引用严格相等。
 */
function partText(part: unknown): string | undefined {
	if (typeof part === 'string') {
		return part;
	}
	if (!part || typeof part !== 'object') {
		return undefined;
	}
	const anyPart = part as any;
	if (typeof anyPart.value === 'string') {
		return anyPart.value; // LanguageModelTextPart
	}
	if (Array.isArray(anyPart.content)) {
		// LanguageModelToolResultPart
		return flattenContent(anyPart.content);
	}
	if (typeof anyPart.name === 'string' && anyPart.input !== undefined) {
		// LanguageModelToolCallPart
		return `[tool ${anyPart.name} ${JSON.stringify(anyPart.input)}]`;
	}
	return undefined;
}

/** part 是不是一个工具调用。 */
function asToolCall(part: unknown): { callId: string; name: string; input: unknown } | undefined {
	const anyPart = part as any;
	if (!anyPart || typeof anyPart !== 'object') {
		return undefined;
	}
	if (typeof anyPart.callId === 'string' && typeof anyPart.name === 'string') {
		return { callId: anyPart.callId, name: anyPart.name, input: anyPart.input ?? {} };
	}
	return undefined;
}

/** part 是不是一个工具结果（user 消息里出现）。 */
function asToolResult(part: unknown): { callId: string; text: string } | undefined {
	const anyPart = part as any;
	if (!anyPart || typeof anyPart !== 'object') {
		return undefined;
	}
	if (typeof anyPart.callId === 'string' && Array.isArray(anyPart.content)) {
		return { callId: anyPart.callId, text: flattenContent(anyPart.content) };
	}
	return undefined;
}

/** 从 DataPart 里挖图片，返回 OpenAI 的 image_url 内容段。 */
function isImagePart(part: unknown): boolean {
	const anyPart = part as any;
	return (
		anyPart !== null &&
		typeof anyPart === 'object' &&
		typeof anyPart.mimeType === 'string' &&
		anyPart.mimeType.startsWith('image/') &&
		anyPart.data instanceof Uint8Array
	);
}

function imageParts(messages: readonly vscode.LanguageModelChatRequestMessage[]): Array<{ type: 'image_url'; dataUrl: string }> {
	const out: Array<{ type: 'image_url'; dataUrl: string }> = [];
	for (const msg of messages) {
		if (msg.role !== vscode.LanguageModelChatMessageRole.User) {
			continue;
		}
		for (const part of msg.content) {
			const anyPart = part as any;
			if (anyPart && typeof anyPart.mimeType === 'string' && anyPart.data instanceof Uint8Array) {
				if (anyPart.mimeType.startsWith('image/')) {
					out.push({
						type: 'image_url',
						dataUrl: `data:${anyPart.mimeType};base64,${Buffer.from(anyPart.data).toString('base64')}`,
					});
				}
			}
		}
	}
	return out;
}

/**
 * 把 VS Code 对话转成 OpenAI 的 messages 数组。
 *
 * 规则：
 *  - 以 <system>…</system> 包裹的文本提到最前面作为 system 消息
 *  - assistant 的工具调用 → `tool_calls`，user 的工具结果 → `role: "tool"`
 *  - 连续的工具结果合并成同一条 assistant 之后的多条 tool 消息
 *
 * **严格配对是硬要求**，不是最佳实践。上游部分模型（实测 `deepseek-v4.1-flash`、
 * `kimi-k2.8-preview`，而 `glm-5.1` 不校验）只要历史里出现"调用了却没结果"或
 * "结果对不上调用"，整个请求就直接 `400 code=11148 tool calls and tool results
 * do not match`。而这样的历史是常态：用户取消一次工具执行、切换到只输出文本的
 * 模型、或者某次调用被错误中断，都会留下悬空的 call。
 *
 * 实测确认的判定（用 deepseek-v4.1-flash 逐一验证）：
 *  - 结果 id 写错 → 400；结果条数多一条 → 400；两条调用只有一条结果 → 400
 *  - 只要每个 call 都有且只有一个**同 id** 的结果，历史里出现几次完整配对都无所谓
 * 所以这里按 id 精确配对：孤立的 call 用占位结果补齐，找不到调用方的结果直接丢弃。
 */
function convertMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): {
	system: string[];
	wire: WireMessage[];
} {
	const system: string[] = [];
	const wire: WireMessage[] = [];

	for (const msg of messages) {
		const isUser = msg.role === vscode.LanguageModelChatMessageRole.User;

		const textChunks: string[] = [];
		const toolCalls: WireToolCall[] = [];
		const toolResults: Array<{ callId: string; text: string }> = [];
		for (const part of msg.content) {
			const call = asToolCall(part);
			if (call !== undefined) {
				toolCalls.push(toolCallPart(call.callId, call.name, JSON.stringify(call.input ?? {})));
				continue;
			}
			const result = asToolResult(part);
			if (result !== undefined) {
				toolResults.push(result);
				continue;
			}
			const text = partText(part);
			if (text === undefined) {
				continue;
			}
			const sysMatch = /^<system>([\s\S]*)<\/system>$/.exec(text.trim());
			if (isUser && sysMatch) {
				system.push(sysMatch[1].trim());
				continue;
			}
			textChunks.push(text);
		}

		const content = textChunks.join('');

		// 工具结果**紧跟着**它的调用方发出，既不能攒到下一个 user 轮次，
		// 也不能越过中间的 assistant 消息——那样上游会说配对不上。
		for (const result of toolResults) {
			wire.push({ role: 'tool', toolCallId: result.callId, content: result.text });
		}

		// 只有工具结果的 user 消息不该变成一轮 user 输入，否则每轮工具调用后面
		// 都会多出一条空的 user 消息，历史很快就不像话了。
		if (isUser ? !hasUserPayload(msg) : content === '' && toolCalls.length === 0) {
			continue;
		}
		wire.push({
			role: isUser ? 'user' : 'assistant',
			...(content === '' ? {} : { content }),
			...(toolCalls.length === 0 ? {} : { toolCalls }),
		});
	}
	return { system, wire };
}

/** 补进孤立工具调用的占位结果。上游拒绝空字符串，用一段说明代替。 */
const ORPHAN_TOOL_RESULT = '[no output]';

/** user 消息里只有工具结果、没有真正的用户文本时，这条消息不该变成 user 轮次。 */
function hasUserPayload(msg: vscode.LanguageModelChatRequestMessage): boolean {
	for (const part of msg.content) {
		if (asToolCall(part) !== undefined || asToolResult(part) !== undefined) {
			continue;
		}
		const text = partText(part);
		if (text === undefined) {
			// 图片也算用户输入，否则只有图片的消息会被整体丢掉。
			if (isImagePart(part)) {
				return true;
			}
			continue;
		}
		if (!/^<system>[\s\S]*<\/system>$/.test(text.trim()) && text.trim() !== '') {
			return true;
		}
	}
	return false;
}

/**
 * 把历史里所有工具调用/结果修成严格配对，别的消息原样保留。
 *
 * 为什么必须做：见 {@link convertMessages} 的说明。这里刻意不去猜测"用户到底想不想
 * 保留这段历史"，只做上游唯一接受的那种形态——孤立的 call 补占位结果，孤立的
 * 结果丢弃。结果消息会紧跟在它所属的 assistant 后面，不会隔着别的 user 轮次。
 */
export function pairToolCalls(wire: WireMessage[]): { wire: WireMessage[]; patchedCalls: number; droppedResults: number } {
	// 先给每个 assistant 里的 call 分配一个稳定的发生序号，因为同一个 callId
	// 可能在多轮里重复出现，按 id 全局配对会把结果配到错的轮次上。
	const occurrences = new Map<string, number[]>();
	wire.forEach((msg, index) => {
		for (const call of msg.toolCalls ?? []) {
			const list = occurrences.get(call.id) ?? [];
			list.push(index);
			occurrences.set(call.id, list);
		}
	});

	// 每条结果配到"最早一个还没被配上、且位置在它之前"的同类 call。
	const claimed = new Set<string>(); // `${index}:${callId}`
	const resultsByCallIndex = new Map<number, WireMessage[]>();
	let droppedResults = 0;
	// 认领过的结果要移出原位置，丢弃的结果要从输出里彻底删掉——
	// 只统计不删是没用的，上游收到孤立结果照样 400。
	const consumed = new Set<number>();

	wire.forEach((msg, index) => {
		if (msg.role !== 'tool') {
			return;
		}
		const callId = msg.toolCallId ?? '';
		const candidates = (occurrences.get(callId) ?? []).filter(at => at < index && !claimed.has(`${at}:${callId}`));
		const at = candidates[0];
		consumed.add(index);
		if (at === undefined) {
			// 没有调用方的结果：上游会判定 mismatch，直接丢弃。
			droppedResults++;
			return;
		}
		claimed.add(`${at}:${callId}`);
		const bucket = resultsByCallIndex.get(at) ?? [];
		bucket.push({ ...msg, toolCallId: callId });
		resultsByCallIndex.set(at, bucket);
	});

	// 重新拼装：assistant 后面紧跟它的结果；没被认领的 call 补占位结果。
	const out: WireMessage[] = [];
	let patchedCalls = 0;
	wire.forEach((msg, index) => {
		if (consumed.has(index)) {
			return; // 已经挂到对应 assistant 后面，或者已被判为孤立结果
		}
		out.push(msg);
		const calls = msg.toolCalls ?? [];
		if (calls.length === 0) {
			return;
		}
		const answered = resultsByCallIndex.get(index) ?? [];
		for (const call of calls) {
			const match = answered.find(result => result.toolCallId === call.id);
			if (match !== undefined) {
				out.push(match);
			} else {
				patchedCalls++;
				out.push({ role: 'tool', toolCallId: call.id, content: ORPHAN_TOOL_RESULT });
			}
		}
	});

	return { wire: out, patchedCalls, droppedResults };
}
/**
 * 单区域（cn / global）的 ChatProvider。
 */
export class WorkBuddyChatProvider implements vscode.LanguageModelChatProvider<vscode.LanguageModelChatInformation> {
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

	private models: ModelSpec[] | undefined;
	private modelsLoadedAt = 0;
	/** 上游解析结果，按 id 索引；发请求时用它算 reasoning_effort。 */
	private upstreamModels = new Map<string, UpstreamModel>();

	constructor(
		private readonly region: RegionKey,
		private readonly config: RegionConfig,
		private readonly output: vscode.OutputChannel,
	) {}

	/** 配置变更后让模型选择器刷新（比如刚填了 key）。 */
	refresh(): void {
		this.modelsLoadedAt = 0;
		this._onDidChange.fire();
	}

	/**
	 * 拉取该账号在 WorkBuddy 里的真实模型列表。
	 *
	 * 写死一份清单是不行的：账号能用哪些模型由上游按账号和渠道决定（实测本机 35 个，
	 * 和任何猜出来的清单都对不上），用不存在的模型名请求 chat 会被网关当成 401
	 * `{"message":"not_found"}`。留 5 分钟缓存；拉取失败时退回上一次成功的结果。
	 */
	private async loadModels(): Promise<ModelSpec[] | undefined> {
		const fresh = this.models !== undefined && Date.now() - this.modelsLoadedAt < MODELS_TTL_MS;
		if (fresh) {
			return this.models;
		}
		const credential = await resolveCredential();
		if (credential === undefined) {
			return this.models;
		}
		try {
			const upstream = await fetchModels(credential, message => this.output.appendLine(`[fallback] ${message}`));
			this.upstreamModels = new Map(upstream.map(m => [m.id, m]));
			this.models = upstream.map(m => ({
				id: m.id,
				name: m.name,
				family: m.id,
				version: '1',
				maxInputTokens: m.contextWindow,
				maxOutputTokens: m.maxTokens,
				toolCalling: m.supportsToolCall !== false,
				imageInput: m.supportsImages === true,
				efforts: usableEfforts(m.id, m.reasoning),
			}));
			this.modelsLoadedAt = Date.now();
			this.output.appendLine(`模型目录: ${this.models.length} 个 (${this.config.label})`);
			return this.models;
		} catch (error) {
			this.output.appendLine(
				`[error] 拉取模型目录失败: ${error instanceof Error ? error.message : String(error)}`,
			);
			return this.models;
		}
	}

	/** 让选择器里有模型可选；上游拿不到列表时返回上一次成功的结果。 */
	async provideLanguageModelChatInformation(
		_options: vscode.PrepareLanguageModelChatModelOptions,
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelChatInformation[]> {
		if (token.isCancellationRequested) {
			return [];
		}
		const models = await this.loadModels();
		if (models === undefined) {
			return [];
		}
		return models.map(m => ({
			id: `${this.config.vendor}/${m.id}`,
			name: m.name,
			family: m.family,
			version: m.version,
			detail: this.config.label,
			tooltip: `WorkBuddy · ${this.config.label}\n模型 ID: ${m.id}\n上下文: ${m.maxInputTokens.toLocaleString()} tokens`,
			maxInputTokens: m.maxInputTokens,
			maxOutputTokens: m.maxOutputTokens,
			capabilities: { toolCalling: m.toolCalling, imageInput: m.imageInput },
		}));
	}

	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const credential = await resolveCredential();
		if (!credential) {
			const failure = lastCredentialFailure;
			const probed = lastProbedPaths.length > 0 ? `\n已探测: ${lastProbedPaths.join(', ')}` : '';
			const why = failure?.message ? `\n原因: ${failure.message}` : '';
			throw new Error(
				`[WorkBuddy] 未找到 WorkBuddy 凭据。请先登录 WorkBuddy 桌面端，或设置环境变量 WORKBUDDY_API_KEY。${probed}${why}`,
			);
		}

		const modelId = model.id.includes('/') ? model.id.split('/').slice(1).join('/') : model.id;
		const converted = convertMessages(messages);
		const paired = pairToolCalls(converted.wire);
		const system = converted.system;
		const wire = paired.wire;
		if (paired.patchedCalls > 0 || paired.droppedResults > 0) {
			this.output.appendLine(
				`[pair] ${modelId}: 历史里有 ${paired.patchedCalls} 个工具调用没有结果（已补占位）、${paired.droppedResults} 个结果找不到调用方（已丢弃）`,
			);
		}
		const images = imageParts(messages);
		if (images.length > 0) {
			// 图片只能挂在最后一条 user 消息上，否则上游会当成多条用户输入。
			const lastUser = [...wire].reverse().find(m => m.role === 'user');
			if (lastUser !== undefined) {
				const text = lastUser.content ?? '';
				lastUser.parts = [...(text === '' ? [] : [{ type: 'text' as const, text }]), ...images];
				delete lastUser.content;
			}
		}

		const tools: WireTool[] = (options.tools ?? []).map(t => ({
			name: t.name,
			description: t.description,
			parametersJson: JSON.stringify(t.inputSchema ?? { type: 'object', properties: {} }),
		}));

		const temperature =
			typeof options.modelOptions?.temperature === 'number' ? (options.modelOptions.temperature as number) : undefined;

		const effort = this.reasoningEffortFor(modelId, options.modelOptions?.reasoningEffort);

		const body = encodeChatRequest({
			model: modelId,
			messages:
				system.length > 0
					? [{ role: 'system', content: system.join('\n\n') }, ...wire]
					: wire,
			tools: tools.length > 0 ? tools : undefined,
			temperature,
			maxOutputTokens: Math.min(model.maxOutputTokens, 16_000),
			reasoningEffort: effort,
			requireToolCall: options.toolMode === vscode.LanguageModelChatToolMode.Required,
		});

		// 网关地址跟随凭据自己的 domain：codebuddy.ai 签发的 token 只能打
		// www.codebuddy.ai，打到 workbuddy.ai 会被拒。
		const baseUrl = chatBaseOf(credential);

		this.output.appendLine(
			`[${new Date().toISOString()}] → ${baseUrl}${CHAT_PATH} model=${modelId} msgs=${wire.length + (system.length > 0 ? 1 : 0)} tools=${tools.length} key=${maskKey(credential.apiKey)} (${credential.source}, region=${regionOf(credential.domain)})`,
		);

		// 请求头原样移植自 dsh-connect-workbuddy/src/upstream.ts 的 chatHeaders()：
		// 官方 CLI 形态的公共头 + X-No-* 约定 + 会话身份三元组。
		const headers: Record<string, string> = {
			...chatHeaders(credential),
			Authorization: `Bearer ${credential.apiKey}`,
			'Accept': 'text/event-stream',
			'Content-Type': 'application/json',
		};

		const abort = new AbortController();
		const cancelSub = token.onCancellationRequested(() => abort.abort());

		let response: Response;
		try {
			response = await fetch(`${baseUrl}${CHAT_PATH}`, {
				method: 'POST',
				headers,
				body,
				signal: abort.signal,
			});
		} catch (err) {
			cancelSub.dispose();
			if (token.isCancellationRequested) {
				return;
			}
			throw new Error(`[WorkBuddy] 请求失败: ${(err as Error).message}`);
		}

		if (!response.ok) {
			cancelSub.dispose();
			const text = await response.text().catch(() => '');
			this.output.appendLine(`[error] HTTP ${response.status}: ${text.slice(0, 500)}`);
			if (response.status === 401 || response.status === 403) {
				throw new Error(`[WorkBuddy] 认证失败 (${response.status})：${text.slice(0, 300)}`);
			}
			throw new Error(`[WorkBuddy] 上游返回 ${response.status}: ${text.slice(0, 300)}`);
		}

		const contentType = response.headers.get('content-type') ?? '';
		try {
			if (!contentType.includes('text/event-stream')) {
				await this.consumeJsonResponse(response, progress, token);
			} else {
				await this.consumeSseResponse(response, progress, token);
			}
		} finally {
			cancelSub.dispose();
		}
	}

	private async consumeSseResponse(
		response: Response,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		if (!response.body) {
			throw new Error('[WorkBuddy] 上游没有返回响应体');
		}
		const reader = response.body.getReader();
		const decoder = new SseDecoder();
		const textDecoder = new Utf8StreamDecoder();
		let sawDone = false;

		// 工具调用是**分片**到达的：第一个 chunk 带 id + name，后续 chunk 只有
		// arguments 的片段（实测 callId/name 为空）。必须按 index 聚合，攒齐后
		// 一次性上报，否则 Copilot Chat 会收到一堆残缺的调用。
		const pendingCalls = new Map<number, { callId: string; name: string; args: string }>();
		const flushToolCalls = () => {
			if (pendingCalls.size === 0) {
				return;
			}
			const ordered = [...pendingCalls.entries()].sort((a, b) => a[0] - b[0]);
			pendingCalls.clear();
			for (const [, call] of ordered) {
				if (call.name === '') {
					continue;
				}
				progress.report(
					new vscode.LanguageModelToolCallPart(call.callId || randomCallId(), call.name, safeJson(call.args)),
				);
			}
		};

		const dispatch = (events: Array<{ event?: string; data: string }>) => {
			for (const evt of events) {
				if (sawDone) {
					continue;
				}
				const raw = evt.data.trim();
				if (raw === '[DONE]') {
					flushToolCalls();
					sawDone = true;
					continue;
				}
				if (raw === '') {
					continue;
				}
				const parsed = decodeJsonEvent(raw);
				for (const e of parsed) {
					switch (e.kind) {
						case 'text':
							progress.report(new vscode.LanguageModelTextPart(e.text));
							break;
						case 'thinking':
							this.output.appendLine(`[thinking] ${e.text}`);
							break;
						case 'toolCall': {
							const existing = pendingCalls.get(e.index) ?? { callId: '', name: '', args: '' };
							if (e.callId !== '') {
								existing.callId = e.callId;
							}
							if (e.name !== '') {
								existing.name = e.name;
							}
							existing.args += e.argumentsJson;
							pendingCalls.set(e.index, existing);
							break;
						}
						case 'usage':
							this.output.appendLine(
								`[usage] in=${e.inputTokens ?? '?'} out=${e.outputTokens ?? '?'}`,
							);
							break;
						case 'error':
							this.output.appendLine(`[upstream-error] ${e.message}`);
							throw new Error(`[WorkBuddy] 上游错误: ${e.message}`);
						case 'done':
							flushToolCalls();
							sawDone = true;
							break;
						default:
							break;
					}
				}
			}
		};

		try {
			for (;;) {
				if (token.isCancellationRequested) {
					await reader.cancel().catch(() => undefined);
					return;
				}
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				dispatch(decoder.push(textDecoder.push(value as Uint8Array)));
			}
			dispatch(decoder.push(textDecoder.flush()));
			dispatch(decoder.flush());
		} finally {
			reader.releaseLock();
		}
	}

	private async consumeJsonResponse(
		response: Response,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const text = await response.text();
		if (token.isCancellationRequested) {
			return;
		}
		let obj: any;
		try {
			obj = JSON.parse(text);
		} catch {
			progress.report(new vscode.LanguageModelTextPart(text));
			return;
		}
		const out = obj?.choices?.[0]?.message?.content ?? obj?.content ?? obj?.choices?.[0]?.text ?? '';
		if (typeof out === 'string' && out) {
			progress.report(new vscode.LanguageModelTextPart(out));
		}
	}

	/**
	 * 算这次请求该发哪个推理档位。
	 *
	 * 上游目录对档位的声明和实际行为有出入，所以这里不是简单照抄：先拿
	 * `options.modelOptions.reasoningEffort`，不在该模型的可接受集合里就退回
	 * 上游声明的默认档位。**不传是不行的**——`glm-5.1` 在没有默认档位时
	 * 会直接 400 `code=11150`（实测）。
	 */
	private reasoningEffortFor(modelId: string, requested: unknown): string | undefined {
		const upstream = this.upstreamModels.get(modelId);
		if (upstream === undefined) {
			return undefined;
		}
		const asked = typeof requested === 'string' ? requested : undefined;
		const effort = resolveReasoningEffort(upstream, asked);
		if (effort !== undefined && asked !== undefined && effort !== asked) {
			this.output.appendLine(`[reasoning] ${modelId}: ${asked} 不可用，改用 ${effort}`);
		}
		return effort;
	}

	async provideTokenCount(
		_model: vscode.LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatRequestMessage,
		_token: vscode.CancellationToken,
	): Promise<number> {
		if (typeof text === 'string') {
			return estimateTokens(text);
		}
		return estimateTokens(flattenContent(text.content));
	}
}

function maskKey(key: string): string {
	if (key.length <= 8) {
		return '***';
	}
	return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/**
 * 逐块解码响应体字节流（增量 UTF-8）。
 *
 * 这里不用 `new TextDecoder()`：tsconfig 的 lib 只开了 ES2022，
 * 没有 DOM / node:util 的类型，用 Buffer 手写一份即可。
 */
class Utf8StreamDecoder {
	private pending: Buffer = Buffer.alloc(0);

	push(chunk: Uint8Array): string {
		const buf = this.pending.length ? Buffer.concat([this.pending, Buffer.from(chunk)]) : Buffer.from(chunk);
		// 末尾若是一个不完整的 UTF-8 序列，先攒着等下一块
		let cut = buf.length;
		let back = 0;
		while (cut > 0 && back < 4) {
			const byte = buf[cut - 1];
			if ((byte & 0xc0) === 0x80) {
				cut--;
				back++;
				continue;
			}
			// 找到首字节，判断这个字符需要几字节
			let need = 1;
			if ((byte & 0xe0) === 0xc0) {
				need = 2;
			} else if ((byte & 0xf0) === 0xe0) {
				need = 3;
			} else if ((byte & 0xf8) === 0xf0) {
				need = 4;
			}
			if (back + 1 < need) {
				// 不完整，留到下一块
			} else {
				cut = buf.length;
			}
			break;
		}
		this.pending = buf.slice(cut);
		return buf.slice(0, cut).toString('utf8');
	}

	flush(): string {
		const rest = this.pending.toString('utf8');
		this.pending = Buffer.alloc(0);
		return rest;
	}
}

function safeJson(raw: string): object {
	try {
		const parsed = JSON.parse(raw);
		return typeof parsed === 'object' && parsed !== null ? parsed : { value: parsed };
	} catch {
		return { _raw: raw };
	}
}

function randomCallId(): string {
	return `call_${createHash('sha1').update(String(Date.now()) + Math.random()).digest('hex').slice(0, 12)}`;
}

/**
 * 注册两个区域（cn / global）的 provider。
 * @returns 供 extension.ts 在需要时刷新模型选择器用
 */
export function registerWorkBuddyProviders(
	context: vscode.ExtensionContext,
	output: vscode.OutputChannel,
): { providers: WorkBuddyChatProvider[]; notifyConfigChanged: () => void } {
	const providers: WorkBuddyChatProvider[] = [];
	for (const key of REGION_KEYS) {
		const provider = new WorkBuddyChatProvider(key, REGIONS[key], output);
		providers.push(provider);
		context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(REGIONS[key].vendor, provider));
	}
	return {
		providers,
		notifyConfigChanged: () => providers.forEach(p => p.refresh()),
	};
}
