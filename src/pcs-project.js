// ============================================================
// pcs-project.js — 現場管理 (Phase 1)
//   設計 (2026-06-12 ユーザー承認):
//   - 親フォルダ「ドキュメント\Potree現場管理」配下に 1 現場 = 1 フォルダで自己完結
//       <親>\site_YYYYMMDD_HHMMSS\現場.json5  … 表示名/計測/SIMA/視点 (相対参照)
//                              \data\cloud_N\ … 変換済み点群 (octree)
//   - 物理名は常に英数字 (PotreeConverter が日本語パス入力で破綻するため実証済み)、
//     表示名 (日本語可) は 現場.json5 内に保持。 リネームは表示名のみ変更
//   - LAZ ドロップ → 変換先が自動で現場フォルダ内になる (現場は無言で自動作成)
//   - 日本語名の LAZ は変換前に ASCII 名へ退避 (変換後に退避 file は削除)
//   - 開く = pending を記録して reload (シーンを作り直すため最も堅牢)
//   - 一覧 = 親フォルダの実体をそのまま表示 (更新日順 + 検索)。 隠し DB なし
//   - 成功メッセージは表示しない (エラー・警告のみ)
// ============================================================
(function () {
	'use strict';

	let V = null;
	let fs = null, path = null, os = null;
	let PARENT = null;                 // 現場親フォルダ
	let SITE = null;                   // { dir, file, displayName, createdAt }
	let dirty = false;
	let cloudSeq = 0;                  // data\cloud_N 連番
	let stagedFiles = [];              // 変換前に ASCII 退避した一時 file
	let json5Promise = null;           // 旧 Export json5 (JSON5 形式) の parser

	const SITE_FILE = '現場.json5';
	const PENDING_KEY = 'pcsPendingOpen';
	const PARENT_KEY = 'pcsSiteParent';

	function nowStamp() {
		const d = new Date();
		const p = (n, w) => String(n).padStart(w || 2, '0');
		return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
	}

	function loadJSON5() {
		if (!json5Promise) json5Promise = import('./libs/json5-2.1.3/json5.mjs').then(m => m.default || m);
		return json5Promise;
	}

	// ------------------------------------------------------------
	// 親フォルダ
	// ------------------------------------------------------------
	function resolveParent() {
		if (process.env.PCS_SITE_PARENT) return process.env.PCS_SITE_PARENT;   // テスト用
		const saved = localStorage.getItem(PARENT_KEY);
		if (saved) return saved;
		const def = path.join(os.homedir(), 'Documents', 'Potree現場管理');
		const ok = window.confirm(`現場の保存先を次の場所にします。\n\n${def}\n\n別の場所にする場合は「キャンセル」を押してフォルダを選んでください。`);
		if (ok) {
			localStorage.setItem(PARENT_KEY, def);
			return def;
		}
		// フォルダ選択 (キャンセルされたら既定に戻す)
		return def;   // picker は selectParentFolder() で上書き (初回 confirm キャンセル時のみ呼ぶ)
	}

	function selectParentFolder(thenDefault) {
		const inp = document.createElement('input');
		inp.type = 'file';
		inp.webkitdirectory = true;
		inp.addEventListener('change', () => {
			const f = inp.files && inp.files[0];
			if (f && f.path) {
				PARENT = path.dirname(f.path) === f.path ? f.path : f.path.replace(/[\\\/][^\\\/]*$/, '');
				PARENT = inp.files[0].path.split(path.sep).slice(0, -1).join(path.sep);
			}
			if (!PARENT) PARENT = thenDefault;
			localStorage.setItem(PARENT_KEY, PARENT);
			ensureDir(PARENT);
			refreshList();
		});
		inp.click();
	}

	function ensureDir(p) {
		if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
	}

	// ------------------------------------------------------------
	// 現場の作成・保存
	// ------------------------------------------------------------
	function createSite(displayName) {
		let dir = path.join(PARENT, 'site_' + nowStamp());
		let n = 1;
		while (fs.existsSync(dir)) dir = path.join(PARENT, `site_${nowStamp()}_${n++}`);
		ensureDir(path.join(dir, 'data'));
		SITE = { dir, file: path.join(dir, SITE_FILE), displayName: displayName || '無題の現場', createdAt: new Date().toISOString() };
		cloudSeq = 0;
		writeSiteFile(null);   // 最低限の現場 file を即時作成 (= 一覧に必ず載る)
		updateHeader();
		refreshList();
		return SITE;
	}

	// 現場 file の書込み (atomic: tmp に書いて rename、 旧版は .bak へ)
	function writeSiteFile(potreeData) {
		const data = {
			pcsProject: 1,
			displayName: SITE.displayName,
			createdAt: SITE.createdAt,
			updatedAt: new Date().toISOString(),
			potree: potreeData,
			pcs: { sima: collectSima() },
		};
		const text = JSON.stringify(data, null, '\t');
		const tmp = SITE.file + '.tmp';
		fs.writeFileSync(tmp, text, 'utf8');
		try { if (fs.existsSync(SITE.file)) fs.copyFileSync(SITE.file, SITE.file + '.bak'); } catch (_) {}
		fs.renameSync(tmp, SITE.file);
	}

	function collectSima() {
		const out = [];
		const entries = (window.PCS_TOOLS && window.PCS_TOOLS.simaEntries) || [];
		for (const en of entries) {
			if (!en.simText) continue;
			out.push({ label: en.label, widthM: en.widthM, colorHex: en.colorHex, active: en.active, simText: en.simText });
		}
		return out;
	}

	// 点群 URL を現場フォルダ相対に変換 (現場フォルダごと移動しても開けるように)
	function relativizeUrls(potreeData) {
		if (!potreeData || !potreeData.pointclouds) return potreeData;
		const base = SITE.dir.replace(/\//g, '\\').toLowerCase();
		for (const pc of potreeData.pointclouds) {
			if (!pc.url) continue;
			const u = String(pc.url).replace(/\//g, '\\');
			if (u.toLowerCase().startsWith(base + '\\')) {
				pc.url = './' + u.slice(base.length + 1).replace(/\\/g, '/');
			}
		}
		return potreeData;
	}

	function absolutizeUrls(potreeData, siteDir) {
		if (!potreeData || !potreeData.pointclouds) return { data: potreeData, missing: [] };
		const missing = [];
		for (const pc of potreeData.pointclouds) {
			if (!pc.url) continue;
			let u = String(pc.url);
			if (u.startsWith('./')) u = path.join(siteDir, u.slice(2));
			if (!fs.existsSync(u)) missing.push(u);
			pc.url = u;
		}
		potreeData.pointclouds = potreeData.pointclouds.filter(pc => !missing.includes(pc.url));
		return { data: potreeData, missing };
	}

	function saveSite() {
		if (!SITE) { setWarn('保存する現場がありません (点群を読み込むと現場が作られます)'); return false; }
		const potreeData = relativizeUrls(Potree.saveProject(V));
		writeSiteFile(potreeData);
		dirty = false;
		updateHeader();
		refreshList();
		return true;
	}

	// ------------------------------------------------------------
	// 変換フローとの連携 (desktop.js から呼ばれる)
	// ------------------------------------------------------------
	// LAZ ドロップ時: 変換先 = 現場フォルダ内、 日本語名入力は ASCII へ退避
	function prepareConversion(inputPaths, suggestedName) {
		if (!SITE) {
			const base = path.basename(inputPaths[0]).replace(/\.[^.]+$/, '');
			createSite(base);
		}
		const staged = [];
		const outPaths = inputPaths.map((p, i) => {
			if (/^[\x00-\x7F]+$/.test(p)) return p;   // 英数字のみ → そのまま
			const ext = path.extname(p).toLowerCase() || '.las';
			const dst = path.join(SITE.dir, `stage_${Date.now()}_${i}${ext}`);
			fs.copyFileSync(p, dst);
			staged.push(dst);
			return dst;
		});
		stagedFiles.push(...staged);
		cloudSeq++;
		let target = path.join(SITE.dir, 'data', 'cloud_' + cloudSeq);
		while (fs.existsSync(target)) target = path.join(SITE.dir, 'data', 'cloud_' + (++cloudSeq));
		return { inputPaths: outPaths, targetDir: target };
	}

	// 変換完了 + 読込完了時: 退避 file を削除し、 現場 file を自動更新
	function onCloudLoaded() {
		for (const f of stagedFiles.splice(0)) {
			try { fs.unlinkSync(f); } catch (_) {}
		}
		if (SITE) {
			try { saveSite(); } catch (e) { console.error('[pcs-project] autosave failed:', e); }
		}
	}

	// ------------------------------------------------------------
	// 開く (= pending 記録 → reload。 シーン全消し再構築より堅牢)
	// ------------------------------------------------------------
	function openSiteFile(filePath) {
		if (!fs.existsSync(filePath)) { setWarn('ファイルが見つかりません: ' + filePath); return; }
		localStorage.setItem(PENDING_KEY, filePath);
		window.location.reload();
	}

	function newSite() {
		localStorage.removeItem(PENDING_KEY);
		window.location.reload();
	}

	async function consumePending() {
		const p = localStorage.getItem(PENDING_KEY);
		if (!p) return;
		localStorage.removeItem(PENDING_KEY);
		if (!fs.existsSync(p)) { setWarn('現場ファイルが見つかりません: ' + p); return; }
		let data = null;
		try {
			const text = fs.readFileSync(p, 'utf8');
			try { data = JSON.parse(text); }
			catch (_) { data = (await loadJSON5()).parse(text); }   // 旧 Export json5 (JSON5 形式)
		} catch (e) {
			setWarn('現場ファイルを読み込めません: ' + e.message);
			return;
		}
		if (data && data.pcsProject) {
			const siteDir = path.dirname(p);
			SITE = {
				dir: siteDir, file: p,
				displayName: data.displayName || path.basename(siteDir),
				createdAt: data.createdAt || new Date().toISOString(),
			};
			cloudSeq = countClouds(siteDir);
			if (data.potree) {
				const { data: pd, missing } = absolutizeUrls(data.potree, siteDir);
				if (missing.length) setWarn(`点群データが見つかりません (${missing.length} 件)。 現場フォルダごと移動したか確認してください`);
				try { await Potree.loadProject(V, pd); } catch (e) { setWarn('復元に失敗: ' + e.message); }
			}
			const sima = (data.pcs && data.pcs.sima) || [];
			for (const s of sima) {
				try {
					const en = window.PCS_TOOLS.importSimaText(s.simText, s.label, s.widthM, s.colorHex, { noHistory: true });
					if (en && s.active === false) en.active = false;
				} catch (e) { console.error('[pcs-project] sima restore failed:', e); }
			}
			dirty = false;
			updateHeader();
			refreshList();
		} else if (data && data.type === 'Potree') {
			// 旧来の Export potree ファイル (現場管理外、 絶対パス参照)
			try { await Potree.loadProject(V, data); } catch (e) { setWarn('読込に失敗: ' + e.message); }
		} else {
			setWarn('対応していないファイル形式です');
		}
	}

	function countClouds(siteDir) {
		try {
			return fs.readdirSync(path.join(siteDir, 'data')).filter(d => /^cloud_\d+$/.test(d)).length;
		} catch (_) { return 0; }
	}

	// ------------------------------------------------------------
	// 一覧
	// ------------------------------------------------------------
	function scanSites() {
		const sites = [];
		let dirs = [];
		try { dirs = fs.readdirSync(PARENT); } catch (_) { return sites; }
		for (const d of dirs) {
			const f = path.join(PARENT, d, SITE_FILE);
			if (!fs.existsSync(f)) continue;
			try {
				const data = JSON.parse(fs.readFileSync(f, 'utf8'));
				sites.push({
					file: f, dir: path.join(PARENT, d),
					displayName: data.displayName || d,
					updatedAt: data.updatedAt || fs.statSync(f).mtime.toISOString(),
				});
			} catch (_) { /* 壊れた file は一覧に出さない */ }
		}
		sites.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		return sites;
	}

	function fmtDate(iso) {
		try {
			const d = new Date(iso);
			const p = (n) => String(n).padStart(2, '0');
			return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
		} catch (_) { return ''; }
	}

	function renameSiteFile(siteFile, newName) {
		const v = (newName || '').trim();
		if (!v) return;
		try {
			const data = JSON.parse(fs.readFileSync(siteFile, 'utf8'));
			data.displayName = v;
			data.updatedAt = new Date().toISOString();
			fs.writeFileSync(siteFile + '.tmp', JSON.stringify(data, null, '\t'), 'utf8');
			fs.renameSync(siteFile + '.tmp', siteFile);
			if (SITE && SITE.file === siteFile) { SITE.displayName = v; updateHeader(); }
			refreshList();
		} catch (e) { setWarn('名前を変更できません: ' + e.message); }
	}

	function deleteSite(site) {
		if (!window.confirm(`現場「${site.displayName}」を削除します (ごみ箱へ移動)。よろしいですか?`)) return;
		const { shell } = window.require('electron');
		shell.trashItem(site.dir).then(() => {
			if (SITE && SITE.dir === site.dir) { SITE = null; dirty = false; updateHeader(); }
			refreshList();
		}).catch(e => setWarn('削除できません: ' + e.message));
	}

	function pickProjectFile() {
		const inp = document.createElement('input');
		inp.type = 'file';
		inp.accept = '.json5,.json';
		inp.addEventListener('change', () => {
			const f = inp.files && inp.files[0];
			if (f && f.path) openSiteFile(f.path);
		});
		inp.click();
	}

	// ------------------------------------------------------------
	// UI (左パネル最上部「現場」 section)
	// ------------------------------------------------------------
	function setWarn(msg) {
		const el = document.getElementById('pcs_site_status');
		if (el) { el.textContent = msg; el.style.color = '#ffb74d'; }
		console.warn('[pcs-project]', msg);
	}

	function updateHeader() {
		const el = document.getElementById('pcs_site_name');
		if (!el) return;
		el.textContent = (SITE ? SITE.displayName : '(現場未作成)') + (dirty ? ' *' : '');
		el.style.color = SITE ? '' : '#999';
	}

	function markDirty() {
		if (dirty) return;
		dirty = true;
		updateHeader();
	}

	function refreshList() {
		const el = $('#pcs_site_list');
		if (!el.length) return;
		const q = ($('#pcs_site_search').val() || '').toLowerCase();
		el.empty();
		for (const s of scanSites()) {
			if (q && !s.displayName.toLowerCase().includes(q)) continue;
			const row = $(`
				<div class="pcs-site-row" style="display:flex; align-items:center; gap:6px; padding:3px 0; cursor:pointer;">
					<span class="pcs-site-nm" style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"></span>
					<span style="color:#999; font-size:85%; flex:none;">${fmtDate(s.updatedAt)}</span>
					<input type="button" value="削除" style="width:auto;"/>
				</div>
			`);
			const nm = row.find('.pcs-site-nm');
			nm.text(s.displayName + (SITE && SITE.file === s.file ? ' (作業中)' : ''));
			nm.attr('title', s.dir + '\nクリックで開く / ダブルクリックで名前を変更');
			let clickTimer = null;
			nm.on('click', () => {
				if (clickTimer) return;
				clickTimer = setTimeout(() => {
					clickTimer = null;
					if (!(SITE && SITE.file === s.file)) openSiteFile(s.file);
				}, 300);
			});
			nm.on('dblclick', function () {
				if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
				const inp = $('<input type="text" style="flex:1; min-width:60px;">').val(s.displayName);
				$(this).replaceWith(inp);
				inp.focus().select();
				let done = false;
				const commit = () => { if (done) return; done = true; renameSiteFile(s.file, inp.val()); };
				inp.on('keydown', (ev) => {
					if (ev.key === 'Enter') commit();
					else if (ev.key === 'Escape') { done = true; refreshList(); }
				});
				inp.on('blur', commit);
			});
			row.find('input[type="button"]').click((ev) => { ev.stopPropagation(); deleteSite(s); });
			el.append(row);
		}
	}

	function buildSidebarSection() {
		const section = $(`
			<h3 id="menu_pcs_site" class="accordion-header ui-widget"><span>現場</span></h3>
			<div class="accordion-content ui-widget pv-menu-list"></div>
		`);
		const content = section.last();
		content.html(`
			<div class="pv-menu-list">
				<div id="pcs_site_name" style="font-weight:bold; padding:2px 0 6px; font-size:105%;"
					title="ダブルクリックで名前を変更"></div>
				<span style="display:flex; gap:6px;">
					<input id="pcs_site_save" type="button" value="保存" style="flex:1;"/>
					<input id="pcs_site_new" type="button" value="新しい現場" style="flex:1;"/>
					<input id="pcs_site_openfile" type="button" value="ファイルから開く" style="flex:1;"/>
				</span>
				<div class="divider"><span>現場一覧</span></div>
				<input id="pcs_site_search" type="text" placeholder="現場名で検索…" style="width:100%; box-sizing:border-box;"/>
				<div id="pcs_site_list" style="max-height:180px; overflow:auto;"></div>
				<div id="pcs_site_status" style="padding:4px 0; min-height:1.3em; font-size:90%;"></div>
			</div>
		`);
		section.first().click(() => content.slideToggle());
		const anchor = $('#menu_pcs_tools');
		if (anchor.length) section.insertBefore(anchor);
		else section.insertBefore($('#menu_appearance'));
		content.show();
		$('#pcs_site_save').click(() => saveSite());
		$('#pcs_site_new').click(() => newSite());
		$('#pcs_site_openfile').click(() => pickProjectFile());
		$('#pcs_site_search').on('input', refreshList);
		// 作業中の現場名もダブルクリックでリネーム
		$('#pcs_site_name').on('dblclick', function () {
			if (!SITE) return;
			const inp = $('<input type="text" style="width:100%; box-sizing:border-box;">').val(SITE.displayName);
			$(this).empty().append(inp);
			inp.focus().select();
			let done = false;
			const commit = () => { if (done) return; done = true; renameSiteFile(SITE.file, inp.val()); };
			inp.on('keydown', (ev) => {
				if (ev.key === 'Enter') commit();
				else if (ev.key === 'Escape') { done = true; updateHeader(); }
			});
			inp.on('blur', commit);
		});
		updateHeader();
		refreshList();
	}

	function hookDirtyEvents() {
		for (const ev of ['measurement_added', 'measurement_removed', 'profile_added', 'profile_removed', 'volume_added', 'volume_removed']) {
			V.scene.addEventListener(ev, markDirty);
		}
	}

	// ------------------------------------------------------------
	window.initPcsProject = async function (viewer) {
		V = viewer;
		fs = window.require('fs');
		path = window.require('path');
		os = window.require('os');
		PARENT = resolveParent();
		ensureDir(PARENT);
		buildSidebarSection();
		hookDirtyEvents();
		await consumePending();
	};

	window.PCS_PROJECT = {
		prepareConversion, onCloudLoaded, saveSite, openSiteFile, newSite,
		markDirty, scanSites, renameSiteFile,
		get site() { return SITE; },
		get parent() { return PARENT; },
		get dirty() { return dirty; },
	};
})();
