/**
 * Server-Sent Events（text/event-stream）增量解析。
 *
 * 上游（WorkBuddy 网关）发的是标准 OpenAI SSE：
 *   data: {"id":"…","choices":[{"delta":{"content":"…"}}]}
 *   data: [DONE]
 * 偶尔夹着注释行 `:keepalive`，这里一并跳过。
 *
 * 这个模块只做 SSE 框切分，不涉及任何二进制 / protobuf 编解码。
 */
export class SseDecoder {
	private buffer = '';

	/** 喂入一段 UTF-8 文本，返回本次完整解析出的事件。 */
	push(chunk: string): Array<{ event?: string; data: string }> {
		this.buffer += chunk;
		const events: Array<{ event?: string; data: string }> = [];
		let idx: number;
		// SSE 事件之间用空行分隔，兼容 \r\n
		while ((idx = this.buffer.search(/\r?\n\r?\n/)) !== -1) {
			const raw = this.buffer.slice(0, idx);
			this.buffer = this.buffer.slice(idx).replace(/^\r?\n\r?\n/, '');
			const evt = this.parseBlock(raw);
			if (evt) {
				events.push(evt);
			}
		}
		return events;
	}

	/** 冲刷尾部残留（连接关闭时调用）。 */
	flush(): Array<{ event?: string; data: string }> {
		const rest = this.buffer.trim();
		this.buffer = '';
		if (!rest) {
			return [];
		}
		const evt = this.parseBlock(rest);
		return evt ? [evt] : [];
	}

	private parseBlock(raw: string): { event?: string; data: string } | undefined {
		let event: string | undefined;
		const dataLines: string[] = [];
		for (const line of raw.split(/\r?\n/)) {
			if (!line || line.startsWith(':')) {
				continue;
			}
			if (line.startsWith('event:')) {
				event = line.slice(6).trim();
			} else if (line.startsWith('data:')) {
				dataLines.push(line.slice(5).replace(/^ /, ''));
			} else if (!line.startsWith('id:') && !line.startsWith('retry:')) {
				// 少数网关直接把裸 JSON 当一行发，没有 data: 前缀
				dataLines.push(line);
			}
		}
		if (dataLines.length === 0) {
			return undefined;
		}
		return { event, data: dataLines.join('\n') };
	}
}