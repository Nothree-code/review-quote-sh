// review-quote-sh (v1.2.0) — Client 半
// 审查按钮 + 审查弹窗（多模型互审/历史回看/自动总结）+ 引用胶囊 + 偏好记忆 + 设置卡片
// 通信：fetch 调 Host 的 /review-quote-* HTTP 路由（见 lib/index.js）
// 格式：__ModuleLoader__ 模块（dsh.client 扫描加载，随页面存在，无需动态激活）

window.__ModuleLoader__.load({
	id: "review-quote-sh",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		// ---- Search icon: prefer DSH primitives (same family as the settings gear),
		// fall back to an inline outline SVG of identical style. ----
		let SearchIconComponent = null;
		try {
			const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
			if (primitives && primitives.IconSearchOutline16) {
				SearchIconComponent = (props) => react.createElement(primitives.IconSearchOutline16, props);
			}
		} catch (e) { /* primitives unavailable */ }
		if (!SearchIconComponent) {
			SearchIconComponent = () => react.createElement('svg', {
				width: 16, height: 16, viewBox: '0 0 16 16',
				fill: 'none', stroke: 'currentColor', strokeWidth: 1.5,
				strokeLinecap: 'round', strokeLinejoin: 'round',
				className: 'krv-navicon',
				'aria-hidden': true,
			},
				react.createElement('circle', { key: 'c', cx: 7, cy: 7, r: 4.5 }),
				react.createElement('line', { key: 'l', x1: 10.5, y1: 10.5, x2: 13.5, y2: 13.5 }),
			);
		}

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
			const slots = ctx.slots || (ctx.get ? ctx.get('slots') : undefined);
			const SCOPE_NS = 'review-quote-sh';

			// ---- Settings cache (populated from settingsScope + fallback to legacy prefs) ----
			// NOTE: settingsScope is fetched LAZILY through ctx.get instead of being declared in
			// exports.inject: a declared service must be ready or the whole plugin never activates
			// (which would also hide the review/quote buttons). Absent settings support degrades
			// to the legacy prefs path instead of disabling the plugin.
			let cachedSettings = null;
			let settingsScope = null;
			const settingsBinder = ctx.get ? ctx.get('settingsScope') : undefined;
			if (settingsBinder) {
				try {
					settingsScope = settingsBinder.bind({ namespace: SCOPE_NS });
					const sync = () => {
						try {
							const snap = settingsScope.getSnapshot();
							cachedSettings = snap && snap.value ? snap.value : null;
						} catch (e) { cachedSettings = null; }
					};
					settingsScope.subscribe(sync);
					sync();
				} catch (e) { settingsScope = null; }
			}
			const getSettings = () => cachedSettings || { rounds: 1, roundModels: [], roundThinking: [], summaryModel: '', summaryThinking: 'off', diffReview: true, scope: 'current', modelKeys: [] };

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
				scopeQuestions: {},
				pendingText: '',
				pendingQuestion: '',
				options: [],
				selectedModels: [],
				reports: {},
				currentJobIds: [],
				inputActions: null,
				sentDraft: false,
				view: 'main',
				history: [],
				historyIndex: null,
				summarizing: false,
				summary: '',
				summaryError: '',
				summaryModel: '',
				summaryChoice: '',
				useConfiguredRounds: false,
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
				const st = getSettings();
				let target = [];
				// Prefer settings.modelKeys if configured
				if (st.modelKeys && st.modelKeys.length) {
					target = reviewState.options.filter((o) => st.modelKeys.indexOf(o.provider + '/' + o.model) !== -1);
				}
				if (!target.length && prefs.modelKeys && prefs.modelKeys.length) {
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

			// 返回范围内第一个 user/steering 消息文本（供重答对比模式使用）
			const anchorScopeQuestion = (messages, anchorPos, n) => {
				if (anchorPos < 0) return '';
				const asstIdx = [];
				messages.forEach((m, i) => { if (m.kind === 'assistant') asstIdx.push(i); });
				const pos = asstIdx.indexOf(anchorPos);
				if (pos === -1) return '';
				const firstAsst = asstIdx[Math.max(0, pos - n + 1)];
				const start = Math.max(0, firstAsst - 1);
				const seg = messages.slice(start, anchorPos + 1);
				for (const m of seg) {
					if (m.kind === 'user' || m.kind === 'steering') {
						const t = nodeText(m).trim();
						if (t) return t;
					}
				}
				return '';
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
					push(react.createElement('p', { key: 'k' + key, className: 'krv-p' }, renderInline(buf.join('\n'), 'p' + key)));
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
							'📄 ' + label + (r.done ? '' : (r.elapsed ? '（审查中，已 ' + r.elapsed + 's…）' : '（审查中…）')),
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

			// ---- Settings Card ----
			function SettingsValueField(props) {
				return react.createElement('div', { className: 'krv-sfield' },
					react.createElement('div', { className: 'krv-shead' },
						react.createElement('label', { className: 'krv-slabel' }, props.label),
						props.overridden ? react.createElement('span', { className: 'krv-sbadge' }, '已覆盖') : null,
					),
					react.createElement('input', {
						className: 'krv-sinput',
						type: props.numeric ? 'number' : 'text',
						value: props.value,
						disabled: props.disabled,
						placeholder: props.placeholder || '',
						onChange: (e) => props.onChange(e.target.value),
					}),
					props.hint ? react.createElement('p', { className: 'krv-shint' }, props.hint) : null,
				);
			}

			function ReviewQuoteSettingsSection(props) {
				const scope = props.scope;
				const [snap, setSnap] = react.useState(scope ? scope.getSnapshot() : { value: {}, base: {}, user: {}, writable: true });
				const [models, setModels] = react.useState([]);
				const [saving, setSaving] = react.useState(false);
				const [failed, setFailed] = react.useState(false);

				react.useEffect(() => {
					if (!scope) return;
					return scope.subscribe(() => setSnap(scope.getSnapshot()));
				}, [scope]);

				react.useEffect(() => {
					hostCall('options').then((r) => {
						if (r && r.ok && Array.isArray(r.options)) setModels(r.options);
					}).catch(() => {});
				}, []);

				const value = snap.value || {};
				const base = snap.base || {};
				const writable = snap.writable !== false;

				const [draftRounds, setDraftRounds] = react.useState(value.rounds || 1);
				const [draftRoundModels, setDraftRoundModels] = react.useState(value.roundModels || []);
				const [draftRoundThinking, setDraftRoundThinking] = react.useState(value.roundThinking || []);
				const [draftSummaryModel, setDraftSummaryModel] = react.useState(value.summaryModel || '');
				const [draftSummaryThinking, setDraftSummaryThinking] = react.useState(value.summaryThinking || 'off');
				const [draftDiffReview, setDraftDiffReview] = react.useState(value.diffReview !== false);

				react.useEffect(() => {
					setDraftRounds(value.rounds || 1);
					setDraftRoundModels(value.roundModels || []);
					setDraftRoundThinking(value.roundThinking || []);
					setDraftSummaryModel(value.summaryModel || '');
					setDraftSummaryThinking(value.summaryThinking || 'off');
					setDraftDiffReview(value.diffReview !== false);
				}, [value.rounds, JSON.stringify(value.roundModels), JSON.stringify(value.roundThinking), value.summaryModel, value.summaryThinking, value.diffReview]);

				const dirty = (
					draftRounds !== (value.rounds || 1) ||
					JSON.stringify(draftRoundModels) !== JSON.stringify(value.roundModels || []) ||
					JSON.stringify(draftRoundThinking) !== JSON.stringify(value.roundThinking || []) ||
					draftSummaryModel !== (value.summaryModel || '') ||
					draftSummaryThinking !== (value.summaryThinking || 'off') ||
					draftDiffReview !== (value.diffReview !== false)
				);

				const modelKey = (o) => o.provider + '/' + o.model;
				const modelLabel = (key) => {
					const o = models.find((m) => modelKey(m) === key);
					return o ? o.name + ' · ' + o.provider : key;
				};

				const save = async () => {
					if (!scope || !dirty || saving) return;
					setSaving(true);
					setFailed(false);
					try {
						await scope.set('rounds', draftRounds);
						await scope.set('roundModels', draftRoundModels);
						await scope.set('roundThinking', draftRoundThinking);
						await scope.set('summaryModel', draftSummaryModel);
						await scope.set('summaryThinking', draftSummaryThinking);
						await scope.set('diffReview', draftDiffReview);
					} catch (e) {
						setFailed(true);
					}
					setSaving(false);
				};

				const discard = () => {
					setDraftRounds(value.rounds || 1);
					setDraftRoundModels(value.roundModels || []);
					setDraftRoundThinking(value.roundThinking || []);
					setDraftSummaryModel(value.summaryModel || '');
					setDraftSummaryThinking(value.summaryThinking || 'off');
					setDraftDiffReview(value.diffReview !== false);
					setFailed(false);
				};

				const resetField = async (field) => {
					if (!scope) return;
					if (field === 'rounds') setDraftRounds(base.rounds || 1);
					if (field === 'roundModels') setDraftRoundModels(base.roundModels || []);
					if (field === 'roundThinking') setDraftRoundThinking(base.roundThinking || []);
					if (field === 'summaryModel') setDraftSummaryModel(base.summaryModel || '');
					if (field === 'summaryThinking') setDraftSummaryThinking(base.summaryThinking || 'off');
					if (field === 'diffReview') setDraftDiffReview(base.diffReview !== false);
					await scope.unset(field);
				};

				const roundsNum = Math.max(1, Math.min(5, parseInt(draftRounds, 10) || 1));
				const THINKING_OPTIONS = [
					{ value: 'off', label: '非思考' },
					{ value: 'low', label: '轻思考' },
					{ value: 'high', label: '高思考' },
					{ value: 'max', label: '极限思考' },
				];
				const roundRows = [];
				for (let i = 0; i < roundsNum; i += 1) {
					const sel = draftRoundModels[i] || '';
					roundRows.push(
						react.createElement('div', { key: 'r' + i, className: 'krv-srow' },
							react.createElement('span', { className: 'krv-srowlabel' }, '第 ' + (i + 1) + ' 轮'),
							react.createElement('select', {
								className: 'krv-sselect',
								value: sel,
								disabled: !writable,
								onChange: (e) => {
									const next = draftRoundModels.slice();
									next[i] = e.target.value;
									setDraftRoundModels(next);
								},
							},
								react.createElement('option', { value: '' }, '— 选择模型 —'),
								models.map((o) => react.createElement('option', { key: modelKey(o), value: modelKey(o) }, o.name + ' · ' + o.provider)),
							),
							react.createElement('select', {
								className: 'krv-sselect krv-sthink',
								value: (draftRoundThinking[i] || 'off'),
								disabled: !writable,
								onChange: (e) => {
									const next = draftRoundThinking.slice();
									while (next.length <= i) next.push('off');
									next[i] = e.target.value;
									setDraftRoundThinking(next);
								},
							},
								THINKING_OPTIONS.map((opt) => react.createElement('option', { key: opt.value, value: opt.value }, opt.label)),
							),
						),
					);
				}

				const summarySel = draftSummaryModel || '';
				const configuredCount = draftRoundModels.filter((k) => k && k.length > 0).length;
				const roundsShort = configuredCount < roundsNum;

				return react.createElement('div', { className: 'krv-sroot' },
					react.createElement('h2', { className: 'krv-stitle' }, '🔍 审查与引用'),
					react.createElement('p', { className: 'krv-sintro' }, '配置多模型交叉审查：选择审查轮数（1~5）、每轮使用的模型、总结模型，以及是否启用重答对比模式。'),
					react.createElement('div', { className: 'krv-scard' },
						react.createElement('div', { className: 'krv-ssection' },
							react.createElement('div', { className: 'krv-ssechead' }, '多轮审查配置'),
							react.createElement('div', { className: 'krv-sfieldwrap' },
							react.createElement('div', { className: 'krv-sfield' },
								react.createElement('div', { className: 'krv-shead' },
									react.createElement('label', { className: 'krv-slabel' }, '审查轮数'),
									(snap.user && Object.hasOwn(snap.user, 'rounds')) ? react.createElement('button', {
											className: 'krv-sreset',
											onClick: () => resetField('rounds'),
										}, '恢复默认') : null,
								),
								react.createElement('select', {
									className: 'krv-sselect',
									value: roundsNum,
									disabled: !writable,
									onChange: (e) => setDraftRounds(parseInt(e.target.value, 10)),
								},
									[1,2,3,4,5].map((n) => react.createElement('option', { key: n, value: n }, n + ' 轮')),
								),
							),
							roundRows,
							roundsShort
								? react.createElement('div', { className: 'krv-swarn' }, '⚠️ 已选 ' + roundsNum + ' 轮，但只配置了 ' + configuredCount + ' 轮模型——审查时会因缺少模型而中止，请补全或减少轮数')
								: null,
							react.createElement('div', { className: 'krv-sfield' },
								react.createElement('div', { className: 'krv-shead' },
									react.createElement('label', { className: 'krv-slabel' }, '总结模型'),
									(snap.user && Object.hasOwn(snap.user, 'summaryModel')) ? react.createElement('button', {
											className: 'krv-sreset',
											onClick: () => resetField('summaryModel'),
										}, '恢复默认') : null,
								),
								react.createElement('select', {
									className: 'krv-sselect',
									value: summarySel,
									disabled: !writable,
									onChange: (e) => setDraftSummaryModel(e.target.value),
								},
									react.createElement('option', { value: '' }, '— 自动选择 —'),
									models.map((o) => react.createElement('option', { key: modelKey(o), value: modelKey(o) }, o.name + ' · ' + o.provider)),
								),
								react.createElement('p', { className: 'krv-shint' }, '留空则自动选择第一个可用模型'),
							),
							react.createElement('div', { className: 'krv-sfield' },
								react.createElement('div', { className: 'krv-shead' },
									react.createElement('label', { className: 'krv-slabel' }, '总结思考模式'),
									(snap.user && Object.hasOwn(snap.user, 'summaryThinking')) ? react.createElement('button', {
											className: 'krv-sreset',
											onClick: () => resetField('summaryThinking'),
										}, '恢复默认') : null,
								),
								react.createElement('select', {
									className: 'krv-sselect',
									value: draftSummaryThinking || 'off',
									disabled: !writable,
									onChange: (e) => setDraftSummaryThinking(e.target.value),
								},
									THINKING_OPTIONS.map((opt) => react.createElement('option', { key: opt.value, value: opt.value }, opt.label)),
								),
								react.createElement('p', { className: 'krv-shint' }, '总结模型生成综合意见时的思考强度'),
							),
							react.createElement('div', { className: 'krv-sfield' },
								react.createElement('div', { className: 'krv-shead' },
									react.createElement('label', { className: 'krv-slabel' }, '重答对比模式'),
									(snap.user && Object.hasOwn(snap.user, 'diffReview')) ? react.createElement('button', {
											className: 'krv-sreset',
											onClick: () => resetField('diffReview'),
										}, '恢复默认') : null,
								),
								react.createElement('label', { className: 'krv-scheck' },
									react.createElement('input', {
										type: 'checkbox',
										checked: draftDiffReview,
										disabled: !writable,
										onChange: (e) => setDraftDiffReview(e.target.checked),
									}),
									' 审查非代码回答时，先独立作答再与原文对比（成本约翻倍）',
								),
							),
						),
					),
					writable ? react.createElement('div', { className: 'krv-sfoot' },
						failed ? react.createElement('span', { className: 'krv-sfail' }, '保存失败') : null,
						react.createElement('button', {
							className: 'krv-sbtn krv-sbtn-discard',
							disabled: !dirty || saving,
							onClick: discard,
						}, '放弃修改'),
						react.createElement('button', {
							className: 'krv-sbtn krv-sbtn-save',
							disabled: !dirty || saving,
							onClick: save,
						}, saving ? '保存中…' : '保存'),
					) : react.createElement('div', { className: 'krv-sfoot' },
						react.createElement('span', { className: 'krv-shint' }, '本部署设置为只读'),
					),
					),
				);
			}

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
				const questions = {
					current: (() => {
						for (let i = anchorPos - 1; i >= 0; i -= 1) {
							if (messages[i].kind === 'user' || messages[i].kind === 'steering') {
								return nodeText(messages[i]).trim();
							}
						}
						return '';
					})(),
					last1: anchorScopeQuestion(messages, anchorPos, 1),
					last3: anchorScopeQuestion(messages, anchorPos, 3),
					last5: anchorScopeQuestion(messages, anchorPos, 5),
					all: anchorScopeQuestion(messages, anchorPos, messages.filter((m) => m.kind === 'assistant').length),
				};
				const disabled = reviewState.loading || !texts.current.trim();
				const selectedCount = reviewState.selectedModels.length;
				return react.createElement('button', {
					className: 'krv-trigger',
					disabled,
					title: '审查这条消息——可多选模型互审，可切换审查范围',
					onClick: () => {
						if (reviewState.options.length) applyDefaultSelection();
						const st = getSettings();
						setState({
							open: true,
							scope: prefs.scope || 'current',
							scopeTexts: texts,
							scopeQuestions: questions,
							pendingText: texts[prefs.scope] || texts.current,
							pendingQuestion: questions[prefs.scope] || questions.current || '',
							reports: {},
							error: '',
							sentDraft: false,
							currentJobIds: [],
							view: 'main',
							historyIndex: null,
							inputActions: props.inputActions || null,
							summary: '',
							summaryError: '',
							summaryModel: '',
							useConfiguredRounds: !!(st.rounds > 1 && st.roundModels && st.roundModels.length > 0),
						});
					},
				}, reviewState.loading ? '审查中…' : '审查' + (selectedCount > 1 ? '(' + selectedCount + ')' : ''));
			}

			// ---- Per-message trigger: quote ----
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
					let modelsToRun = state.selectedModels;
					if (state.useConfiguredRounds) {
						const st = getSettings();
						const rawKeys = (st.roundModels || []).slice(0, st.rounds || 1);
						// 严格校验：每一轮都必须配置了可用模型，缺失时明确提示（不静默跳过）
						const missingIdx = [];
						rawKeys.forEach((key, idx) => {
							if (!key) { missingIdx.push(idx + 1); return; }
							const [provider, model] = key.split('/');
							const found = state.options.find((o) => o.provider === provider && o.model === model);
							if (!found) missingIdx.push(idx + 1);
						});
						if (missingIdx.length) {
							setState({ error: '第 ' + missingIdx.join('、') + ' 轮模型未配置或不可用，请到「设置 → 🔍 审查与引用」补全后再审查' });
							return;
						}
						modelsToRun = rawKeys
							.map((key) => {
								const [provider, model] = key.split('/');
								return state.options.find((o) => o.provider === provider && o.model === model);
							})
							.filter(Boolean);
						if (rawKeys.length < (st.rounds || 1)) {
							setState({ error: '审查轮数设置为 ' + st.rounds + ' 轮，但只配置了 ' + rawKeys.length + ' 轮模型，请补全' });
							return;
						}
						if (!modelsToRun.length) {
							setState({ error: '设置的审查模型在当前配置中不可用，请检查插件设置' });
							return;
						}
						setState({ selectedModels: modelsToRun });
					}
					if (!modelsToRun.length || state.loading) return;
					const len = (state.pendingText || '').trim().length;
					if (len < 50) {
						setState({ error: '被审查内容过短（' + len + ' 字符），模型无法生成有效审查报告。请切换审查范围（如「最近 3 轮对话」或「全部对话」）或选择其它消息。' });
						return;
					}
					setState({ loading: true, reports: {}, error: '', sentDraft: false, currentJobIds: [], summary: '', summaryError: '', summaryModel: '' });
					prefs.modelKeys = modelsToRun.map((m) => m.provider + '/' + m.model);
					prefs.scope = state.scope;
					savePrefs();
					const jobs = [];
					const st2 = getSettings();
					const rkArr = st2.roundModels || [];
					const rtArr = st2.roundThinking || [];
					for (const sel of modelsToRun) {
						try {
							let thinking = 'off';
							const rkIdx = rkArr.indexOf(sel.provider + '/' + sel.model);
							if (rkIdx >= 0) thinking = rtArr[rkIdx] || 'off';
							const start = await hostCall('start', {
								provider: sel.provider,
								model: sel.model,
								content: state.pendingText,
								question: (getSettings().diffReview === false) ? '' : (state.pendingQuestion || ''),
								thinking,
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
							// Auto-summarize when multiple reports done
							autoSummarize();
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
										setState({ reports: Object.assign({}, reviewState.reports, { [j.key]: { done: false, text: res.text, elapsed: res.elapsed || 0 } }) });
									} else if (res.elapsed) {
										const prev = reviewState.reports[j.key];
										setState({ reports: Object.assign({}, reviewState.reports, { [j.key]: { done: false, text: (prev && prev.text) || '', elapsed: res.elapsed } }) });
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

				const autoSummarize = async () => {
					const reportKeys = Object.keys(reviewState.reports);
					const doneReports = reportKeys
						.filter((k) => reviewState.reports[k].done && reviewState.reports[k].text && !reviewState.reports[k].error)
						.map((k) => {
							const meta = k.split('/');
							const opt = reviewState.options.find((o) => o.provider === meta[0] && o.model === meta[1]);
							return { label: (opt && opt.name) || k, text: reviewState.reports[k].text };
						});
					if (doneReports.length < 2) return;
					const st = getSettings();
					let sumModel = null;
					// 优先使用弹窗内临时选择的总结模型
					const choice = reviewState.summaryChoice || '';
					if (choice) {
						const [sp, sm] = choice.split('/');
						if (sp && sm) sumModel = { provider: sp, model: sm };
					}
					if (!sumModel && st.summaryModel) {
						const [sp, sm] = st.summaryModel.split('/');
						if (sp && sm) sumModel = { provider: sp, model: sm };
					}
					if (!sumModel) {
						const fallback = reviewState.options.find((o) => o.model === 'kimi-k3')
							|| reviewState.options.find((o) => o.model === 'deepseek-v4-pro')
							|| state.selectedModels[0]
							|| null;
						if (fallback) sumModel = { provider: fallback.provider, model: fallback.model };
					}
					setState({ summarizing: true, summary: '', summaryError: '', summaryModel: sumModel ? (sumModel.provider + '/' + sumModel.model) : '默认' });
					try {
						const r = await hostCall('summarize', {
							reports: doneReports,
							model: sumModel,
							thinking: getSettings().summaryThinking || 'off',
						});
						if (r && r.ok) setState({ summarizing: false, summary: r.text });
						else setState({ summarizing: false, summaryError: (r && r.error) || '汇总失败' });
					} catch (e) {
						setState({ summarizing: false, summaryError: (e && e.message) ? e.message : String(e) });
					}
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
					const q = (state.scopeQuestions && state.scopeQuestions[id]) || '';
					prefs.scope = id;
					setState({ scope: id, pendingText: txt.slice(0, 120000), pendingQuestion: q, reports: {}, error: '', sentDraft: false });
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
					// Model selection area: if useConfiguredRounds, show read-only notice; otherwise show checkboxes
					let modelArea;
					if (state.useConfiguredRounds) {
						const st = getSettings();
						modelArea = react.createElement('div', { className: 'krv-models' },
							react.createElement('div', { className: 'krv-models-title' }, '已按设置配置 ' + st.rounds + ' 轮审查'),
							(st.roundModels || []).map((key, idx) => {
								const opt = state.options.find((o) => o.provider + '/' + o.model === key);
								return react.createElement('div', { key, className: 'krv-modelro' },
									'第 ' + (idx + 1) + ' 轮：' + (opt ? opt.name + ' · ' + opt.provider : key),
								);
							}),
						);
					} else {
						modelArea = react.createElement('div', { className: 'krv-models' },
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
						);
					}

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
							? react.createElement('div', { className: 'krv-warn' }, '⚠️ 所选内容将发送至模型服务商（' + (state.useConfiguredRounds ? getSettings().roundModels.join('、') : state.selectedModels.map((m) => m.name).join('、')) + '），请确认不含敏感信息')
							: null,
						react.createElement('div', { className: 'krv-excerpt' }, excerpt),
						longText
							? react.createElement('div', { className: 'krv-hint' }, '内容较长（' + state.pendingText.length + ' 字符），将先自动压缩再审查')
							: null,
						state.pendingQuestion && getSettings().diffReview !== false
							? react.createElement('div', { className: 'krv-hint' }, '🔀 重答对比模式：审查模型将先独立回答原始问题，再与原回答逐点对比（事实/逻辑/遗漏/过度断言）')
							: null,
						modelArea,
						react.createElement('div', { className: 'krv-toolbar' },
							react.createElement('button', {
								className: 'krv-run',
								disabled: state.loading || (!state.useConfiguredRounds && !state.selectedModels.length) || !state.pendingText.trim(),
								onClick: run,
							}, state.loading ? '审查中…' : '开始审查（' + (state.useConfiguredRounds ? getSettings().rounds : state.selectedModels.length) + ' 个模型）'),
						),
						state.loading
							? react.createElement('div', { className: 'krv-hint' }, '正在并行调用 ' + (state.useConfiguredRounds ? getSettings().roundModels.join('、') : state.selectedModels.map((m) => m.name).join('、')) + ' 审查' + (longText ? '（含自动压缩）' : '') + '，结果将实时显示，可点右上角「取消」中断…')
							: null,
						state.error
							? react.createElement('div', { className: 'krv-error' }, state.error)
							: null,
						reportKeys.length
							? renderReportList(state.reports, state.options, state.inputActions, () => setState({ sentDraft: true }))
							: null,
						!state.loading && reportKeys.length > 1 && reportKeys.every((k) => state.reports[k].done)
							? react.createElement('div', { className: 'krv-sumbar' },
								react.createElement('span', { className: 'krv-sumlabel' }, '总结模型：'),
								react.createElement('select', {
									className: 'krv-sselect krv-sumselect',
									value: state.summaryChoice || '',
									disabled: state.summarizing,
									onChange: (e) => setState({ summaryChoice: e.target.value }),
								},
									react.createElement('option', { value: '' }, '— 默认（设置中的总结模型）—'),
									state.options.map((o) => react.createElement('option', { key: o.provider + '/' + o.model, value: o.provider + '/' + o.model }, o.name + ' · ' + o.provider)),
								),
							)
							: null,
						state.summarizing
							? react.createElement('div', { className: 'krv-hint' }, '正在生成综合审查意见…')
							: null,
						state.summaryError
							? react.createElement('div', { className: 'krv-error' }, state.summaryError)
							: null,
						state.summary
							? react.createElement('div', { className: 'krv-report' },
								react.createElement('div', { className: 'krv-report-head' }, '📊 综合总结' + (state.summaryModel ? '（' + state.summaryModel + '）' : '')),
								react.createElement('div', { className: 'krv-md' }, renderMarkdown(state.summary)),
								state.inputActions
									? react.createElement('button', {
										className: 'krv-send',
										onClick: () => {
											state.inputActions.setDraft('请根据以下综合审查意见修改：\n\n' + state.summary);
											setState({ sentDraft: true });
										},
									}, state.sentDraft ? '✓ 已填入输入框，可编辑后回车发送' : '📤 填入输入框发送（可预览编辑）')
									: null,
							)
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

			// Register settings section (top-level tab alongside General/Models/Plugins)
			if (settingsScope) {
				slots.inject('settings.section', () => slots.register(
					{ name: 'settings.section', id: 'review-quote-sh', order: 20, label: () => react.createElement('span', { 'data-rq-nav': '1', className: 'krv-navlabel' },
						react.createElement(SearchIconComponent, { size: 16 }),
						' 审查与引用',
					) },
					(props) => react.createElement(ReviewQuoteSettingsSection, { ...props, scope: settingsScope }),
				));
			}

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
.krv-modelro{padding:2px 0;color:var(--dsw-alias-label-secondary);font-size:12.5px}
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
/* Settings section (top-level tab) */
.krv-sroot{box-sizing:border-box;height:100%;color:var(--dsw-alias-label-primary);padding:16px 20px 32px;font-size:13px;overflow-y:auto;max-width:860px}
.krv-stitle{margin:0 0 4px;font-size:18px;font-weight:600}
.krv-sintro{color:var(--dsw-alias-label-tertiary);margin:0 0 14px;font-size:13px;line-height:1.5}
.krv-navlabel{display:inline-flex;align-items:center;gap:6px}
.krv-navicon{flex:none}
/* Hide the default gear glyph for this section's nav item; the inline search icon replaces it */
button:has(span[data-rq-nav]) > svg:first-child{display:none}
/* dsh-prompt-enhancer: replace the ✨ emoji with an outline wand icon (same family as the settings gear) */
.dsh-enh-icon{font-size:0 !important;line-height:0 !important;display:inline-block !important;width:14px !important;height:14px !important;background-color:currentColor !important;-webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M3 13 L11 5'/%3E%3Cpath d='M12.5 2.5 l1.2 1.2 -1.2 1.2 -1.2 -1.2z'/%3E%3Cpath d='M9 6.5 l.6 .6'/%3E%3Cpath d='M12.5 9.5 l.6 .6'/%3E%3Cpath d='M5 2.5 l.6 .6'/%3E%3C/svg%3E") center/contain no-repeat !important;mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M3 13 L11 5'/%3E%3Cpath d='M12.5 2.5 l1.2 1.2 -1.2 1.2 -1.2 -1.2z'/%3E%3Cpath d='M9 6.5 l.6 .6'/%3E%3Cpath d='M12.5 9.5 l.6 .6'/%3E%3Cpath d='M5 2.5 l.6 .6'/%3E%3C/svg%3E") center/contain no-repeat !important}
.krv-scard{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;padding:14px 16px;font-size:13px;color:var(--dsw-alias-label-primary)}
.krv-ssection{margin-bottom:10px}
.krv-ssechead{font-size:14px;font-weight:600;margin-bottom:8px;color:var(--dsw-alias-label-primary)}
.krv-sfieldwrap{display:flex;flex-direction:column;gap:8px}
.krv-sfield{display:flex;flex-direction:column;gap:4px}
.krv-shead{display:flex;align-items:center;gap:8px}
.krv-slabel{flex:1;font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}
.krv-sreset{font-size:11px;color:var(--dsw-alias-label-secondary);background:none;border:none;cursor:pointer;padding:0}
.krv-sreset:hover{color:var(--dsw-alias-brand-primary)}
.krv-sinput,.krv-sselect{height:34px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 10px;font-size:13px;font-family:inherit}
.krv-sinput:focus-visible,.krv-sselect:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.krv-sinput:disabled,.krv-sselect:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.krv-srow{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.krv-sthink{max-width:120px;flex:none}
.krv-srowlabel{font-size:12.5px;color:var(--dsw-alias-label-secondary);min-width:48px}
.krv-shint{font-size:12px;color:var(--dsw-alias-label-tertiary);margin:2px 0 0}
.krv-sfoot{display:flex;align-items:center;gap:8px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l2)}
.krv-sfail{flex:1;color:var(--dsw-alias-state-error-primary);font-size:12px}
.krv-sbtn{font-size:12.5px;padding:5px 14px;border-radius:6px;cursor:pointer;font-family:inherit}
.krv-sbtn-discard{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary)}
.krv-sbtn-save{border:1px solid var(--dsw-alias-brand-primary);background:transparent;color:var(--dsw-alias-brand-primary)}
.krv-sbtn:disabled{opacity:.5;cursor:default}
.krv-scheck{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.krv-scheck input{accent-color:var(--dsw-alias-brand-primary);cursor:pointer;margin:0}
.krv-scheck input:disabled{cursor:default}
.krv-swarn{margin:2px 0;padding:6px 10px;color:var(--dsw-alias-state-warn-primary);border:1px solid var(--dsw-alias-state-warn-primary);border-radius:6px;background:var(--dsw-alias-bg-layer-1);font-size:12px;line-height:1.5}
.krv-sumbar{display:flex;align-items:center;gap:8px;padding:4px 14px 10px;font-size:12.5px}
.krv-sumlabel{color:var(--dsw-alias-label-secondary);flex:none}
.krv-sumselect{flex:1;min-width:0;height:32px}
`);
		};

		// Only services that are guaranteed to exist may be declared here: a declared
		// service that never becomes ready keeps the whole plugin from activating.
		// settingsScope / connection are optional and therefore fetched via ctx.get().
		exports.inject = ['slots', 'timer'];
		exports.apply = apply;
		return module.exports;
	}
});
