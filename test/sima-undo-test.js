// ============================================================
// sima-undo-test.js — 現場ツールの実 UI 自動テスト
// 検証対象: ①HQ 常時 ON ②左パネルに UI ③SIMA 読込→赤線 ④一つ戻る/進む
//           (ボタン click と Ctrl+Z/Y の両経路) ⑤計測との混在履歴 ⑥手動削除の履歴整合
// 実行: 環境変数 PCS_TEST=本ファイル PCS_TEST_LOG=ログ先 で electron 起動
// ============================================================
(async () => {
	const fs = require('fs');
	const os = require('os');
	const path = require('path');
	const T = path.join(os.tmpdir(), 'pcs_t');
	const LOG = process.env.PCS_TEST_LOG || path.join(os.tmpdir(), 'pcs_tools_test_log.txt');
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
	async function until(fn, timeout, what) {
		const s = Date.now();
		while (Date.now() - s < timeout) { try { if (fn()) return true; } catch (_) {} await sleep(200); }
		throw new Error('timeout: ' + what);
	}
	const V = window.viewer;
	const PT = window.PCS_TOOLS;

	try {
		log('=== 現場ツール テスト開始 ===');

		// ---- ① HQ 常時 ON ----
		check('T01 HQ 常時 ON (viewer.useHQ)', V.useHQ === true);

		// ---- 点群読込 (UI と同じ Potree.loadPointCloud 経路) ----
		await new Promise((res, rej) => {
			Potree.loadPointCloud(path.join(T, 'sample_converted', 'metadata.json'), 'sample', e => {
				if (!e || !e.pointcloud) { rej(new Error('load failed')); return; }
				V.scene.addPointCloud(e.pointcloud);
				res();
			});
		});
		check('T02 点群読込', V.scene.pointclouds.length === 1);

		// ---- ② 左パネル UI ----
		check('T03 左パネルに「現場ツール」section', $('#menu_pcs_tools').length === 1);
		check('T04 ボタン 3 種が左パネル内に存在',
			$('#potree_sidebar_container #pcs_sima_import').length === 1 &&
			$('#potree_sidebar_container #pcs_undo').length === 1 &&
			$('#potree_sidebar_container #pcs_redo').length === 1);
		check('T05 初期状態で戻る/進む無効', $('#pcs_undo').prop('disabled') && $('#pcs_redo').prop('disabled'));

		// ---- ③ SIMA 読込 → 赤線 ----
		const group = PT.importSimaFromPath(path.join(T, 'test_boundary.sim'));
		check('T06 SIMA 読込で group 生成', !!group);
		check('T07 画地 2 区画 = 赤線 2 本', group && group.children.length === 2);
		const inScene = () => PT.simaGroups.length === 1 && V.scene.scene.children.includes(group);
		check('T08 シーンに追加済み', inScene());
		if (group) {
			const line = group.children[0];
			check('T09 線が赤色', line.material.color.getHex() === 0xff0000);
			check('T10 線が常時手前表示 (depthTest off)', line.material.depthTest === false);
			// 座標検証: anchor + 相対座標 = ワールド座標 (1 点目 = E637900 N851200 Z450)
			const wp = new THREE.Vector3().fromBufferAttribute(line.geometry.getAttribute('position'), 0).add(group.position);
			check('T11 座標が正しい (E=637900, N=851200)', Math.abs(wp.x - 637900) < 0.01 && Math.abs(wp.y - 851200) < 0.01,
				`got ${wp.x.toFixed(3)}, ${wp.y.toFixed(3)}`);
			check('T12 group 名に file 名', group.name === 'SIMA: test_boundary.sim', group.name);
		}
		// Shift_JIS 復号の直接検証 (= デコーダ経由で画地名が読めるか)
		{
			const buf = fs.readFileSync(path.join(T, 'test_boundary.sim'));
			const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
			const text = new TextDecoder('shift_jis').decode(ab);
			const parsed = PT.parseSima(text);
			check('T13 Shift_JIS 画地名「テスト区画A」', parsed.parcels[0] && parsed.parcels[0].name === 'テスト区画A',
				parsed.parcels[0] && parsed.parcels[0].name);
			check('T14 標高なし点も座標解決 (7 点)', parsed.points.size === 7);
		}

		// ---- ④ 一つ戻る / 進む (ボタン click) ----
		check('T15 SIMA 読込が履歴に記録', PT.undoCount === 1 && !$('#pcs_undo').prop('disabled'));
		$('#pcs_undo').click();
		check('T16 戻る → 赤線が消える', PT.simaGroups.length === 0 && !V.scene.scene.children.includes(group));
		check('T17 戻る後は進むが有効', PT.redoCount === 1 && !$('#pcs_redo').prop('disabled'));
		$('#pcs_redo').click();
		check('T18 進む → 赤線が復活', inScene());

		// ---- ⑤ 計測との混在履歴 ----
		const m = new Potree.Measure();
		m.name = 'テスト距離';
		m.closed = false;
		m.showDistances = true;
		m.addMarker(new THREE.Vector3(637900, 851200, 450));
		m.addMarker(new THREE.Vector3(637950, 851200, 451));
		V.scene.addMeasurement(m);
		check('T19 計測追加が履歴に記録 (SIMA+計測=2)', PT.undoCount === 2);
		$('#pcs_undo').click();
		check('T20 戻る → 計測だけ消える', V.scene.measurements.length === 0 && inScene());
		$('#pcs_undo').click();
		check('T21 もう一度戻る → 赤線も消える', PT.simaGroups.length === 0);
		$('#pcs_redo').click();
		$('#pcs_redo').click();
		check('T22 進む×2 → 両方復活', inScene() && V.scene.measurements.length === 1);

		// ---- Ctrl+Z / Ctrl+Y ----
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }));
		await sleep(100);
		check('T23 Ctrl+Z で一つ戻る', V.scene.measurements.length === 0);
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true }));
		await sleep(100);
		check('T24 Ctrl+Y で一つ進む', V.scene.measurements.length === 1);

		// ---- ⑥ 手動削除と履歴の整合 ----
		V.scene.removeMeasurement(m);   // 手動削除 (= undo 経由でない)
		check('T25 手動削除で履歴から除去 (空振り防止)', PT.undoCount === 1);
		$('#pcs_undo').click();
		check('T26 戻る → 残った SIMA が消える', PT.simaGroups.length === 0);

		log(`=== 完了: PASS ${pass} / FAIL ${fail} (全 ${pass + fail}) ===`);
	} catch (err) {
		log('HARNESS ERROR: ' + (err && err.stack || err));
		log(`=== 完了: PASS ${pass} / FAIL ${fail} + ERROR ===`);
	}
	await sleep(1000);
	window.close();
})();
