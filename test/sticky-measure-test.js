// ============================================================
// sticky-measure-test.js — 連続計測モードの実機検証
//   ①アイコンのトグル/ハイライト ②規定点数到達で自動再開始 (Point = 1 点)
//   ③右クリックで確定 → 次を自動開始 (Distance) ④空計測のゴミ掃除
//   ⑤解除クリックで停止 ⑥他アイコンで解除
// ============================================================
(async () => {
	const fs = require('fs');
	const os = require('os');
	const path = require('path');
	const LOG = process.env.PCS_TEST_LOG || path.join(os.tmpdir(), 'pcs_sticky_test_log.txt');
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
	const icon = (name) => $('#tools img').filter((i, e) => (e.src || '').endsWith('/icons/' + name));
	const mouseUp = (button) => V.renderer.domElement.dispatchEvent(new MouseEvent('mouseup', { button }));

	try {
		log('=== 連続計測テスト開始 ===');
		for (let i = 0; i < 40 && !$('#pcs_sima_width').length; i++) await sleep(250);

		// ---- ① トグルとハイライト (Point) ----
		const ptIcon = icon('point.svg');
		check('K01 Point アイコン存在', ptIcon.length === 1);
		const n0 = V.scene.measurements.length;
		ptIcon.click();
		check('K02 ON でハイライト + 計測開始', ptIcon.hasClass('pcs-sticky-on') && PT.sticky.active &&
			V.scene.measurements.length === n0 + 1);

		// ---- ② 規定点数到達 → 自動で次を開始 ----
		const m1 = PT.sticky.measure;
		m1.addMarker(new THREE.Vector3(0, 0, 0));   // 1 点置く (= Point は完了)
		mouseUp(0);
		await sleep(200);
		check('K03 1 点確定で次の計測が自動開始', V.scene.measurements.length === n0 + 2 &&
			PT.sticky.measure !== m1, `count=${V.scene.measurements.length - n0}`);
		const m2 = PT.sticky.measure;
		m2.addMarker(new THREE.Vector3(1, 1, 0));
		mouseUp(0);
		await sleep(200);
		check('K04 連続 2 点目も自動継続', V.scene.measurements.length === n0 + 3);

		// ---- ⑤ 解除クリック ----
		ptIcon.click();
		await sleep(100);
		check('K05 解除でハイライト消灯 + 空計測掃除', !ptIcon.hasClass('pcs-sticky-on') && !PT.sticky.active &&
			V.scene.measurements.filter(m => m.points.length === 0).length === 0);
		const nAfterOff = V.scene.measurements.length;
		mouseUp(0);
		await sleep(200);
		check('K06 解除後は mouseup でも何も起きない', V.scene.measurements.length === nAfterOff);

		// ---- ③ 右クリック確定 → 次を自動開始 (Distance = 無制限点数) ----
		const distIcon = icon('distance.svg');
		distIcon.click();
		const d1 = PT.sticky.measure;
		check('K07 Distance ON', distIcon.hasClass('pcs-sticky-on') && d1 && d1.name === 'Distance');
		d1.addMarker(new THREE.Vector3(0, 0, 0));
		d1.addMarker(new THREE.Vector3(5, 0, 0));
		mouseUp(2);   // 右クリック = 確定
		await sleep(200);
		check('K08 右クリック確定で次の Distance が自動開始', PT.sticky.active && PT.sticky.measure !== d1 &&
			d1.points.length >= 1);
		// 点を置かず右クリック → 空計測はゴミにならない
		const dEmpty = PT.sticky.measure;
		mouseUp(2);
		await sleep(200);
		check('K09 空のまま確定 → ゴミ計測を残さない', !V.scene.measurements.includes(dEmpty) && PT.sticky.active);

		// ---- ⑥ 他アイコンで解除 ----
		icon('volume.svg').click();
		await sleep(100);
		check('K10 他ツールのクリックで連続モード解除', !PT.sticky.active && !distIcon.hasClass('pcs-sticky-on'));
		V.dispatchEvent({ type: 'cancel_insertions' });   // volume 挿入の後始末

		// ---- 切替: ON のまま別の計測アイコン ----
		ptIcon.click();
		const beforeSwitch = PT.sticky.icon;
		icon('area.svg').click();
		check('K11 別計測アイコンへ直接切替', beforeSwitch === 'point.svg' && PT.sticky.icon === 'area.svg' &&
			!ptIcon.hasClass('pcs-sticky-on') && icon('area.svg').hasClass('pcs-sticky-on'));
		icon('area.svg').click();
		check('K12 切替先も解除可能', !PT.sticky.active);

		log(`=== 完了: PASS ${pass} / FAIL ${fail} (全 ${pass + fail}) ===`);
	} catch (err) {
		log('HARNESS ERROR: ' + (err && err.stack || err));
		log(`=== 完了: PASS ${pass} / FAIL ${fail} + ERROR ===`);
	}
	await sleep(800);
	window.close();
})();
