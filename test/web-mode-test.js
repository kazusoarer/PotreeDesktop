// ============================================================
// web-mode-test.js — URL 公開された viewer (Web mode) の実走検証
//   built viewer (viewer-config.js 注入済み) を HTTP 配信で開き、 以下を確認:
//   ①Web mode 判定/デスクトップ UI 非表示 ②点群読込 ③公開時の編集状態 (計測/視点) 復元
//   ④相手方も計測 UI・連続計測が使える ⑤相手方も SIMA 追加読込 (着色) ができる
//   ⑥SIMA 出力も動く ⑦HQ/FOV 設定
// ============================================================
(async () => {
	const fs = require('fs');
	const os = require('os');
	const path = require('path');
	const LOG = process.env.PCS_TEST_LOG || path.join(os.tmpdir(), 'pcs_web_test_log.txt');
	let pass = 0, fail = 0;
	fs.writeFileSync(LOG, '');
	function log(s) { console.log('[pcs-test]', s); fs.appendFileSync(LOG, s + '\r\n'); }
	function check(name, cond, detail) {
		if (cond) { pass++; log(`PASS ${name}`); }
		else { fail++; log(`FAIL ${name}${detail ? ': ' + detail : ''}`); }
	}
	const sleep = (ms) => new Promise(r => setTimeout(r, ms));
	async function until(fn, timeout, what) {
		const s = Date.now();
		while (Date.now() - s < timeout) { try { if (fn()) return true; } catch (_) {} await sleep(300); }
		log('TIMEOUT: ' + what);
		return false;
	}
	const V = window.viewer;
	const PT = window.PCS_TOOLS;

	function loadedPointCount() {
		let n = 0;
		for (const pc of V.scene.pointclouds) pc.traverse(o => { if (o.isPoints && o.geometry) n += o.geometry.getAttribute('position').count; });
		return n;
	}

	try {
		log('=== Web mode 実走テスト開始 ===');
		check('W01 Web mode 判定 (pcs-web-mode)', document.body.classList.contains('pcs-web-mode'));
		await until(() => $('#pcs_sima_width').length === 1, 15000, 'sidebar 構築');
		check('W02 デスクトップ専用 UI なし (現場 section / PCS_DESKTOP)',
			$('#menu_pcs_site').length === 0 && typeof window.PCS_DESKTOP === 'undefined');
		check('W03 現場ツール (SIMA/戻る進む/出力) は相手方にも表示',
			$('#pcs_sima_import').length === 1 && $('#pcs_undo').length === 1 && $('#pcs_sima_export').length === 1);
		check('W04 ドロップ投入画面は非表示',
			getComputedStyle(document.getElementById('pointcloud_file_dropzone')).display === 'none');

		// 点群読込 (viewer-config の URL 経由)
		const okCloud = await until(() => V.scene.pointclouds.length === 1, 60000, '点群読込');
		check('W05 公開点群の読込', okCloud);
		await until(() => loadedPointCount() > 40000, 60000, '全 node 読込');

		// 公開時の編集状態の復元 (scene 埋め込み)
		const okScene = await until(() => V.scene.measurements.length === 1, 20000, 'scene 復元');
		check('W06 公開時の計測が復元', okScene && V.scene.measurements[0].name === 'テスト距離',
			okScene && V.scene.measurements[0].name);
		check('W07 公開時の視点が復元 (z≈520)', Math.abs(V.scene.view.position.z - 520) < 5,
			String(V.scene.view.position.z));
		check('W08 表示設定 (HQ + FOV40)', V.useHQ === true && Math.round(V.getFOV()) === 40,
			`hq=${V.useHQ} fov=${V.getFOV()}`);

		// 相手方の操作: 連続計測
		const ptIcon = $('#tools img').filter((i, e) => (e.src || '').endsWith('/icons/point.svg'));
		ptIcon.click();
		check('W09 相手方も連続計測を使える', ptIcon.hasClass('pcs-sticky-on') && PT.sticky.active);
		PT.sticky.measure.addMarker(new THREE.Vector3(637840, 851140, 452));
		V.renderer.domElement.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
		await sleep(200);
		check('W10 計測の追加が動作', V.scene.measurements.length >= 2);
		ptIcon.click();

		// 相手方の SIMA 追加読込 (= ブラウザと同じ text 経由の読込 → 点群着色)
		{
			const buf = fs.readFileSync(path.join(os.tmpdir(), 'pcs_t', 'test_drape.sim'));
			const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
			const text = new TextDecoder('shift_jis').decode(ab);
			const en = PT.importSimaText(text, 'test_drape.sim', 0.4, '#ff0000');
			await sleep(1500);
			check('W11 相手方も SIMA 追加読込 → 点群着色できる', !!en && en.matched > 500, en && String(en.matched));
		}

		// SIMA 出力 (Web では download になるため生成のみ検証)
		const r = PT.buildSimaText('Web テスト');
		check('W12 相手方も SIMA 出力を生成できる', !!r && r.points >= 1);

		log(`=== 完了: PASS ${pass} / FAIL ${fail} (全 ${pass + fail}) ===`);
	} catch (err) {
		log('HARNESS ERROR: ' + (err && err.stack || err));
		log(`=== 完了: PASS ${pass} / FAIL ${fail} + ERROR ===`);
	}
	await sleep(800);
	window.close();
})();
