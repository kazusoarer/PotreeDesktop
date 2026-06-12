// ============================================================
// pcs-tools.js — 現場ツール (0 ベース再出発の機能 1 号)
//   1. SIMA (.sim) 読込 → 画地 (境界) を赤線で表示
//   2. 一つ戻る / 一つ進む (計測・体積・断面・SIMA の追加履歴)
//   3. ボタンは全て左パネル (Potree サイドバー) の「現場ツール」 section
// 使い方: index.html で three.min.js / 本 file を読み込み、
//         viewer.loadGUI(() => { initPcsTools(viewer); })
// ============================================================
(function () {
	'use strict';

	let V = null;
	const SIMA_GROUPS = [];          // 読込済み SIMA の THREE.Group
	const Z_OFFSET = 0.05;           // 点群と同じ高さだと埋まるため僅かに浮かせる

	// ------------------------------------------------------------
	// SIMA 共通フォーマット解析
	//   A01,点番号,点名,X(北 m),Y(東 m)[,標高 m]   … 座標レコード
	//   D00,画地番号,画地名,…                      … 画地 (区画) 開始
	//   B01,…                                      … 画地の構成点 (A01 の点番号を参照)
	//   D99                                         … 画地終了
	// 注意: B01 の点番号位置は出力ソフトで揺れがある (= f[1] の場合と f[2] の場合)
	//       → 両方を points と突き合わせて解決する。
	// 座標系: SIMA は X=北 / Y=東 (測量系)。 viewer 世界は x=東 / y=北 → 入替える。
	// ------------------------------------------------------------
	function parseSima(text) {
		const points = new Map();
		const parcels = [];
		let cur = null;
		for (const raw of text.split(/\r?\n/)) {
			const line = raw.trim();
			if (!line) continue;
			const f = line.split(',').map(s => s.trim());
			const code = (f[0] || '').toUpperCase();
			if (code === 'A01') {
				const id = f[1];
				const X = parseFloat(f[3]);   // 北
				const Y = parseFloat(f[4]);   // 東
				const Z = (f.length > 5 && f[5] !== '') ? parseFloat(f[5]) : NaN;
				if (id && isFinite(X) && isFinite(Y)) {
					points.set(id, { e: Y, n: X, z: isFinite(Z) ? Z : null, name: f[2] || id });
				}
			} else if (code === 'D00') {
				cur = { name: f[2] || f[1] || ('画地' + (parcels.length + 1)), refs: [] };
			} else if (code === 'B01' && cur) {
				cur.refs.push(f);
			} else if (code === 'D99' && cur) {
				parcels.push(cur);
				cur = null;
			}
		}
		if (cur) parcels.push(cur);   // D99 欠落 file への耐性
		return { points, parcels };
	}

	function resolveParcelPoints(parcel, points) {
		const out = [];
		for (const f of parcel.refs) {
			const p = points.get(f[1]) || points.get(f[2]);
			if (p) out.push(p);
		}
		return out;
	}

	// 標高が SIMA に無い点の代替 Z (= 標高あり点の平均 → 無ければ点群の中心高さ)
	function fallbackZ(points) {
		let sum = 0, n = 0;
		for (const p of points.values()) if (p.z != null) { sum += p.z; n++; }
		if (n > 0) return sum / n;
		try {
			const pc = V.scene.pointclouds[0];
			const bb = pc.boundingBox.clone().applyMatrix4(pc.matrixWorld);
			return (bb.min.z + bb.max.z) / 2;
		} catch (_) { return 0; }
	}

	// 赤線描画。 大座標 (数十万 m) を Float32 に直接入れると cm 単位で歪むため、
	// 1 点目を anchor にして相対座標で geometry を作り、 group.position で戻す。
	function drawSima(parsed, label) {
		const group = new THREE.Group();
		group.name = 'SIMA: ' + label;
		const refZ = fallbackZ(parsed.points);
		let drawn = 0, skipped = 0;
		let anchor = null;
		for (const parcel of parsed.parcels) {
			const pts = resolveParcelPoints(parcel, parsed.points);
			if (pts.length < 3) { skipped++; continue; }
			if (!anchor) {
				anchor = { x: pts[0].e, y: pts[0].n, z: (pts[0].z != null ? pts[0].z : refZ) };
				group.position.set(anchor.x, anchor.y, anchor.z);
			}
			const pos = new Float32Array(pts.length * 3);
			pts.forEach((p, i) => {
				pos[i * 3]     = p.e - anchor.x;
				pos[i * 3 + 1] = p.n - anchor.y;
				pos[i * 3 + 2] = (p.z != null ? p.z : refZ) + Z_OFFSET - anchor.z;
			});
			const geo = new THREE.BufferGeometry();
			geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
			const mat = new THREE.LineBasicMaterial({ color: 0xff0000, depthTest: false, depthWrite: false, transparent: true });
			const line = new THREE.LineLoop(geo, mat);
			line.renderOrder = 99990;   // 点群より常に手前 (= 境界が埋もれない)
			group.add(line);
			drawn++;
		}
		if (drawn === 0) return { group: null, drawn, skipped };
		V.scene.scene.add(group);
		SIMA_GROUPS.push(group);
		return { group, drawn, skipped };
	}

	// Shift_JIS (測量ソフトの標準) → 駄目なら UTF-8。 文字化け数で良い方を採用。
	function decodeSimaBuffer(buf) {
		const tryDec = (enc) => {
			try { return new TextDecoder(enc).decode(buf); } catch (_) { return null; }
		};
		const sjis = tryDec('shift_jis');
		const utf8 = tryDec('utf-8');
		if (sjis == null) return utf8 || '';
		if (utf8 == null) return sjis;
		const bad = (s) => (s.match(/�/g) || []).length;
		return bad(sjis) <= bad(utf8) ? sjis : utf8;
	}

	function importSimaText(text, label) {
		const parsed = parseSima(text);
		if (parsed.parcels.length === 0) {
			setStatus(`画地データ (D00) がありません (座標点 ${parsed.points.size} 点のみ)。境界線は描画されません`, true);
			return null;
		}
		const r = drawSima(parsed, label);
		if (!r.group) {
			setStatus('画地はありますが構成点を解決できませんでした (A01 と B01 の点番号を確認してください)', true);
			return null;
		}
		recordAction({ type: 'sima', obj: r.group });
		refreshSimaList();
		setStatus(`境界線を表示: ${r.drawn} 画地 (赤線)${r.skipped ? ` / ${r.skipped} 画地は点不足でスキップ` : ''}`);
		return r.group;
	}

	function importSimaFromPath(filePath) {
		const fs = window.require('fs');
		const path = window.require('path');
		const buf = fs.readFileSync(filePath);
		const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
		return importSimaText(decodeSimaBuffer(ab), path.basename(filePath));
	}

	function pickSimaFile() {
		const inp = document.createElement('input');
		inp.type = 'file';
		inp.accept = '.sim,.SIM';
		inp.addEventListener('change', () => {
			const f = inp.files && inp.files[0];
			if (!f) return;
			if (f.path && typeof window.require === 'function') {
				importSimaFromPath(f.path);
			} else {
				f.arrayBuffer().then(ab => importSimaText(decodeSimaBuffer(ab), f.name));
			}
		});
		inp.click();
	}

	function removeSimaGroup(group) {
		V.scene.scene.remove(group);
		const i = SIMA_GROUPS.indexOf(group);
		if (i >= 0) SIMA_GROUPS.splice(i, 1);
		refreshSimaList();
	}
	function restoreSimaGroup(group) {
		V.scene.scene.add(group);
		if (!SIMA_GROUPS.includes(group)) SIMA_GROUPS.push(group);
		refreshSimaList();
	}

	// ------------------------------------------------------------
	// 一つ戻る / 一つ進む
	//   対象 = 追加操作の履歴 (計測 / 体積 / 断面 / SIMA 読込)。
	//   手動削除されたものは履歴から除去して空振りを防ぐ。
	// ------------------------------------------------------------
	const undoStack = [];
	const redoStack = [];
	let internalOp = false;

	function recordAction(action) {
		if (internalOp) return;
		undoStack.push(action);
		redoStack.length = 0;
		updateHistoryButtons();
	}

	function purge(obj) {
		if (internalOp) return;
		for (const st of [undoStack, redoStack]) {
			for (let i = st.length - 1; i >= 0; i--) if (st[i].obj === obj) st.splice(i, 1);
		}
		updateHistoryButtons();
	}

	function undo() {
		const a = undoStack.pop();
		if (!a) { setStatus('戻る操作がありません'); updateHistoryButtons(); return; }
		internalOp = true;
		try {
			if (a.type === 'measurement') V.scene.removeMeasurement(a.obj);
			else if (a.type === 'profile') V.scene.removeProfile(a.obj);
			else if (a.type === 'volume') V.scene.removeVolume(a.obj);
			else if (a.type === 'sima') removeSimaGroup(a.obj);
		} finally { internalOp = false; }
		redoStack.push(a);
		updateHistoryButtons();
		setStatus(`一つ戻りました (${labelOf(a)})`);
	}

	function redo() {
		const a = redoStack.pop();
		if (!a) { setStatus('進む操作がありません'); updateHistoryButtons(); return; }
		internalOp = true;
		try {
			if (a.type === 'measurement') V.scene.addMeasurement(a.obj);
			else if (a.type === 'profile') V.scene.addProfile(a.obj);
			else if (a.type === 'volume') V.scene.addVolume(a.obj);
			else if (a.type === 'sima') restoreSimaGroup(a.obj);
		} finally { internalOp = false; }
		undoStack.push(a);
		updateHistoryButtons();
		setStatus(`一つ進みました (${labelOf(a)})`);
	}

	function labelOf(a) {
		return { measurement: '計測', profile: '断面', volume: '体積', sima: 'SIMA 境界線' }[a.type] || a.type;
	}

	function hookSceneEvents() {
		V.scene.addEventListener('measurement_added', e => recordAction({ type: 'measurement', obj: e.measurement }));
		V.scene.addEventListener('profile_added',     e => recordAction({ type: 'profile',     obj: e.profile }));
		V.scene.addEventListener('volume_added',      e => recordAction({ type: 'volume',      obj: e.volume }));
		V.scene.addEventListener('measurement_removed', e => purge(e.measurement));
		V.scene.addEventListener('profile_removed',     e => purge(e.profile));
		V.scene.addEventListener('volume_removed',      e => purge(e.volume));
	}

	function hookKeyboard() {
		window.addEventListener('keydown', (e) => {
			if (!(e.ctrlKey || e.metaKey)) return;
			const k = e.key.toLowerCase();
			if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
			else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
		});
	}

	// ------------------------------------------------------------
	// 左パネル UI (Potree サイドバーに「現場ツール」 section を追加)
	// ------------------------------------------------------------
	function setStatus(msg, isWarn) {
		const el = document.getElementById('pcs_tools_status');
		if (el) {
			el.textContent = msg;
			el.style.color = isWarn ? '#ffb74d' : '#9adcff';
		}
		console.log('[pcs-tools]', msg);
	}

	function updateHistoryButtons() {
		const u = document.getElementById('pcs_undo');
		const r = document.getElementById('pcs_redo');
		if (u) { u.disabled = undoStack.length === 0; u.style.opacity = u.disabled ? 0.45 : 1; }
		if (r) { r.disabled = redoStack.length === 0; r.style.opacity = r.disabled ? 0.45 : 1; }
	}

	function refreshSimaList() {
		const el = $('#pcs_sima_list');
		if (!el.length) return;
		el.empty();
		for (const g of SIMA_GROUPS) {
			const row = $(`
				<div style="display:flex; align-items:center; gap:6px; padding:2px 0;">
					<span style="color:#ff5252;">━</span>
					<span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${g.name.replace('SIMA: ', '')}</span>
					<input type="button" value="削除" style="width:auto;"/>
				</div>
			`);
			row.find('input').click(() => { removeSimaGroup(g); purge(g); setStatus('境界線を削除しました'); });
			el.append(row);
		}
	}

	function buildSidebarSection() {
		const section = $(`
			<h3 id="menu_pcs_tools" class="accordion-header ui-widget"><span>現場ツール</span></h3>
			<div class="accordion-content ui-widget pv-menu-list"></div>
		`);
		const content = section.last();
		content.html(`
			<div class="pv-menu-list">
				<div class="divider"><span>SIMA 境界線</span></div>
				<input id="pcs_sima_import" type="button" value="SIMA 読込 (境界線を赤線表示)" style="width:100%;"/>
				<div id="pcs_sima_list"></div>
				<div class="divider"><span>編集履歴</span></div>
				<span style="display:flex; gap:6px;">
					<input id="pcs_undo" type="button" value="← 一つ戻る" style="flex:1;" title="Ctrl+Z"/>
					<input id="pcs_redo" type="button" value="一つ進む →" style="flex:1;" title="Ctrl+Y"/>
				</span>
				<div id="pcs_tools_status" style="padding:4px 0; min-height:1.3em; font-size:90%;"></div>
			</div>
		`);
		section.first().click(() => content.slideToggle());
		section.insertBefore($('#menu_appearance'));
		content.show();
		$('#pcs_sima_import').click(pickSimaFile);
		$('#pcs_undo').click(undo);
		$('#pcs_redo').click(redo);
		updateHistoryButtons();
	}

	// ------------------------------------------------------------
	window.initPcsTools = function (viewer) {
		V = viewer;
		if (typeof THREE === 'undefined') {
			console.error('[pcs-tools] three.min.js が読み込まれていません');
			return;
		}
		buildSidebarSection();
		hookSceneEvents();
		hookKeyboard();
		setStatus('準備完了');
	};

	// 自動テスト・将来機能用の内部 handle
	window.PCS_TOOLS = {
		parseSima, importSimaText, importSimaFromPath,
		undo, redo,
		get simaGroups() { return SIMA_GROUPS; },
		get undoCount() { return undoStack.length; },
		get redoCount() { return redoStack.length; },
	};
})();
