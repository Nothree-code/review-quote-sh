// review-quote-sh (正式插件 v1.0) — Client 半
// 审查按钮 + 审查弹窗（多模型互审/历史回看）+ 引用胶囊 + 偏好记忆（Host 文件持久）
// 通信：fetch 调 Host 的 /review-quote-* HTTP 路由（见 lib/index.js）
// 格式：__ModuleLoader__ 模块（dsh.client 扫描加载，随页面存在，无需动态激活）

window.__ModuleLoader__.load({
	id: "review-quote-sh",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		// ======================= helpers =======================
		const hostCall = (method, args) => {
			return fetch("/review-quote-" + method, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(args || {}),
			}).then((r) => r.json());
		};
		const injectStyle = (cssText) => {
			const tag = document.createElement("style");
			tag.textContent = cssText;
			document.head.appendChild(tag);
			return () => { tag.remove(); };
		};

		// ======================= plugin =======================
		const apply = (ctx) => {
			const slots = ctx.slots;

			const SCOPES = [
				{ id: 'current', label: '当前消息' },
				{ id: 'last1', label: '最近 1 轮' },
				{ id: 'last3', label: '最近 3 轮' },
				{ id: 'last5', label: '最近 5 轮' },
				{ id: 'all', label: '全部对话' },
			];

			let reviewState = {
				open: false,
				loading: false,
				error: '',
				scope: 'current',
				scopeTexts: {},
				pendingText: '',
				options: [],
				selectedModels: [],
				reports: {},
				currentJobIds: [],
				inputActions: null,
				sentDraft: false,
				view: 'main',
				history: [],
				historyIndex: null,
			};
			let activePollTimer = null;
			let prefs = { modelKeys: null, scope: 'current' };
			const HISTORY_MAX = 5;
			const listeners = new Set();
			const setState = (patch) => {
				reviewState = Object.assign({}, reviewState, patch);
				listeners.forEach((fn) => fn(reviewState));
			};
			const subscribe = (fn) => {
				listeners.add(fn);
				fn(reviewState);
				return () => { listeners.delete(fn); };
			};

			// ---- Quote chips above the composer ----
			let quotes = [];
			let quoteSeq = 0;
			const quoteListeners = new Set();
			const notifyQuotes = () => { quoteListeners.forEach((fn) => fn(quotes.slice())); };
			const subscribeQuotes = (fn) => {
				quoteListeners.add(fn);
				fn(quotes.slice());
				return () => { quoteListeners.delete(fn); };
			};

			const savePrefs = () => {
				hostCall('prefs-set', { prefs }).catch(() => {});
			};

			const applyDefaultSelection = () => {
				if (!reviewState.options.length) return;
				let target = [];
				if (prefs.modelKeys && prefs.modelKeys.length) {
					target = reviewState.options.filter((o) => prefs.modelKeys.indexOf(o.provider + '/' + o.model) !== -1);
				}
				if (!target.length) {
					const def = reviewState.options.find((o) => o.model === 'kimi-k2.7-code');
					target = def ? [def] : reviewState.options.slice(0, 1);
				}
				setState({ selectedModels: target });
			};

			hostCall('prefs-get').then((r) => {
				if (r && r.prefs) {
					prefs = Object.assign({ modelKeys: null, scope: 'current' }, r.prefs);
				}
				return hostCall('options');
			}).then((r) => {
				if (r && r.ok && Array.isArray(r.options) && r.options.length > 0) {
					setState({ options: r.options });
					applyDefaultSelection();
				}
			}).catch(() => {});

			const nodeText = (n) => {
				if (!n) return '';
				if (n.kind === 'assistant' && Array.isArray(n.blocks)) {
					return n.blocks.filter((b) => b && b.kind === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
				}
				if ((n.kind === 'user' || n.kind === 'steering') && Array.isArray(n.content)) {
					return n.content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
				}
				return '';
			};

			const anchorScopeText = (messages, anchorPos, n) => {
				if (anchorPos < 0) return '';
				const asstIdx = [];
				messages.forEach((m, i) => { if (m.kind === 'assistant') asstIdx.push(i); });
				const pos = asstIdx.indexOf(anchorPos);
				if (pos === -1) return '';
				const firstAsst = asstIdx[Math.max(0, pos - n + 1)];
				const start = Math.max(0, firstAsst - 1);
				return messages.slice(start, anchorPos + 1).map(nodeText).join('\n\n');
			};

			// ---- Markdown -> React renderer ----
			const renderInline = (text, kb) => {
				const out = [];
				let n = 0;
				const parts = text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\n]+\*)/g);
				for (const p of parts) {
					if (!p) continue;
					if (p.startsWith('**') && p.endsWith('**') && p.length > 4) {
						out.push(react.createElement('strong', { key: kb + '-b' + n++ }, p.slice(2, -2)));
					} else if (p.startsWith('`') && p.endsWith('`') && p.length > 2) {
						out.push(react.createElement('code', { key: kb + '-c' + n++, className: 'krv-icode' }, p.slice(1, -1)));
					} else if (p.startsWith('*') && p.endsWith('*') && p.length > 2) {
						out.push(react.createElement('em', { key: kb + '-i' + n++ }, p.slice(1, -1)));
					} else {
						out.push(p);
					}
				}
				return out;
			};

			const renderMarkdown = (text) => {
				const lines = text.split('\n');
				const els = [];
				let key = 0;
				let i = 0;
				const push = (el) => { els.push(el); key += 1; };
				while (i < lines.length) {
					const t = lines[i].trim();
					if (t === '') { i += 1; continue; }
					if (t.startsWith('```')) {
						const lm = t.match(/^```([a-zA-Z0-9_+-]*)/);
						const lang = lm && lm[1] ? lm[1].toLowerCase() : '';
						const buf = [];
						i += 1;
						while (i < lines.length && !lines[i].trim().startsWith('```')) { buf.push(lines[i]); i += 1; }
						i += 1;
						if (lang === 'markdown' || lang === 'md') {
							push(react.createElement('div', { key: 'k' + key, className: 'krv-md-inner' }, renderMarkdown(buf.join('\n'))));
						} else {
							push(react.createElement('pre', { key: 'k' + key, className: 'krv-cblock' }, react.createElement('code', null, buf.join('\n'))));
						}
						continue;
					}
					const hm = t.match(/^(#{1,4})\s+(.*)$/);
					if (hm) {
						const level = Math.min(hm[1].length + 1, 5);
						push(react.createElement('h' + level, { key: 'k' + key }, renderInline(hm[2], 'h' + key)));
						i += 1;
						continue;
					}
					if (t.startsWith('|')) {
						const rows = [];
						while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(lines[i].trim()); i += 1; }
						const parsed = rows
							.filter((r) => !/^\|[\s:|-]+\|$/.test(r))
							.map((r) => r.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()));
						if (parsed.length > 0) {
							const head = parsed[0];
							const body = parsed.slice(1);
							push(react.createElement('table', { key: 'k' + key, className: 'krv-table' },
								react.createElement('thead', null, react.createElement('tr', null, head.map((c, ci) => react.createElement('th', { key: ci }, renderInline(c, 'th' + key + '-' + ci))))),
								body.length ? react.createElement('tbody', null, body.map((r, ri) => react.createElement('tr', { key: ri }, r.map((c, ci) => react.createElement('td', { key: ci }, renderInline(c, 'td' + key + '-' + ri + '-' + ci)))))) : null,
							));
						}
						continue;
					}
					const um = t.match(/^[-*]\s+(.*)$/);
					const om = t.match(/^\d+[.)]\s+(.*)$/);
					if (um || om) {
						const ordered = !!om;
						const items = [];
						while (i < lines.length) {
							const t2 = lines[i].trim();
							const m2 = t2.match(/^[-*]\s+(.*)$/);
							const m3 = t2.match(/^\d+[.)]\s+(.*)$/);
							if (ordered ? m3 : m2) { items.push((ordered ? m3 : m2)[1]); i += 1; }
							else if (t2 === '') { i += 1; break; }
							else break;
						}
						push(react.createElement(ordered ? 'ol' : 'ul', { key: 'k' + key, className: 'krv-list' }, items.map((it, ix) => react.createElement('li', { key: ix }, renderInline(it, 'li' + key + '-' + ix)))));
						continue;
					}
					if (t.startsWith('>')) {
						const buf = [];
						while (i < lines.length && lines[i].trim().startsWith('>')) { buf.push(lines[i].trim().replace(/^>\s?/, '')); i += 1; }
						push(react.createElement('blockquote', { key: 'k' + key, className: 'krv-quote' }, renderInline(buf.join(' '), 'q' + key)));
						continue;
					}
					if (/^(-{3,}|\*{3,})$/.test(t)) { push(react.createElement('hr', { key: 'k' + key, className: 'krv-hr' })); i += 1; continue; }
					const buf = [];
					while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,4}\s|```|[-*]\s|\d+[.)]\s|>\s?|\|)/.test(lines[i].trim())) { buf.push(lines[i]); i += 1; }
					push(react.createElement('p', { key: 'k' + key, className: 'krv-p' }, renderInline(buf.join(' '), 'p' + key)));
				}
				return els;
			};

			// ---- Shared report rendering (main view + history detail) ----
			const renderReportList = (reports, options, inputActions, onSent) => {
				const keys = Object.keys(reports);
				return keys.map((key) => {
					const r = reports[key];
					const meta = key.split('/');
					const opt = options.find((o) => o.provider === meta[0] && o.model === meta[1]);
					const label = (opt && opt.name) || key;
					return react.createElement('div', { key, className: 'krv-report' },
						react.createElement('div', { className: 'krv-report-head' },
							'📄 ' + label + (r.done ? '' : '（审查中…）'),
						),
						r.error
							? react.createElement('div', { className: 'krv-error' }, r.error)
							: null,
						r.text
							? react.createElement('div', { className: 'krv-md' }, renderMarkdown(r.text))
							: null,
						r.usage && r.done && !r.error
							? react.createElement('div', { className: 'krv-usage' }, '消耗：输入 ' + r.usage.input + ' / 输出 ' + r.usage.output + ' tokens')
							: null,
						r.text && r.done && !r.error && inputActions
							? react.createElement('button', {
								className: 'krv-send',
								onClick: () => {
									inputActions.setDraft('请根据以下审查意见修改（' + label + '）：\n\n' + r.text);
									if (onSent) onSent();
								},
							}, '📤 填入输入框发送（可预览编辑）')
							: null,
					);
				});
			};

			// ---- Per-message trigger: review ----
			function ReviewButton(props) {
				const useSession = props.useSession || (() => []);
				const nodes = useSession((s) => s.nodes);
				const node = nodes.find((n) => n.kind === 'assistant' && n.messageId === props.messageId);
				const [, force] = react.useState(0);
				react.useEffect(() => subscribe(() => force((x) => x + 1)), []);
				const messages = nodes.filter((n) => (n.kind === 'assistant' || n.kind === 'user' || n.kind === 'steering') && nodeText(n).trim());
				const anchorPos = messages.indexOf(node);
				const texts = {
					current: nodeText(node),
					last1: anchorScopeText(messages, anchorPos, 1),
					last3: anchorScopeText(messages, anchorPos, 3),
					last5: anchorScopeText(messages, anchorPos, 5),
					all: messages.map(nodeText).join('\n\n'),
				};
				const disabled = reviewState.loading || !texts.current.trim();
				const selectedCount = reviewState.selectedModels.length;
				return react.createElement('button', {
					className: 'krv-trigger',
					disabled,
					title: '审查这条消息——可多选模型互审，可切换审查范围',
					onClick: () => {
						if (reviewState.options.length) applyDefaultSelection();
						setState({
							open: true,
							scope: prefs.scope || 'current',
							scopeTexts: texts,
							pendingText: texts[prefs.scope] || texts.current,
							reports: {},
							error: '',
							sentDraft: false,
							currentJobIds: [],
							view: 'main',
							historyIndex: null,
							inputActions: props.inputActions || null,
						});
					},
				}, reviewState.loading ? '审查中…' : '审查' + (selectedCount > 1 ? '(' + selectedCount + ')' : ''));
			}

			// ---- Per-message trigger: quote this Q&A as a chip above the composer ----
			function QuoteButton(props) {
				const useSession = props.useSession || (() => []);
				const useInput = props.useInput || (() => ({ draft: '' }));
				const nodes = useSession((s) => s.nodes);
				const node = nodes.find((n) => n.kind === 'assistant' && n.messageId === props.messageId);
				const draft = useInput((s) => s.draft) || '';
				const [items, setItems] = react.useState([]);
				react.useEffect(() => subscribeQuotes(setItems), []);
				if (!node || !props.inputActions) return null;
				const nodeIdx = nodes.indexOf(node);
				let prevUser = null;
				for (let i = nodeIdx - 1; i >= 0; i -= 1) {
					if (nodes[i].kind === 'user' || nodes[i].kind === 'steering') { prevUser = nodes[i]; break; }
				}
				const answerText = nodeText(node).trim();
				if (!answerText) return null;
				const questionText = nodeText(prevUser).trim();
				const hasQuote = items.some((q) => q.messageId === props.messageId);
				const onClick = () => {
					const preview = answerText.replace(/\s+/g, ' ').slice(0, 10);
					const marker = '[引用：' + preview + '…]';
					quoteSeq += 1;
					quotes.push({ id: 'q' + quoteSeq, marker, messageId: props.messageId, question: questionText, answer: answerText, preview });
					notifyQuotes();
					props.inputActions.setDraft(draft ? draft + ' ' + marker : marker);
				};
				return react.createElement('button', {
					className: 'krv-trigger',
					title: '引用这条问答，引用卡片将显示在输入框上方；点击卡片可查看全文',
					onClick,
				}, hasQuote ? '已引用 ✓' : '引用');
			}

			// ---- Quote chip dock above the composer ----
			function QuoteDock(props) {
				const [items, setItems] = react.useState([]);
				react.useEffect(() => subscribeQuotes(setItems), []);
				const [expanded, setExpanded] = react.useState(null);
				const useInput = props.useInput || (() => ({ draft: '' }));
				const draft = useInput((s) => s.draft) || '';
				const [draftMirror, setDraftMirror] = react.useState(draft);
				react.useEffect(() => { setDraftMirror(draft); }, [draft]);
				if (!items.length) return null;
				const remove = (id) => {
					const q = quotes.find((x) => x.id === id);
					if (q) {
						if (draftMirror && props.inputActions) {
							const next = draftMirror.replace(q.marker, '').replace(/\s{2,}/g, ' ').trim();
							props.inputActions.setDraft(next);
						}
					}
					quotes = quotes.filter((x) => x.id !== id);
					notifyQuotes();
					if (expanded === id) setExpanded(null);
				};
				return react.createElement('div', { className: 'krv-dock' },
					items.map((q) => react.createElement('div', { key: q.id, className: 'krv-quotebox' },
						react.createElement('div', { className: 'krv-quotebar' },
							react.createElement('button', {
								className: 'krv-qchip',
								title: '点击查看完整引用内容',
								onClick: () => setExpanded(expanded === q.id ? null : q.id),
							}, '📎 引用：' + q.preview + '…'),
							react.createElement('button', {
								className: 'krv-qrm',
								title: '移除引用（输入框中的标记将同步删除）',
								onClick: () => remove(q.id),
							}, '✕'),
						),
						expanded === q.id
							? react.createElement('div', { className: 'krv-qdetail' },
								q.question ? react.createElement('div', { className: 'krv-qrow' }, react.createElement('span', { className: 'krv-qtag' }, '提问'), q.question) : null,
								react.createElement('div', { className: 'krv-qrow' }, react.createElement('span', { className: 'krv-qtag' }, '回答'), q.answer),
							)
							: null,
					)),
				);
			}

			// ---- Overlay ----
			function ReviewOverlay() {
				const [state, setLocal] = react.useState(reviewState);
				react.useEffect(() => subscribe(setLocal), []);
				if (!state.open) return null;

				const toggleModel = (o) => {
					const key = o.provider + '/' + o.model;
					const exists = state.selectedModels.some((m) => m.provider + '/' + m.model === key);
					const next = exists
						? state.selectedModels.filter((m) => m.provider + '/' + m.model !== key)
						: state.selectedModels.concat([o]);
					setState({ selectedModels: next, reports: {}, error: '', sentDraft: false });
				};

				const pushHistory = () => {
					const snapshot = {};
					Object.keys(reviewState.reports).forEach((k) => {
						const r = reviewState.reports[k];
						snapshot[k] = { done: r.done, text: r.text || '', error: r.error || null, usage: r.usage || null };
					});
					const entry = {
						time: Date.now(),
						models: reviewState.selectedModels.map((m) => m.name).join('、'),
						scope: reviewState.scope,
						reports: snapshot,
					};
					setState({ history: [entry].concat(reviewState.history).slice(0, HISTORY_MAX) });
				};

				const run = async () => {
					if (!state.selectedModels.length || state.loading) return;
					const len = (state.pendingText || '').trim().length;
					if (len < 50) {
						setState({ error: '被审查内容过短（' + len + ' 字符），模型无法生成有效审查报告。请切换审查范围（如「最近 3 轮对话」或「全部对话」）或选择其它消息。' });
						return;
					}
					setState({ loading: true, reports: {}, error: '', sentDraft: false, currentJobIds: [] });
					prefs.modelKeys = state.selectedModels.map((m) => m.provider + '/' + m.model);
					prefs.scope = state.scope;
					savePrefs();
					const jobs = [];
					for (const sel of state.selectedModels) {
						try {
							const start = await hostCall('start', {
								provider: sel.provider,
								model: sel.model,
								content: state.pendingText,
							});
							if (start && start.ok && start.jobId) {
								jobs.push({ key: sel.provider + '/' + sel.model, label: sel.name, jobId: start.jobId });
							} else {
								setState({ reports: Object.assign({}, reviewState.reports, {
									[sel.provider + '/' + sel.model]: { done: true, error: (start && start.error) || '无法启动审查任务' },
								}) });
							}
						} catch (e) {
							setState({ reports: Object.assign({}, reviewState.reports, {
								[sel.provider + '/' + sel.model]: { done: true, error: (e && e.message) ? e.message : String(e) },
							}) });
						}
					}
					if (!jobs.length) { setState({ loading: false }); return; }
					setState({ currentJobIds: jobs.map((j) => j.jobId) });
					const active = new Set(jobs.map((j) => j.key));
					const finishKey = (key, patch) => {
						active.delete(key);
						setState({ reports: Object.assign({}, reviewState.reports, { [key]: Object.assign({ done: true }, patch) }) });
						if (!active.size) {
							setState({ loading: false });
							pushHistory();
						}
					};
					const poll = () => {
						for (const j of jobs) {
							if (!active.has(j.key)) continue;
							hostCall('poll', { jobId: j.jobId }).then((res) => {
								if (!res) { finishKey(j.key, { error: '审查任务异常' }); return; }
								if (res.done) {
									if (res.error) finishKey(j.key, { error: res.error });
									else finishKey(j.key, { text: res.text || '', usage: res.usage || null });
								} else if (res.cancelled) {
									finishKey(j.key, { error: '审查已取消' });
								} else {
									if (res.text) {
										setState({ reports: Object.assign({}, reviewState.reports, { [j.key]: { done: false, text: res.text } }) });
									}
								}
							}).catch((e) => {
								finishKey(j.key, { error: (e && e.message) ? e.message : String(e) });
							});
						}
						if (active.size) activePollTimer = ctx.timeout(poll, 1200);
					};
					poll();
				};

				const cancel = () => {
					if (activePollTimer) { activePollTimer(); activePollTimer = null; }
					state.currentJobIds.forEach((jobId) => {
						hostCall('cancel', { jobId }).catch(() => {});
					});
					setState({ loading: false, error: '审查已取消' });
				};

				const pickScope = (id) => {
					const txt = (state.scopeTexts && state.scopeTexts[id]) || '';
					prefs.scope = id;
					setState({ scope: id, pendingText: txt.slice(0, 120000), reports: {}, error: '', sentDraft: false });
				};

				const longText = state.pendingText.length > 30000;
				const multiRound = state.scope === 'all' || state.scope === 'last5' || state.scope === 'last3';
				const excerpt = state.pendingText.length > 500
					? state.pendingText.slice(0, 500) + '\n…（已截断，审查将使用完整内容）'
					: state.pendingText;
				const reportKeys = Object.keys(state.reports);
				const fmtTime = (t) => {
					const d = new Date(t);
					const p = (n) => (n < 10 ? '0' + n : String(n));
					return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
				};

				const headRight = state.loading
					? react.createElement('button', { className: 'krv-close', title: '取消审查', onClick: cancel }, '取消')
					: react.createElement('span', { className: 'krv-headbtns' },
						state.history.length
							? react.createElement('button', {
								className: 'krv-close',
								title: '审查历史',
								onClick: () => setState({ view: state.view === 'history' ? 'main' : 'history', historyIndex: null }),
							}, state.view === 'history' ? '← 返回' : '🕘 历史')
							: null,
						react.createElement('button', { className: 'krv-close', title: '关闭', onClick: () => setState({ open: false }) }, '✕'),
					);

				let body;
				if (state.view === 'history') {
					if (state.historyIndex === null) {
						body = react.createElement('div', { className: 'krv-hlist' },
							state.history.length === 0
								? react.createElement('div', { className: 'krv-hint' }, '暂无审查历史')
								: state.history.map((h, idx) => react.createElement('button', {
									key: idx,
									className: 'krv-hitem',
									onClick: () => setState({ historyIndex: idx }),
								},
									react.createElement('span', null, fmtTime(h.time)),
									react.createElement('span', null, h.models),
									react.createElement('span', null, '范围：' + ((SCOPES.find((s) => s.id === h.scope) || {}).label || h.scope)),
								)),
						);
					} else {
						const h = state.history[state.historyIndex];
						body = h
							? react.createElement('div', null,
								react.createElement('div', { className: 'krv-hint' },
									h.models + ' · 范围：' + ((SCOPES.find((s) => s.id === h.scope) || {}).label || h.scope) + ' · ' + fmtTime(h.time),
								),
								renderReportList(h.reports, state.options, state.inputActions, () => setState({ sentDraft: true })),
							)
							: react.createElement('div', { className: 'krv-hint' }, '该条历史不存在');
					}
				} else {
					body = react.createElement('div', null,
						react.createElement('div', { className: 'krv-scopes' },
							SCOPES.map((s) => react.createElement('label', { key: s.id, className: 'krv-scope' },
								react.createElement('input', {
									type: 'radio',
									name: 'krv-scope',
									checked: state.scope === s.id,
									disabled: state.loading,
									onChange: () => pickScope(s.id),
								}),
								s.label,
							)),
						),
						multiRound && !state.loading
							? react.createElement('div', { className: 'krv-warn' }, '⚠️ 所选内容将发送至模型服务商（' + state.selectedModels.map((m) => m.name).join('、') + '），请确认不含敏感信息')
							: null,
						react.createElement('div', { className: 'krv-excerpt' }, excerpt),
						longText
							? react.createElement('div', { className: 'krv-hint' }, '内容较长（' + state.pendingText.length + ' 字符），将先自动压缩再审查')
							: null,
						react.createElement('div', { className: 'krv-models' },
							react.createElement('div', { className: 'krv-models-title' }, '审查模型（可多选，多选即互审）：'),
							state.options.map((o) => {
								const key = o.provider + '/' + o.model;
								const checked = state.selectedModels.some((m) => m.provider + '/' + m.model === key);
								return react.createElement('label', { key, className: 'krv-model' },
									react.createElement('input', {
										type: 'checkbox',
										checked,
										disabled: state.loading,
										onChange: () => toggleModel(o),
									}),
									o.name + ' · ' + o.provider,
								);
							}),
						),
						react.createElement('div', { className: 'krv-toolbar' },
							react.createElement('button', {
								className: 'krv-run',
								disabled: state.loading || !state.selectedModels.length || !state.pendingText.trim(),
								onClick: run,
							}, state.loading ? '审查中…' : '开始审查（' + state.selectedModels.length + ' 个模型）'),
						),
						state.loading
							? react.createElement('div', { className: 'krv-hint' }, '正在并行调用 ' + state.selectedModels.map((m) => m.name).join('、') + ' 审查' + (longText ? '（含自动压缩）' : '') + '，结果将实时显示，可点右上角「取消」中断…')
							: null,
						state.error
							? react.createElement('div', { className: 'krv-error' }, state.error)
							: null,
						reportKeys.length
							? renderReportList(state.reports, state.options, state.inputActions, () => setState({ sentDraft: true }))
							: null,
					);
				}

				return react.createElement('div', {
					className: 'krv-overlay',
					onClick: () => { if (!state.loading) setState({ open: false }); },
				},
					react.createElement('div', {
						className: 'krv-box',
						onClick: (e) => e.stopPropagation(),
					},
						react.createElement('div', { className: 'krv-head' },
							react.createElement('span', null, state.view === 'history' ? '🕘 审查历史' : '🔍 消息审查（多模型互审）'),
							headRight,
						),
						react.createElement('div', { className: 'krv-body' }, body),
					),
				);
			}

			slots.inject('conversation.chat.assistant-actions', () => slots.register(
				{ name: 'conversation.chat.assistant-actions', id: 'review', order: 20 },
				(props) => react.createElement(ReviewButton, props),
			));
			slots.inject('conversation.chat.assistant-actions', () => slots.register(
				{ name: 'conversation.chat.assistant-actions', id: 'quote', order: 30 },
				(props) => react.createElement(QuoteButton, props),
			));
			slots.inject('conversation.input.dock', () => slots.register(
				{ name: 'conversation.input.dock', id: 'quote-dock', order: 0 },
				(props) => react.createElement(QuoteDock, props),
			));
			slots.inject('shell.overlay', () => slots.register(
				{ name: 'shell.overlay', id: 'review-overlay', order: 1000 },
				() => react.createElement(ReviewOverlay, null),
			));

			injectStyle(`
