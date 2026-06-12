// ============================================================
// pcs-tools.js — 現場ツール v2 (点群着色方式)
//   1. SIMA (.sim) 読込 → 境界線と水平位置 (XY) が一致する「点群の点そのもの」を着色。
//      高さは問わない (= 建物・生垣・電線も境界直上なら着色される)。
//      点群表面に完全フィットした境界線が自然に描かれる (友人版と同方式)。
//   2. 読込時に着色線幅 (m) と線色を左パネルで指定できる。
//   3. 一つ戻る / 一つ進む (計測・体積・断面・SIMA 着色の履歴)。
//   4. ボタンは全て左パネル (Potree サイドバー) の「現場ツール」 section。
// 技術メモ: Potree 1.8 の Renderer は attribute.version を毎フレーム比較して
//           GPU バッファを再 upload するため、 rgba 属性の書換え + needsUpdate で
//           実行中の再着色が画面に反映される (potree.js L63298 で確認済)。
// ============================================================
(function () {
	'use strict';

	let V = null;
	const SIMA_ENTRIES = [];        // {label, segments, bbox, halfW, rgb:[r,g,b], colorHex, widthM, active, processed(WeakSet), backups(Map), matched}
	const GRID_CELL = 4.0;          // 線分検索グリッド (m)
	let processTimer = null;

	// ------------------------------------------------------------
	// SIMA 共通フォーマット解析
	//   A01,点番号,点名,X(北 m),Y(東 m)[,標高 m]   … 座標レコード
	//   D00,画地番号,画地名,…                      … 画地 (区画) 開始
	//   B01,…                                      … 画地の構成点 (A01 の点番号を参照)
	//   D99                                         … 画地終了
	// 座標系: SIMA は X=北 / Y=東 (測量系)。 viewer 世界は x=東 / y=北 → 入替える。
	// 標高は使わない (= 着色は水平位置のみで判定するため、 標高 0 の SIMA でも正しく動く)。
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
				if (id && isFinite(X) && isFinite(Y)) {
					points.set(id, { e: Y, n: X, name: f[2] || id });
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
			const p = points.get(f[1]) || points.get(f[2]);   // 点番号位置の揺れに両対応
			if (p) out.push(p);
		}
		return out;
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

	// ------------------------------------------------------------
	// 境界線分の構築 + 空間グリッド (= 点ごとの距離判定を近傍線分だけに絞る)
	// ------------------------------------------------------------
	function buildSegments(parsed) {
		const segments = [];
		let skipped = 0;
		for (const parcel of parsed.parcels) {
			const pts = resolveParcelPoints(parcel, parsed.points);
			if (pts.length < 2) { skipped++; continue; }
			for (let i = 0; i < pts.length; i++) {
				const a = pts[i], b = pts[(i + 1) % pts.length];   // 閉合
				segments.push({ ax: a.e, ay: a.n, bx: b.e, by: b.n });
			}
		}
		return { segments, skipped };
	}

	function buildSegmentGrid(segments, halfW) {
		const grid = new Map();
		const pad = halfW + 0.01;
		segments.forEach((s, idx) => {
			const minX = Math.min(s.ax, s.bx) - pad, maxX = Math.max(s.ax, s.bx) + pad;
			const minY = Math.min(s.ay, s.by) - pad, maxY = Math.max(s.ay, s.by) + pad;
			for (let ix = Math.floor(minX / GRID_CELL); ix <= Math.floor(maxX / GRID_CELL); ix++) {
				for (let iy = Math.floor(minY / GRID_CELL); iy <= Math.floor(maxY / GRID_CELL); iy++) {
					const key = ix + '_' + iy;
					let arr = grid.get(key);
					if (!arr) { arr = []; grid.set(key, arr); }
					arr.push(idx);
				}
			}
		});
		return grid;
	}

	function distToSegment2D(px, py, s) {
		const dx = s.bx - s.ax, dy = s.by - s.ay;
		const L2 = dx * dx + dy * dy;
		let t = L2 > 0 ? ((px - s.ax) * dx + (py - s.ay) * dy) / L2 : 0;
		t = Math.max(0, Math.min(1, t));
		const qx = s.ax + t * dx, qy = s.ay + t * dy;
		return Math.hypot(px - qx, py - qy);
	}

	// ------------------------------------------------------------
	// 着色エンジン
	//   読込済み octree node (THREE.Points) の rgba 属性を直接書換える。
	//   ナビゲーションで新しい node が読み込まれても、 定期処理が自動で追い着色する。
	//   元色は backup に保持し、「一つ戻る」「削除」で完全復元できる。
	// ------------------------------------------------------------
	function entryBBox(segments, halfW) {
		let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
		for (const s of segments) {
			minX = Math.min(minX, s.ax, s.bx); maxX = Math.max(maxX, s.ax, s.bx);
			minY = Math.min(minY, s.ay, s.by); maxY = Math.max(maxY, s.ay, s.by);
		}
		return { minX: minX - halfW, maxX: maxX + halfW, minY: minY - halfW, maxY: maxY + halfW };
	}

	function colorizeGeometry(entry, obj) {
		const geo = obj.geometry;
		const posAttr = geo.getAttribute('position');
		const colAttr = geo.getAttribute('rgba') || geo.getAttribute('color');
		if (!posAttr || !colAttr) return 0;
		const stride = colAttr.itemSize;
		const arr = colAttr.array;
		const v = new THREE.Vector3();
		const bb = entry.bbox;
		const indices = [];
		const orig = [];
		for (let i = 0; i < posAttr.count; i++) {
			v.fromBufferAttribute(posAttr, i).applyMatrix4(obj.matrixWorld);
			if (v.x < bb.minX || v.x > bb.maxX || v.y < bb.minY || v.y > bb.maxY) continue;
			const key = Math.floor(v.x / GRID_CELL) + '_' + Math.floor(v.y / GRID_CELL);
			const cand = entry.grid.get(key);
			if (!cand) continue;
			let hit = false;
			for (const si of cand) {
				if (distToSegment2D(v.x, v.y, entry.segments[si]) <= entry.halfW) { hit = true; break; }
			}
			if (!hit) continue;
			const o = i * stride;
			indices.push(i);
			orig.push(arr[o], arr[o + 1], arr[o + 2]);
			arr[o] = entry.rgb[0];
			arr[o + 1] = entry.rgb[1];
			arr[o + 2] = entry.rgb[2];
		}
		if (indices.length) {
			colAttr.needsUpdate = true;
			entry.backups.set(geo, { attr: colAttr, indices, orig });
		}
		return indices.length;
	}

	function processEntries() {
		const actives = SIMA_ENTRIES.filter(e => e.active);
		if (!actives.length || !V || !V.scene.pointclouds.length) return;
		let newly = 0;
		for (const pc of V.scene.pointclouds) {
			pc.updateMatrixWorld(true);
			pc.traverse((obj) => {
				if (!obj.isPoints || !obj.geometry) return;
				for (const entry of actives) {
					if (entry.processed.has(obj.geometry)) continue;
					entry.processed.add(obj.geometry);
					// node の世界 bbox が範囲外なら走査自体を省略
					if (obj.geometry.boundingBox) {
						const nb = obj.geometry.boundingBox.clone().applyMatrix4(obj.matrixWorld);
						if (nb.max.x < entry.bbox.minX || nb.min.x > entry.bbox.maxX ||
						    nb.max.y < entry.bbox.minY || nb.min.y > entry.bbox.maxY) continue;
					}
					const n = colorizeGeometry(entry, obj);
					if (n > 0) { entry.matched += n; newly += n; }
				}
			});
		}
		if (newly > 0) refreshSimaList();
	}

	function ensureProcessTimer() {
		if (processTimer == null) {
			processTimer = setInterval(() => {
				if (!SIMA_ENTRIES.some(e => e.active)) { clearInterval(processTimer); processTimer = null; return; }
				processEntries();   // 新しく読み込まれた LOD node へ追い着色
			}, 1200);
		}
	}

	// 着色した点を元の色へ書き戻す (UI 状態は触らない)
	function restoreColors(entry) {
		for (const [geo, b] of entry.backups) {
			const arr = b.attr.array;
			const stride = b.attr.itemSize;
			for (let k = 0; k < b.indices.length; k++) {
				const o = b.indices[k] * stride;
				arr[o] = b.orig[k * 3];
				arr[o + 1] = b.orig[k * 3 + 1];
				arr[o + 2] = b.orig[k * 3 + 2];
			}
			b.attr.needsUpdate = true;
		}
		entry.backups = new Map();
		entry.processed = new WeakSet();
		entry.matched = 0;
	}

	// 元の色に戻す (= 一つ戻る / 削除)。 既に unload された node は再読込時に元色で戻るため対象外で OK。
	function restoreEntry(entry) {
		restoreColors(entry);
		entry.active = false;
		refreshSimaList();
	}

	// 読込後の線色変更: 着色済みの点 (対象は幅不変なので同じ) を新色で塗り直すだけ。
	// backup の元色はそのまま保持されるため、 後から戻る/削除しても完全復元できる。
	function setEntryColor(entry, hex) {
		entry.colorHex = hex;
		entry.rgb = hexToRgb(hex);
		for (const [geo, b] of entry.backups) {
			const arr = b.attr.array;
			const stride = b.attr.itemSize;
			for (const i of b.indices) {
				const o = i * stride;
				arr[o] = entry.rgb[0];
				arr[o + 1] = entry.rgb[1];
				arr[o + 2] = entry.rgb[2];
			}
			b.attr.needsUpdate = true;
		}
		if (window.PCS_PROJECT) window.PCS_PROJECT.markDirty();
	}

	// ラベルのリネーム (表示名のみ。 着色・履歴には影響しない)
	function renameEntry(entry, name) {
		const v = (name || '').trim();
		if (!v) return;
		entry.label = v;
		refreshSimaList();
		if (window.PCS_PROJECT) window.PCS_PROJECT.markDirty();
	}

	// 読込後の線幅変更: 元色に戻してから新しい幅で即座に着色し直す
	function setEntryWidth(entry, w) {
		if (!isFinite(w) || w <= 0) { setStatus('線幅は 0 より大きい数値 (m) で指定してください', true); return; }
		restoreColors(entry);
		entry.widthM = w;
		entry.halfW = w / 2;
		entry.bbox = entryBBox(entry.segments, entry.halfW);
		entry.grid = buildSegmentGrid(entry.segments, entry.halfW);
		if (entry.active) {
			ensureProcessTimer();
			processEntries();
		}
		if (window.PCS_PROJECT) window.PCS_PROJECT.markDirty();
	}

	function activateEntry(entry) {
		entry.active = true;
		ensureProcessTimer();
		processEntries();
		refreshSimaList();
	}

	function deleteEntry(entry) {
		restoreEntry(entry);
		const i = SIMA_ENTRIES.indexOf(entry);
		if (i >= 0) SIMA_ENTRIES.splice(i, 1);
		purge(entry);
		refreshSimaList();
		if (window.PCS_PROJECT) window.PCS_PROJECT.markDirty();
	}

	// ------------------------------------------------------------
	// 読込フロー (線幅・線色は左パネルの入力欄から)
	// ------------------------------------------------------------
	function hexToRgb(hex) {
		const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
		const n = m ? parseInt(m[1], 16) : 0xff0000;
		return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
	}

	function currentWidth() {
		const v = parseFloat($('#pcs_sima_width').val());
		return isFinite(v) && v > 0 ? v : 0.2;
	}
	function currentColor() {
		return $('#pcs_sima_color').val() || '#ff0000';
	}

	function importSimaText(text, label, widthM, colorHex, opts) {
		const parsed = parseSima(text);
		if (parsed.parcels.length === 0) {
			setStatus(`画地データ (D00) がありません (座標点 ${parsed.points.size} 点のみ)。着色できません`, true);
			return null;
		}
		const { segments, skipped } = buildSegments(parsed);
		if (!segments.length) {
			setStatus('画地はありますが構成点を解決できませんでした (A01 と B01 の点番号を確認してください)', true);
			return null;
		}
		const w = (widthM != null) ? widthM : currentWidth();
		const col = colorHex || currentColor();
		const halfW = w / 2;
		const entry = {
			label, segments, halfW, widthM: w,
			colorHex: col, rgb: hexToRgb(col),
			simText: text,                       // 現場保存用 (= 現場ファイルへ埋め込む)
			bbox: entryBBox(segments, halfW),
			grid: buildSegmentGrid(segments, halfW),
			active: true,
			processed: new WeakSet(),
			backups: new Map(),
			matched: 0,
		};
		SIMA_ENTRIES.push(entry);
		if (!(opts && opts.noHistory)) recordAction({ type: 'sima', obj: entry });
		if (window.PCS_PROJECT && !(opts && opts.noHistory)) window.PCS_PROJECT.markDirty();
		ensureProcessTimer();
		processEntries();
		refreshSimaList();
		// 成功時は何も表示しない (ユーザー指示)。 何も起きない理由がある時だけ警告する。
		if (entry.matched === 0) {
			if (!V.scene.pointclouds.length) setStatus('SIMA を登録しました。点群を読み込むと自動で着色されます', true);
			else setStatus('境界位置に一致する点が見つかりません (位置・座標系を確認してください)', true);
		} else {
			setStatus('');
		}
		return entry;
	}

	function importSimaFromPath(filePath, widthM, colorHex) {
		const fs = window.require('fs');
		const path = window.require('path');
		const buf = fs.readFileSync(filePath);
		const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
		return importSimaText(decodeSimaBuffer(ab), path.basename(filePath), widthM, colorHex);
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

	// ------------------------------------------------------------
	// 一つ戻る / 一つ進む
	//   対象 = 追加操作の履歴 (計測 / 体積 / 断面 / SIMA 着色)。
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
			else if (a.type === 'sima') restoreEntry(a.obj);
		} finally { internalOp = false; }
		redoStack.push(a);
		updateHistoryButtons();
	}

	function redo() {
		const a = redoStack.pop();
		if (!a) { setStatus('進む操作がありません'); updateHistoryButtons(); return; }
		internalOp = true;
		try {
			if (a.type === 'measurement') V.scene.addMeasurement(a.obj);
			else if (a.type === 'profile') V.scene.addProfile(a.obj);
			else if (a.type === 'volume') V.scene.addVolume(a.obj);
			else if (a.type === 'sima') activateEntry(a.obj);
		} finally { internalOp = false; }
		undoStack.push(a);
		updateHistoryButtons();
	}

	function labelOf(a) {
		return { measurement: '計測', profile: '断面', volume: '体積', sima: 'SIMA 着色' }[a.type] || a.type;
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
	// 左パネル UI
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
		for (const en of SIMA_ENTRIES) {
			const row = $(`
				<div style="display:flex; align-items:center; gap:5px; padding:2px 0;">
					<input type="color" class="pcs-row-color" value="${en.colorHex}"
						style="width:26px; height:20px; padding:0; flex:none;" title="線色 (変更すると即反映)"/>
					<span class="pcs-row-label" style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; cursor:text;"
						title="${en.matched.toLocaleString()} 点を着色 / ダブルクリックで名前を変更"></span>
					<input type="number" class="pcs-row-width" value="${en.widthM}" min="0.05" step="0.05"
						style="width:56px;" title="着色線幅 (m)。 変更すると即座に着色し直します"/>
					<span>m</span>
					<input type="button" class="pcs-row-del" value="削除" style="width:auto;"/>
				</div>
			`);
			row.find('.pcs-row-label').text(en.label + (en.active ? '' : ' (非表示)'));
			row.find('.pcs-row-color').on('input change', function () { setEntryColor(en, this.value); });
			row.find('.pcs-row-width').on('change', function () { setEntryWidth(en, parseFloat(this.value)); });
			// ラベルをダブルクリック → その場で直接リネーム (Enter 確定 / Esc 取消)
			row.find('.pcs-row-label').on('dblclick', function () {
				const inp = $('<input type="text" style="flex:1; min-width:60px;">').val(en.label);
				$(this).replaceWith(inp);
				inp.focus().select();
				let done = false;
				const commit = () => { if (done) return; done = true; renameEntry(en, inp.val()); };
				inp.on('keydown', (ev) => {
					if (ev.key === 'Enter') commit();
					else if (ev.key === 'Escape') { done = true; refreshSimaList(); }
				});
				inp.on('blur', commit);
			});
			row.find('.pcs-row-del').click(() => { deleteEntry(en); setStatus(''); });
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
				<div class="divider"><span>SIMA 境界線 (点群を着色)</span></div>
				<div style="display:flex; align-items:center; gap:6px; padding:2px 0;">
					<span>線幅</span>
					<input id="pcs_sima_width" type="number" value="0.2" min="0.05" step="0.05" style="width:64px;"/>
					<span>m</span>
					<span style="margin-left:8px;">線色</span>
					<input id="pcs_sima_color" type="color" value="#ff0000" style="width:42px; height:24px; padding:0;"/>
				</div>
				<input id="pcs_sima_import" type="button" value="SIMA 読込 (境界の点を着色)" style="width:100%;"/>
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
	};

	// 自動テスト・将来機能用の内部 handle
	window.PCS_TOOLS = {
		parseSima, importSimaText, importSimaFromPath,
		undo, redo, processEntries, setEntryWidth, setEntryColor, renameEntry,
		get simaEntries() { return SIMA_ENTRIES; },
		get undoCount() { return undoStack.length; },
		get redoCount() { return redoStack.length; },
	};
})();
