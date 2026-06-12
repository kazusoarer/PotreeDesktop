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
	// 保存先は黙って「ドキュメント\Potree現場管理」を使う (= 起動時に質問しない)
	function resolveParent() {
		if (process.env.PCS_SITE_PARENT) return process.env.PCS_SITE_PARENT;   // テスト用
		const saved = localStorage.getItem(PARENT_KEY);
		if (saved) return saved;
		const def = path.join(os.homedir(), 'Documents', 'Potree現場管理');
		localStorage.setItem(PARENT_KEY, def);
		return def;
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
			pcs: { sima: collectSima(), measureExtras: collectMeasureExtras() },
		};
		const text = JSON.stringify(data, null, '\t');
		const tmp = SITE.file + '.tmp';
		fs.writeFileSync(tmp, text, 'utf8');
		try { if (fs.existsSync(SITE.file)) fs.copyFileSync(SITE.file, SITE.file + '.bak'); } catch (_) {}
		fs.renameSync(tmp, SITE.file);
	}

	// Distance 頂点ごとの点名 (pcsPointNames) — Potree.saveProject は保存しないため pcs 側で保持
	function collectMeasureExtras() {
		const out = [];
		for (const m of V.scene.measurements) {
			if (m.pcsPointNames && m.pcsPointNames.some(n => n)) {
				out.push({ uuid: m.uuid, pointNames: m.pcsPointNames });
			}
		}
		return out;
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
			// 頂点点名の復元 (uuid は loadProject で維持される)
			const extras = (data.pcs && data.pcs.measureExtras) || [];
			for (const ex of extras) {
				const m = V.scene.measurements.find(x => x.uuid === ex.uuid);
				if (m) m.pcsPointNames = ex.pointNames;
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

	// ------------------------------------------------------------
	// URL 公開 (= これまで会話で依頼していた Cloudflare 公開をボタン化)
	//   現場の変換済み点群を再変換なしで R2+Pages へ公開し、 限定 URL を発行する。
	//   公開ボタンを押した時点の編集状態 (計測 / クリッピング / 視点 / 表示設定) も
	//   埋め込み、 相手方の画面でそのまま復元される。
	// ------------------------------------------------------------
	const PUBLISH_SCRIPT = 'C:\\potree_share\\publish-pointcloud.ps1';

	// 点群の octree dir (metadata.json/octree.bin/hierarchy.bin が揃うフォルダ) を解決
	function octreeDirOf(pc) {
		try {
			let u = pc && pc.pcoGeometry && pc.pcoGeometry.url;
			if (!u) return null;
			u = decodeURIComponent(String(u).replace(/^file:\/+/i, '')).replace(/\//g, '\\');
			const dir = path.dirname(u);   // metadata.json の親 = octree dir
			const ok = ['metadata.json', 'octree.bin', 'hierarchy.bin'].every(f => fs.existsSync(path.join(dir, f)));
			return ok ? dir : null;
		} catch (_) { return null; }
	}

	function buildPublishArgs() {
		const pcs = V.scene.pointclouds;
		if (!pcs.length) return { error: '公開する点群がありません (点群を読み込んでください)' };

		// 公開対象の octree dir: 現場があれば現場フォルダ内、 なければ表示中の点群から解決
		let prebuiltDir = null, multi = false;
		if (SITE) {
			const dataDir = path.join(SITE.dir, 'data');
			let clouds = [];
			try { clouds = fs.readdirSync(dataDir).filter(d => fs.existsSync(path.join(dataDir, d, 'metadata.json'))); } catch (_) {}
			if (clouds.length) { prebuiltDir = path.join(dataDir, clouds[0]); multi = clouds.length > 1; }
		}
		if (!prebuiltDir) {
			// 現場未登録 (= 旧 json / 変換済みフォルダを直接開いた等) でも、 表示中の点群から公開
			const resolved = pcs.map(octreeDirOf).filter(Boolean);
			if (!resolved.length) return { error: '点群の変換済みデータ (octree) が見つからないため公開できません' };
			prebuiltDir = resolved[0];
			multi = resolved.length > 1;
		}

		const scene = Potree.saveProject(V);
		scene.pointclouds = [];   // 点群はローカルパス参照のため除外 (Web 側は R2 の URL から読む)
		const baseDir = SITE ? SITE.dir : os.tmpdir();
		const sceneJson = path.join(baseDir, 'publish_scene.json');
		fs.writeFileSync(sceneJson, JSON.stringify(scene), 'utf8');

		const projectName = SITE ? SITE.displayName
			: (pcs[0].name || path.basename(prebuiltDir) || '無題');
		return { prebuiltDir, sceneJson, projectName, multi };
	}

	// 公開スクリプトは PowerShell 7 必須 (#requires -Version 7.0)。
	// Windows 標準の powershell.exe (5.1) では即拒否されるため、 必ず pwsh を使う。
	function pwshPath() {
		const cands = [
			'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
			'C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe',
		];
		for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (_) {} }
		return 'pwsh.exe';   // PATH 解決に任せる
	}

	function publishSite() {
		const a = buildPublishArgs();
		if (a.error) { setWarn(a.error); return; }
		if (!fs.existsSync(PUBLISH_SCRIPT)) { setWarn('公開スクリプトが見つかりません: ' + PUBLISH_SCRIPT); return; }
		const note = a.multi ? '\n(複数点群のうち最初の 1 つを公開します)' : '';
		if (!window.confirm(`現場「${a.projectName}」を URL 公開します。\n限定 URL / 30 日で自動削除。 いまの計測・クリッピング・視点もそのまま相手に表示されます。${note}\nよろしいですか?`)) return;
		const dryRun = process.env.PCS_PUBLISH_DRYRUN === '1';   // 自動テスト用
		// -NoProfile 必須: ユーザーの profile が CLOUDFLARE_API_TOKEN を Pages 用トークンで
		// 上書きしており、 そのトークンでは公開が認証エラーになる (2026-06-13 実機特定)。
		const args = [
			'-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PUBLISH_SCRIPT,
			'-PrebuiltDir', a.prebuiltDir,
			'-SceneJsonPath', a.sceneJson,
			'-ProjectName', a.projectName,
		];
		if (dryRun) args.push('-SkipDeploy');
		// 進捗は別ウィンドウではなく左パネル内に表示する (= 何をしているか・どこで
		// エラーになったかが常に見える。 2026-06-13 ユーザー指摘)
		const { spawn } = window.require('child_process');
		const child = spawn(pwshPath(), args, { cwd: 'C:\\potree_share', windowsHide: true });
		window.PCS_PROJECT._lastPublish = child;   // テスト検証用
		beginPublishUI();
		let raw = [];
		const onChunk = (buf) => { raw.push(buf); renderPublishLog(Buffer.concat(raw)); };
		if (child.stdout) child.stdout.on('data', onChunk);
		if (child.stderr) child.stderr.on('data', onChunk);
		child.on('error', (e) => endPublishUI(-1, Buffer.from('公開の起動に失敗: ' + e.message)));
		child.on('exit', (code) => endPublishUI(code, Buffer.concat(raw)));
	}

	// ---------- 公開の進捗 UI ----------
	function decodeConsole(buf) {
		// pwsh の pipe 出力は環境により UTF-8 / cp932 が混在するため、 化けの少ない方を採用
		const u = new TextDecoder('utf-8').decode(buf);
		const s = new TextDecoder('shift_jis').decode(buf);
		const bad = (t) => (t.match(/�/g) || []).length;
		return bad(u) <= bad(s) ? u : s;
	}
	function stripAnsi(t) {
		return t.replace(/\x1b\[[0-9;]*m/g, '');
	}
	function beginPublishUI() {
		$('#pcs_site_publish').prop('disabled', true).val('公開中…');
		$('#pcs_publish_status').show();
		$('#pcs_publish_result').hide();
		$('#pcs_publish_step').text('公開を開始しています…').css('color', '');
		$('#pcs_publish_log').text('');
	}
	function renderPublishLog(buf) {
		const text = stripAnsi(decodeConsole(buf));
		const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
		// 現在の工程 = 最後の "==[ ... ]==" 行
		for (let i = lines.length - 1; i >= 0; i--) {
			const m = lines[i].match(/==\[\s*(.+?)\s*\]==/);
			if (m) { $('#pcs_publish_step').text('工程: ' + m[1]); break; }
		}
		const el = document.getElementById('pcs_publish_log');
		if (el) {
			el.textContent = lines.slice(-80).join('\n');
			el.scrollTop = el.scrollHeight;
		}
	}
	function endPublishUI(code, buf) {
		$('#pcs_site_publish').prop('disabled', false).val('URL 公開');
		renderPublishLog(buf);
		const text = stripAnsi(decodeConsole(buf));
		if (code === 0) {
			const m = text.match(/(https:\/\/[a-z0-9.-]+\.pages\.dev\/?)/i);
			if (m) {
				$('#pcs_publish_step').text('公開完了').css('color', '#7CFC9B');
				$('#pcs_publish_url').text(m[1]);
				$('#pcs_publish_result').show();
			} else {
				$('#pcs_publish_step').text(text.includes('Dry run') ? 'Dry run 完了' : '完了 (URL はログ参照)').css('color', '#7CFC9B');
			}
		} else {
			$('#pcs_publish_step').text('エラーで停止しました (下のログの赤字を確認)').css('color', '#ff8a80');
		}
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

	let listExpanded = false;
	const LIST_LIMIT = 5;   // 通常は直近 5 件のみ表示

	function refreshList() {
		const el = $('#pcs_site_list');
		if (!el.length) return;
		const q = ($('#pcs_site_search').val() || '').toLowerCase();
		el.empty();
		const all = scanSites().filter(s => !q || s.displayName.toLowerCase().includes(q));
		// 検索中は全件、 通常は直近 5 件 (+ 展開で全件)
		const shown = (q || listExpanded) ? all : all.slice(0, LIST_LIMIT);
		for (const s of shown) {
			const isCurrent = SITE && SITE.file === s.file;
			const row = $(`
				<div class="pcs-site-row" style="display:flex; align-items:center; gap:6px; padding:3px 0;">
					<span class="pcs-site-open" style="flex:none; cursor:pointer; font-size:115%;" title="この現場を開く">📂</span>
					<span class="pcs-site-nm" style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"></span>
					<input type="button" value="削除" style="width:auto;"/>
				</div>
			`);
			const nm = row.find('.pcs-site-nm');
			nm.text(s.displayName + (isCurrent ? ' (作業中)' : ''));
			nm.attr('title', `更新: ${fmtDate(s.updatedAt)}\n${s.dir}\nダブルクリックで名前を変更`);
			row.find('.pcs-site-open').click(() => { if (!isCurrent) openSiteFile(s.file); });
			nm.on('dblclick', function () {
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
		// 6 件以上は展開式
		if (!q && all.length > LIST_LIMIT) {
			const more = $(`<div id="pcs_site_more" style="padding:4px 0; cursor:pointer; color:#9adcff; text-align:center;"></div>`);
			more.text(listExpanded ? '▲ 折りたたむ' : `▼ さらに表示 (残り ${all.length - LIST_LIMIT} 件)`);
			more.click(() => { listExpanded = !listExpanded; refreshList(); });
			el.append(more);
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
					<input id="pcs_site_save" type="button" value="保存" style="flex:1;" title="現在の現場を上書き保存"/>
					<input id="pcs_site_new" type="button" value="新規" style="flex:1;" title="新しい現場を始める"/>
					<input id="pcs_site_openfile" type="button" value="開く" style="flex:1;" title="現場ファイルを選んで開く"/>
				</span>
				<span style="display:flex; gap:6px; margin-top:4px;">
					<input id="pcs_site_publish" type="button" value="URL 公開" style="flex:1;"
						title="Cloudflare に限定 URL で公開 (30 日で自動削除)。 いまの計測・クリッピング・視点もそのまま相手に表示されます"/>
				</span>
				<div id="pcs_publish_status" style="display:none; padding:4px 0;">
					<div id="pcs_publish_step" style="font-weight:bold; padding-bottom:3px;"></div>
					<div id="pcs_publish_log" style="font-family:Consolas,monospace; font-size:85%; max-height:120px; overflow:auto;
						background:rgba(0,0,0,0.3); padding:4px 6px; white-space:pre-wrap; word-break:break-all;"></div>
					<div id="pcs_publish_result" style="display:none; padding-top:4px;">
						<input id="pcs_publish_copy" type="button" value="URL をコピー" style="width:auto;"/>
						<div id="pcs_publish_url" style="word-break:break-all; padding-top:3px; color:#9adcff;"></div>
					</div>
				</div>
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
		$('#pcs_site_publish').click(() => publishSite());
		$('#pcs_publish_copy').click(() => {
			const url = $('#pcs_publish_url').text();
			if (url) navigator.clipboard.writeText(url);
		});
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
		if (typeof window.require !== 'function') return;   // Web 公開 mode では現場管理を出さない
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
		markDirty, scanSites, renameSiteFile, buildPublishArgs, publishSite,
		get site() { return SITE; },
		get parent() { return PARENT; },
		get dirty() { return dirty; },
	};
})();