.krv-trigger{font-size:12px;padding:2px 8px;border-radius:4px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;line-height:1.4}
.krv-trigger:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary)}
.krv-trigger:disabled{opacity:.45;cursor:default}
.krv-overlay{position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box}
.krv-box{width:min(960px,94vw);max-height:86vh;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.35);color:var(--dsw-alias-label-primary);font-size:13px}
.krv-head{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);font-weight:600;flex-shrink:0}
.krv-headbtns{display:flex;align-items:center;gap:6px}
.krv-close{background:none;border:none;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:14px;padding:2px 6px}
.krv-close:hover{color:var(--dsw-alias-label-primary)}
.krv-body{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding-bottom:4px}
.krv-scopes{display:flex;flex-wrap:wrap;gap:6px 16px;padding:10px 14px 0;font-size:12.5px}
.krv-scope{display:inline-flex;align-items:center;gap:5px;cursor:pointer;color:var(--dsw-alias-label-secondary)}
.krv-scope:hover{color:var(--dsw-alias-label-primary)}
.krv-scope input{accent-color:var(--dsw-alias-brand-primary);cursor:pointer;margin:0}
.krv-scope input:disabled{cursor:default}
.krv-warn{margin:10px 14px 0;padding:8px 10px;color:var(--dsw-alias-state-warn-primary);border:1px solid var(--dsw-alias-state-warn-primary);border-radius:6px;background:var(--dsw-alias-bg-layer-1);font-size:12px}
.krv-excerpt{margin:10px 14px 0;padding:8px 10px;max-height:110px;overflow:auto;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary);font-size:12px}
.krv-models{padding:10px 14px 0;font-size:12.5px}
.krv-models-title{margin-bottom:6px;color:var(--dsw-alias-label-secondary)}
.krv-model{display:inline-flex;align-items:center;gap:5px;margin:0 12px 4px 0;cursor:pointer;color:var(--dsw-alias-label-secondary)}
.krv-model:hover{color:var(--dsw-alias-label-primary)}
.krv-model input{accent-color:var(--dsw-alias-brand-primary);cursor:pointer;margin:0}
.krv-model input:disabled{cursor:default}
.krv-toolbar{display:flex;align-items:center;gap:8px;padding:10px 14px}
.krv-run{font-size:12.5px;padding:5px 16px;border-radius:6px;border:1px solid var(--dsw-alias-brand-primary);background:transparent;color:var(--dsw-alias-brand-primary);cursor:pointer}
.krv-run:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.krv-run:disabled{opacity:.5;cursor:default}
.krv-report{margin:0 14px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden}
.krv-report-head{padding:8px 12px;font-size:12.5px;font-weight:600;background:var(--dsw-alias-bg-layer-2);border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary)}
.krv-md{margin:0;padding:12px 14px;max-height:42vh;overflow:auto;background:var(--dsw-alias-bg-layer-1);font-size:13.5px;line-height:1.65;color:var(--dsw-alias-label-primary)}
.krv-md-inner{margin:0}
.krv-md h2{font-size:16px;margin:14px 0 8px;padding-bottom:4px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.krv-md h3{font-size:14.5px;margin:12px 0 6px}
.krv-md h4{font-size:13.5px;margin:10px 0 6px;color:var(--dsw-alias-brand-primary)}
.krv-md h5{font-size:13px;margin:10px 0 6px}
.krv-md p{margin:6px 0}
.krv-list{margin:6px 0;padding-left:22px}
.krv-list li{margin:3px 0}
.krv-icode{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:4px;padding:1px 5px;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.krv-cblock{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px 12px;overflow:auto;max-height:300px;font-size:12px;line-height:1.55;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre;margin:8px 0}
.krv-quote{border-left:3px solid var(--dsw-alias-brand-primary);margin:8px 0;padding:4px 10px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}
.krv-table{border-collapse:collapse;margin:8px 0;width:100%;font-size:12.5px}
.krv-table th,.krv-table td{border:1px solid var(--dsw-alias-border-l1);padding:5px 9px;text-align:left;vertical-align:top}
.krv-table th{background:var(--dsw-alias-bg-layer-2);font-weight:600}
.krv-hr{border:none;border-top:1px solid var(--dsw-alias-border-l1);margin:12px 0}
.krv-hint{margin:0 14px 14px;padding:10px 12px;color:var(--dsw-alias-label-secondary)}
.krv-error{margin:0 14px 14px;padding:10px 12px;color:var(--dsw-alias-state-error-primary);white-space:pre-wrap;word-break:break-word}
.krv-usage{margin:0 14px 8px;padding:0 12px;color:var(--dsw-alias-label-secondary);font-size:12px}
.krv-send{font-size:12.5px;padding:6px 16px;border-radius:6px;border:1px solid var(--dsw-alias-state-success-primary);background:transparent;color:var(--dsw-alias-state-success-primary);cursor:pointer;margin:0 14px 12px}
.krv-send:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.krv-send:disabled{opacity:.5;cursor:default}
.krv-hlist{padding:10px 14px;display:flex;flex-direction:column;gap:6px}
.krv-hitem{display:flex;gap:12px;align-items:center;font-size:12.5px;padding:8px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left}
.krv-hitem:hover{border-color:var(--dsw-alias-brand-primary)}
.krv-dock{display:flex;flex-wrap:wrap;gap:6px;padding:2px 2px 6px}
.krv-quotebox{display:flex;flex-direction:column;max-width:100%}
.krv-quotebar{display:flex;align-items:center;gap:4px}
.krv-qchip{font-size:12px;padding:3px 10px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.krv-qchip:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.krv-qrm{background:none;border:none;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;padding:2px 4px}
.krv-qrm:hover{color:var(--dsw-alias-state-error-primary)}
.krv-qdetail{margin-top:4px;padding:8px 10px;max-height:220px;overflow:auto;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;width:min(560px,80vw)}
.krv-qrow{margin:2px 0}
.krv-qtag{display:inline-block;font-size:11px;color:var(--dsw-alias-brand-primary);border:1px solid var(--dsw-alias-brand-primary);border-radius:4px;padding:0 5px;margin-right:6px;font-weight:600}
`);
		};

		exports.inject = ['slots', 'timer'];
		exports.apply = apply;
		return module.exports;
	}
});
