// ============================================================
// sima-export-test.js — SIMA 一括出力の実機検証
//   ポイント計測 → A01 / 距離計測 → 結線 = 開放区画 (D00/B01…/D99 非閉合)
//   自動付番 / 座標軸入替 (X=北/Y=東) / Shift-JIS / ファイル出力 / 往復読込
// ============================================================
(async () => {
	const fs = require('fs');
	const os = require('os');
	const path = require('path');
	const LOG = process.env.PCS_TEST_LOG || path.join(os.tmpdir(), 'pcs_export_test_log.txt');
	let pass = 0, fail = 0;
	fs.writeFileSync(LOG, '');
	function log(s) { console.log('[pcs-test]', s); fs.appendFileSync(LOG, s + '\r\n'); }
	function check(name, cond, detail) {
		if (cond) { pass++; log(`PASS ${name}`); }
		else { fail++; log(`FAIL ${name}${detail ? ': ' + detail : ''}`); }
	}
	const sleep = (ms) => new Promise(r => setTimeout(r, ms));
	const V = window.viewer;
	const PT = window.PCS_TOOLS;

	function addPoint(x, y, z) {
		const m = new Potree.Measure();
		m.showCoordinates = true; m.closed = true; m.maxMarkers = 1; m.name = 'Point';
		m.addMarker(new THREE.Vector3(x, y, z));
		V.scene.addMeasurement(m);
		return m;
	}
	function addDistance(pts, name) {
		const m = new Potree.Measure();
		m.showDistances = true; m.closed = false; m.name = name || 'Distance';
		for (const p of pts) m.addMarker(new THREE.Vector3(p[0], p[1], p[2]));
		V.scene.addMeasurement(m);
		return m;
	}

	try {
		log('=== SIMA 出力テスト開始 ===');
		for (let i = 0; i < 40 && !$('#pcs_sima_export').length; i++) await sleep(250);
		check('E01 左パネルに SIMA 出力ボタン', $('#potree_sidebar_container #pcs_sima_export').length === 1);

		// 計測なしの時は警告のみ
		check('E02 計測なしは null (警告)', PT.buildSimaText('試験') === null);

		// ポイント 2 + 距離 2 本 (3 点折線 + 2 点直線)
		addPoint(637900.123, 851200.456, 450.789);                       // → A01,1: X=851200.456 Y=637900.123
		addPoint(637910.000, 851210.000, 451.000);                       // → A01,2
		addDistance([[0, 0, 10], [5, 0, 11], [5, 5, 12]]);               // → A01,3-5 + 結線1
		addDistance([[100, 200, 20], [110, 200, 21]], '法面下端');        // → A01,6-7 + 法面下端

		const r = PT.buildSimaText('テスト現場');
		check('E03 生成成功 (7 点 / 2 結線)', !!r && r.points === 7 && r.parcels === 2, r && `${r.points}/${r.parcels}`);
		const L = r.text.split('\r\n');

		check('E04 ヘッダ G00 + 現場名', L[0] === 'G00,01,テスト現場,', L[0]);
		check('E05 セクション構成', L[1] === 'Z00,座標ﾃﾞｰﾀ,' && L[2] === 'A00,' && L.includes('A99,') &&
			L.includes('Z00,区画ﾃﾞｰﾀ,') && L[L.length - 2] === 'G99,');
		check('E06 A01 自動付番 + 軸入替 (X=北/Y=東) + 標高',
			L[3] === 'A01,1,1,851200.456,637900.123,450.789,,', L[3]);
		check('E07 A01 が 7 本', L.filter(s => s.startsWith('A01,')).length === 7);

		// 結線 = 開放区画
		const d1 = L.indexOf('D00,1,結線1,1,');
		check('E08 結線1 の D00 (自動命名)', d1 > 0, JSON.stringify(L.filter(s => s.startsWith('D00'))));
		check('E09 結線1 = B01×3 (開放 = 閉合点の繰り返しなし)',
			L[d1 + 1] === 'B01,3,3,' && L[d1 + 2] === 'B01,4,4,' && L[d1 + 3] === 'B01,5,5,' && L[d1 + 4] === 'D99,',
			L.slice(d1, d1 + 5).join(' | '));
		const d2 = L.indexOf('D00,2,法面下端,1,');
		check('E10 リネーム済み距離は名前を引き継ぐ', d2 > 0 && L[d2 + 1] === 'B01,6,6,' && L[d2 + 2] === 'B01,7,7,');

		// Shift-JIS 検証 (encode → TextDecoder で復号一致)
		const bytes = PT.encodeShiftJis(r.text);
		const back = new TextDecoder('shift-jis').decode(bytes);
		check('E11 Shift-JIS 往復一致 (日本語含む)', back === r.text);
		check('E12 SJIS バイト確認 (「テ」= 0x83 0x65)', (() => {
			const t = PT.encodeShiftJis('テ');
			return t.length === 2 && t[0] === 0x83 && t[1] === 0x65;
		})());

		// ファイル出力 (テストは明示パス指定。 UI 経路は保存ダイアログ = 自動化不可のため
		// download anchor の生成までを別途確認)
		const out = PT.exportSima(path.join(os.tmpdir(), 'pcs_export_test.sim'));
		check('E13 ファイル出力成功 (.sim)', out && fs.existsSync(out) && out.endsWith('.sim'), out);
		if (out) {
			const buf = fs.readFileSync(out);
			const text = new TextDecoder('shift-jis').decode(buf);
			check('E14 出力ファイルも SJIS で読める', text.startsWith('G00,01,') && text.includes('Z00,区画ﾃﾞｰﾀ,'));
			// 往復: 自前の SIMA 読込 (着色) パーサで画地 2 件と認識される
			const parsed = PT.parseSima(text);
			check('E15 往復読込 (画地 2 / 点 7)', parsed.parcels.length === 2 && parsed.points.size === 7,
				`${parsed.parcels.length}/${parsed.points.size}`);
			fs.unlinkSync(out);
		}

		// 後始末
		for (const m of [...V.scene.measurements]) V.scene.removeMeasurement(m);

		log(`=== 完了: PASS ${pass} / FAIL ${fail} (全 ${pass + fail}) ===`);
	} catch (err) {
		log('HARNESS ERROR: ' + (err && err.stack || err));
		log(`=== 完了: PASS ${pass} / FAIL ${fail} + ERROR ===`);
	}
	await sleep(800);
	window.close();
})();
