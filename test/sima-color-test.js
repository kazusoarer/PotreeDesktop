// ============================================================
// sima-color-test.js — SIMA 境界の「点群着色」方式の実機検証
// 合成データ: 斜面グリッド (0.5m 間隔、 灰色 120) + 境界直上の塀 (垂直面 z450-460)
// 検証: ①XY 一致点の着色 ②塀 = 全高さ着色 (建物・生垣ケース) ③線幅・線色指定
//       ④一つ戻る/進む で完全復元・再着色 ⑤計測との混在履歴 ⑥左パネル UI
// ============================================================
(async () => {
	const fs = require('fs');
	const os = require('os');
	const path = require('path');
	const T = path.join(os.tmpdir(), 'pcs_t');
	const LOG = process.env.PCS_TEST_LOG || path.join(os.tmpdir(), 'pcs_color_test_log.txt');
	let pass = 0, fail = 0;
	const t0 = Date.now();
	fs.writeFileSync(LOG, '');
	function log(s) {
		const line = `[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`;
		console.log('[pcs-test]', line);
		fs.appendFileSync(LOG, line + '\r\n');
	}
	function check(name, cond, detail) {
		if (cond) { pass++; log(`PASS ${name}`); }
		else { fail++; log(`FAIL ${name}${detail ? ': ' + detail : ''}`); }
	}
	const sleep = (ms) => new Promise(r => setTimeout(r, ms));
	const V = window.viewer;
	const PT = window.PCS_TOOLS;
	const SIM = path.join(T, 'test_drape.sim');   // 標高 0 の SIMA (square E637820-860 N851120-160)

	function loadedPointCount() {
		let n = 0;
		for (const pc of V.scene.pointclouds) pc.traverse(o => { if (o.isPoints && o.geometry) n += o.geometry.getAttribute('position').count; });
		return n;
	}
	// 指定位置付近の点の色 [r,g,b] を返す
	function pointColorAt(ex, ny, zMin, zMax) {
		let res = null;
		const v = new THREE.Vector3();
		for (const pc of V.scene.pointclouds) {
			pc.updateMatrixWorld(true);
			pc.traverse(o => {
				if (res || !o.isPoints || !o.geometry) return;
				const pa = o.geometry.getAttribute('position');
				const ca = o.geometry.getAttribute('rgba') || o.geometry.getAttribute('color');
				if (!pa || !ca) return;
				for (let i = 0; i < pa.count; i++) {
					v.fromBufferAttribute(pa, i).applyMatrix4(o.matrixWorld);
					if (Math.abs(v.x - ex) < 0.1 && Math.abs(v.y - ny) < 0.1 && v.z >= zMin && v.z <= zMax) {
						const s = ca.itemSize, off = i * s;
						res = [ca.array[off], ca.array[off + 1], ca.array[off + 2]];
						return;
					}
				}
			});
		}
		return res;
	}
	const isColor = (c, r, g, b) => c && c[0] === r && c[1] === g && c[2] === b;

	try {
		log('=== 点群着色 テスト開始 ===');
		check('C01 HQ 常時 ON', V.useHQ === true);
		// sidebar 構築は loadGUI 完了後 (非同期) のため待つ
		for (let i = 0; i < 40 && !$('#pcs_sima_width').length; i++) await sleep(250);
		check('C02 左パネル: 線幅・線色・読込・戻る/進む',
			$('#potree_sidebar_container #pcs_sima_width').length === 1 &&
			$('#potree_sidebar_container #pcs_sima_color').length === 1 &&
			$('#potree_sidebar_container #pcs_sima_import').length === 1 &&
			$('#potree_sidebar_container #pcs_undo').length === 1 &&
			$('#potree_sidebar_container #pcs_redo').length === 1);

		// SJIS 解析 (画地名)
		{
			const buf = fs.readFileSync(SIM);
			const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
			const parsed = PT.parseSima(new TextDecoder('shift_jis').decode(ab));
			check('C03 Shift_JIS 画地名「ドレープ区画」', parsed.parcels.length === 1 && parsed.parcels[0].name === 'ドレープ区画',
				JSON.stringify(parsed.parcels.map(p => p.name)));
		}

		// 点群読込 (全 node 読込まで待機 = 41,262 点)
		await new Promise((res, rej) => {
			Potree.loadPointCloud(path.join(T, 'slope_converted', 'metadata.json'), 'slope', e => {
				if (!e || !e.pointcloud) { rej(new Error('load failed')); return; }
				V.scene.addPointCloud(e.pointcloud);
				V.fitToScreen();
				res();
			});
		});
		for (let i = 0; i < 60 && loadedPointCount() < 41000; i++) await sleep(500);
		check('C04 点群全 node 読込', loadedPointCount() >= 41000, `loaded=${loadedPointCount()}`);

		// ---- 赤 / 線幅 1.2m で着色 (= グリッド 0.5m を跨ぎ、 幅指定の効果が点数に出る) ----
		const red = PT.importSimaFromPath(SIM, 1.2, '#ff0000');
		check('C05 entry 生成 (線分 4 本)', !!red && red.segments.length === 4 && red.active);
		const matchedRed = red ? red.matched : 0;
		check('C06 着色点数が理論値域 (地表 3 列×4 辺 ~960 + 塀 ~861)', matchedRed > 1300 && matchedRed < 2600, `matched=${matchedRed}`);
		check('C07 境界上の地表点が赤', isColor(pointColorAt(637840, 851120, 440, 455), 255, 0, 0), JSON.stringify(pointColorAt(637840, 851120, 440, 455)));
		check('C08 塀の上部 (z≈460) も赤 = 全高さ着色', isColor(pointColorAt(637840, 851120, 459, 461), 255, 0, 0), JSON.stringify(pointColorAt(637840, 851120, 459, 461)));
		check('C09 境界から離れた点は元色 (灰 120)', isColor(pointColorAt(637840, 851140, 440, 455), 120, 120, 120), JSON.stringify(pointColorAt(637840, 851140, 440, 455)));

		// ---- 一つ戻る / 進む ----
		$('#pcs_undo').click();
		check('C10 戻る → 元色に完全復元', isColor(pointColorAt(637840, 851120, 440, 455), 120, 120, 120) && !red.active);
		$('#pcs_redo').click();
		await sleep(100);
		check('C11 進む → 再着色', isColor(pointColorAt(637840, 851120, 440, 455), 255, 0, 0) && red.active);

		// ---- 削除 (一覧の削除ボタン) ----
		$('#pcs_sima_list input[value="削除"]').click();
		check('C12 削除 → 復元 + 一覧空 + 履歴からも除去', PT.simaEntries.length === 0 && PT.undoCount === 0 &&
			isColor(pointColorAt(637840, 851120, 440, 455), 120, 120, 120));

		// ---- 緑 / 線幅 0.1m (= 線幅・線色の指定が効くか) ----
		const green = PT.importSimaFromPath(SIM, 0.1, '#00cc00');
		check('C13 緑で着色', isColor(pointColorAt(637840, 851120, 440, 455), 0, 204, 0), JSON.stringify(pointColorAt(637840, 851120, 440, 455)));
		check('C14 線幅 0.1 < 1.2 で着色点数が減る', green.matched > 0 && green.matched < matchedRed * 0.7, `green=${green.matched} red=${matchedRed}`);

		// ---- 計測との混在履歴 + Ctrl キー ----
		const m = new Potree.Measure();
		m.addMarker(new THREE.Vector3(637840, 851140, 452));
		m.addMarker(new THREE.Vector3(637850, 851140, 452));
		V.scene.addMeasurement(m);
		check('C15 履歴 = SIMA + 計測 = 2', PT.undoCount === 2);
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }));
		await sleep(100);
		check('C16 Ctrl+Z → 計測だけ消える (緑は残る)', V.scene.measurements.length === 0 && isColor(pointColorAt(637840, 851120, 440, 455), 0, 204, 0));
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }));
		await sleep(100);
		check('C17 Ctrl+Z ×2 → 緑も解除', isColor(pointColorAt(637840, 851120, 440, 455), 120, 120, 120));
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true }));
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true }));
		await sleep(100);
		check('C18 Ctrl+Y ×2 → 両方復活', V.scene.measurements.length === 1 && isColor(pointColorAt(637840, 851120, 440, 455), 0, 204, 0));

		// ---- 読込後の線幅変更 (一覧の幅入力欄) ----
		const matchedNarrow = green.matched;
		const wInput = $('#pcs_sima_list .pcs-row-width');
		check('C19 一覧に線幅入力欄', wInput.length === 1 && parseFloat(wInput.val()) === 0.1);
		wInput.val('1.2').trigger('change');
		await sleep(100);
		check('C20 幅 0.1→1.2 で着色点数が増える (再着色)', green.widthM === 1.2 && green.matched > matchedNarrow * 1.5,
			`narrow=${matchedNarrow} wide=${green.matched}`);
		check('C21 広げた幅でも色は緑のまま', isColor(pointColorAt(637840, 851120.5, 440, 455), 0, 204, 0),
			JSON.stringify(pointColorAt(637840, 851120.5, 440, 455)));
		$('#pcs_sima_list .pcs-row-width').val('0.1').trigger('change');
		await sleep(100);
		check('C22 幅を戻すと隣接列は元色に復元', green.widthM === 0.1 && isColor(pointColorAt(637840, 851120.5, 440, 455), 120, 120, 120),
			JSON.stringify(pointColorAt(637840, 851120.5, 440, 455)));

		log(`=== 完了: PASS ${pass} / FAIL ${fail} (全 ${pass + fail}) ===`);
	} catch (err) {
		log('HARNESS ERROR: ' + (err && err.stack || err));
		log(`=== 完了: PASS ${pass} / FAIL ${fail} + ERROR ===`);
	}
	await sleep(1000);
	window.close();
})();
