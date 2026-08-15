window.__ModuleLoader__.load({
	id: "@paradoxsch/dsh-worktree",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region \0rolldown/runtime.js
		var __create = Object.create;
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __getProtoOf = Object.getPrototypeOf;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __copyProps = (to, from, except, desc) => {
			if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
				key = keys[i];
				if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
			return to;
		};
		var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", {
			value: mod,
			enumerable: true
		}) : target, mod));
		//#endregion
		let react = require("react");
		react = __toESM(react, 1);
		//#region src/client/index.ts
		const h = react.default.createElement;
		const API = "/api/dsh-worktree";
		async function request(input) {
			const response = await fetch(API, input === void 0 ? void 0 : {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(input)
			});
			const envelope = await response.json();
			if (!response.ok || !envelope.ok) throw new Error(envelope.error?.message ?? `request failed (${response.status})`);
			return envelope.value;
		}
		const panel = {
			position: "fixed",
			inset: 0,
			zIndex: 1e4,
			background: "rgba(5,8,15,.64)",
			display: "flex",
			alignItems: "center",
			justifyContent: "center",
			padding: 24
		};
		const shell = {
			width: "min(1120px,96vw)",
			height: "min(820px,92vh)",
			borderRadius: 16,
			background: "var(--background,#10141d)",
			color: "var(--foreground,#edf2f7)",
			border: "1px solid rgba(148,163,184,.25)",
			boxShadow: "0 24px 90px rgba(0,0,0,.45)",
			display: "flex",
			flexDirection: "column",
			overflow: "hidden"
		};
		const button = {
			border: "1px solid rgba(148,163,184,.3)",
			borderRadius: 8,
			padding: "6px 10px",
			background: "rgba(148,163,184,.1)",
			color: "inherit",
			cursor: "pointer",
			fontSize: 12
		};
		const primary = {
			...button,
			background: "#2563eb",
			borderColor: "#3b82f6",
			color: "white"
		};
		const danger = {
			...button,
			background: "rgba(220,38,38,.18)",
			borderColor: "rgba(248,113,113,.5)",
			color: "#fca5a5"
		};
		function counts(row) {
			const c = row.changes;
			return `${c.newCommitCount} commits · ${c.stagedFileCount} staged · ${c.unstagedFileCount} unstaged · ${c.untrackedFileCount} untracked`;
		}
		function short(value) {
			return value.slice(0, 10);
		}
		function WorktreeDashboard({ close }) {
			const [data, setData] = (0, react.useState)();
			const [error, setError] = (0, react.useState)();
			const [busy, setBusy] = (0, react.useState)(false);
			const [filter, setFilter] = (0, react.useState)("active");
			const [review, setReview] = (0, react.useState)();
			const refresh = (0, react.useCallback)(async () => {
				try {
					setError(void 0);
					setData(await request());
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
				}
			}, []);
			(0, react.useEffect)(() => {
				refresh();
			}, [refresh]);
			const rows = (0, react.useMemo)(() => (data?.worktrees ?? []).filter((row) => filter === "all" || filter === "active" && !["archived", "removed"].includes(row.state) || row.state === filter), [data, filter]);
			const run = (0, react.useCallback)(async (input) => {
				setBusy(true);
				setError(void 0);
				try {
					await request(input);
					await refresh();
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					setBusy(false);
				}
			}, [refresh]);
			const promptAction = (row, operation, label, key, extra = {}) => {
				const value = window.prompt(label);
				if (value?.trim()) run({
					operation,
					id: row.id,
					changeToken: row.changeToken,
					[key]: value.trim(),
					...extra
				});
			};
			return h("div", {
				style: panel,
				role: "dialog",
				"aria-modal": true
			}, h("div", { style: shell }, h("header", { style: {
				padding: "16px 20px",
				borderBottom: "1px solid rgba(148,163,184,.18)",
				display: "flex",
				alignItems: "center",
				gap: 12
			} }, h("div", { style: { flex: 1 } }, h("strong", null, "DSH Worktrees"), h("div", { style: {
				opacity: .62,
				fontSize: 12,
				marginTop: 3
			} }, data?.doctor.gitVersion ?? "Loading durable state…")), data && h("span", { style: {
				fontSize: 12,
				color: data.doctor.status === "ok" ? "#4ade80" : "#fbbf24"
			} }, `doctor: ${data.doctor.status}`), h("button", {
				style: button,
				onClick: () => void refresh(),
				disabled: busy
			}, "Refresh"), h("button", {
				style: button,
				onClick: close
			}, "Close")), h("div", { style: {
				display: "flex",
				gap: 8,
				padding: "10px 20px",
				borderBottom: "1px solid rgba(148,163,184,.12)"
			} }, ...[
				"active",
				"archived",
				"removed",
				"all"
			].map((value) => h("button", {
				key: value,
				style: value === filter ? primary : button,
				onClick: () => setFilter(value)
			}, value)), h("button", {
				style: button,
				disabled: busy,
				onClick: () => void run({ operation: "recover" })
			}, "Recover")), error && h("div", { style: {
				margin: "10px 20px 0",
				padding: 10,
				borderRadius: 8,
				background: "rgba(220,38,38,.16)",
				color: "#fca5a5",
				fontSize: 12
			} }, error), data?.doctor.problems.length ? h("div", { style: {
				margin: "10px 20px 0",
				padding: 10,
				borderRadius: 8,
				background: "rgba(245,158,11,.13)",
				color: "#fcd34d",
				fontSize: 12
			} }, data.doctor.problems.map((item) => item.message).join(" · ")) : null, h("main", { style: {
				padding: 20,
				overflow: "auto",
				display: "grid",
				gap: 12
			} }, rows.length === 0 && h("div", { style: {
				opacity: .6,
				padding: 32,
				textAlign: "center"
			} }, "No worktrees in this view."), ...rows.map((row) => h("section", {
				key: row.id,
				style: {
					border: "1px solid rgba(148,163,184,.2)",
					borderRadius: 12,
					padding: 14,
					background: "rgba(148,163,184,.05)"
				}
			}, h("div", { style: {
				display: "flex",
				gap: 10,
				alignItems: "start"
			} }, h("div", { style: {
				flex: 1,
				minWidth: 0
			} }, h("div", { style: {
				display: "flex",
				gap: 8,
				alignItems: "center",
				flexWrap: "wrap"
			} }, h("strong", null, row.branch ?? "detached HEAD"), h("code", { style: { opacity: .72 } }, short(row.headCommit)), h("span", { style: {
				fontSize: 11,
				color: "#93c5fd"
			} }, row.state), h("span", { style: {
				fontSize: 11,
				opacity: .6
			} }, row.lifetime)), h("div", {
				title: row.path,
				style: {
					fontSize: 11,
					opacity: .58,
					marginTop: 5,
					overflow: "hidden",
					textOverflow: "ellipsis"
				}
			}, row.path), h("div", { style: {
				fontSize: 12,
				marginTop: 7
			} }, counts(row)), row.activeLeases.length > 0 && h("div", { style: {
				fontSize: 11,
				color: "#fbbf24",
				marginTop: 5
			} }, `owners: ${row.activeLeases.map((lease) => lease.owner.label ?? `${lease.owner.kind}:${lease.owner.id}`).join(", ")}`), row.lastDelivery && h("div", { style: {
				fontSize: 11,
				color: "#86efac",
				marginTop: 5
			} }, `last: ${row.lastDelivery.kind} → ${row.lastDelivery.url ?? row.lastDelivery.target}`)), h("div", { style: {
				display: "flex",
				flexWrap: "wrap",
				gap: 6,
				justifyContent: "end",
				maxWidth: 520
			} }, !["archived", "removed"].includes(row.state) && h("button", {
				style: button,
				onClick: async () => {
					try {
						setReview({
							id: row.id,
							value: await request({
								operation: "review",
								id: row.id
							})
						});
					} catch (cause) {
						setError(cause instanceof Error ? cause.message : String(cause));
					}
				}
			}, "Review"), row.changes.dirty && h("button", {
				style: button,
				onClick: () => promptAction(row, "commit", "Commit message", "message")
			}, "Commit"), row.branch === null && !["archived", "removed"].includes(row.state) && h("button", {
				style: button,
				onClick: () => promptAction(row, "create-branch", "New branch name", "name")
			}, "Branch"), !["archived", "removed"].includes(row.state) && h("button", {
				style: button,
				onClick: () => promptAction(row, "handoff", "Target checkout path (must be clean and at the base commit)", "targetPath")
			}, "Handoff"), !row.changes.dirty && row.changes.newCommitCount > 0 && h("button", {
				style: button,
				onClick: () => promptAction(row, "merge", "Target checkout path (must be a clean attached branch)", "targetPath")
			}, "Merge"), !row.changes.dirty && row.branch && h("button", {
				style: button,
				onClick: () => {
					if (window.confirm(`Push ${row.branch} to origin?`)) run({
						operation: "push",
						id: row.id,
						remote: "origin",
						changeToken: row.changeToken
					});
				}
			}, "Push"), !row.changes.dirty && row.branch && h("button", {
				style: button,
				onClick: () => promptAction(row, "pull-request", "Pull request title", "title", { remote: "origin" })
			}, "PR"), !["archived", "removed"].includes(row.state) && h("button", {
				style: button,
				onClick: () => void run({
					operation: "archive",
					id: row.id,
					changeToken: row.changeToken
				})
			}, "Archive"), row.state === "archived" && h("button", {
				style: primary,
				onClick: () => void run({
					operation: "restore",
					id: row.id
				})
			}, "Restore"), !["archived", "removed"].includes(row.state) && h("button", {
				style: danger,
				onClick: () => {
					if (window.confirm("Permanently discard this worktree and every unintegrated change?")) run({
						operation: "discard",
						id: row.id,
						changeToken: row.changeToken,
						confirmation: "discard"
					});
				}
			}, "Discard"))), review?.id === row.id && h("div", { style: {
				marginTop: 12,
				borderTop: "1px solid rgba(148,163,184,.18)",
				paddingTop: 12
			} }, h("div", { style: {
				fontSize: 12,
				whiteSpace: "pre-wrap",
				opacity: .72
			} }, review.value.summary || "No diff summary."), review.value.untrackedPaths.length > 0 && h("div", { style: {
				fontSize: 11,
				marginTop: 8
			} }, `Untracked: ${review.value.untrackedPaths.join(", ")}`), h("pre", { style: {
				maxHeight: 300,
				overflow: "auto",
				padding: 12,
				background: "rgba(0,0,0,.3)",
				borderRadius: 8,
				fontSize: 11,
				whiteSpace: "pre-wrap"
			} }, review.value.diff || "No tracked diff."), review.value.truncated && h("div", { style: {
				color: "#fbbf24",
				fontSize: 11
			} }, "Diff truncated by the host safety limit.")))))));
		}
		function WorktreeFooter({ wide }) {
			const [open, setOpen] = (0, react.useState)(false);
			return h(react.default.Fragment, null, h("button", {
				style: {
					...button,
					width: wide ? "100%" : 36,
					height: 36,
					padding: wide ? "6px 10px" : 0
				},
				title: "DSH Worktrees",
				onClick: () => setOpen(true)
			}, wide ? "⑂ Worktrees" : "⑂"), open && h(WorktreeDashboard, { close: () => setOpen(false) }));
		}
		const inject = ["slots"];
		function apply(ctx) {
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "dsh-worktree",
				order: 60
			}, WorktreeFooter));
		}
		//#endregion
		exports.WorktreeDashboard = WorktreeDashboard;
		exports.WorktreeFooter = WorktreeFooter;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map