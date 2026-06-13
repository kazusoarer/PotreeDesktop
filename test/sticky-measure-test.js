// ============================================================
// sticky-measure-test.js — 全計測ツールの連続計測 点検 (2026-06-12 不具合修正後)
// 不具合: 規定点数 2 以上のツール (高さ/角度/円/方位) で、 浮いている未確定点が
//         点数に含まれるため自動再開始が 1 手早く発火し、 最終点のドラッグを
//         横取りして座標が壊れていた → クリック回数 = 規定点数 方式に修正。
// 点検: 各ツールで「完了前に再開始しない / 完了で再開始する」を 1 つずつ確認。
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
	const mouseUp = async (button) => {
		V.renderer.domElement.dispatchEvent(new MouseEvent('mouseup', { button }));
		await sleep(120);
	};

	// 規定点数 N のツール: N-1 回のクリックでは再開始せず、 N 回目で再開始すること
	async function checkFiniteTool(name, iconFile, mm) {
		const el = icon(iconFile);
		if (!el.length) { check(`${name}: アイコン存在`, false); return; }
		el.click();
		const m0 = PT.sticky.measure;
		check(`${name}: ON + 挿入開始`, el.hasClass('pcs-sticky-on') && !!m0 && m0.maxMarkers === mm,
			m0 && String(m0.maxMarkers));
		// 完了前 (N-1 クリック) は再開始しない = 最終点のドラッグを横取りしない
		for (let c = 1; c <= mm - 1; c++) {
			await mouseUp(0);
			check(`${name}: ${c}/${mm} クリック時点では継続中 (再開始しない)`, PT.sticky.measure === m0,
				'premature restart');
		}
		// N クリック目で完了 → 自動で次の挿入が始まる
		await mouseUp(0);
		check(`${name}: ${mm}/${mm} クリックで完了 → 次を自動開始`, PT.sticky.measure !== m0 && PT.sticky.active);
		el.click();   // OFF
		check(`${name}: 解除`, !el.hasClass('pcs-sticky-on') && !PT.sticky.active);
	}

	// 無制限ツール: 左クリックでは再開始せず、 右クリック確定で再開始すること
	async function checkInfiniteTool(name, iconFile, isProfile) {
		const el = icon(iconFile);
		if (!el.length) { check(`${name}: アイコン存在`, false); return; }
		el.click();
		const m0 = PT.sticky.measure;
		check(`${name}: ON + 挿入開始`, el.hasClass('pcs-sticky-on') && !!m0);
		await mouseUp(0);
		await mouseUp(0);
		check(`${name}: 左クリックでは継続中`, PT.sticky.measure === m0);
		await mouseUp(2);
		check(`${name}: 右クリック 1 回で確定 → 次を自動開始 (継続)`, PT.sticky.measure !== m0 && PT.sticky.active);
		// 続けて右クリック 2 回目 = 完全解除
		const mEmpty = PT.sticky.measure;
		await mouseUp(2);
		const list = isProfile ? V.scene.profiles : V.scene.measurements;
		check(`${name}: 右クリック 2 回目で完全解除 + ゴミなし`,
			!PT.sticky.active && !el.hasClass('pcs-sticky-on') && !list.includes(mEmpty));
		check(`${name}: 解除`, !PT.sticky.active);
	}

	try {
		log('=== 全計測ツール点検 開始 ===');
		for (let i = 0; i < 40 && !$('#pcs_sima_width').length; i++) await sleep(250);

		await checkFiniteTool('座標 (Point)',    'point.svg',   1);
		await checkFiniteTool('高さ (Height)',   'height.svg',  2);
		await checkFiniteTool('方位 (Azimuth)',  'azimuth.svg', 2);
		await checkFiniteTool('角度 (Angle)',    'angle.png',   3);
		await checkFiniteTool('円 (Circle)',     'circle.svg',  3);
		await checkInfiniteTool('距離 (Distance)', 'distance.svg', false);
		await checkInfiniteTool('面積 (Area)',     'area.svg',     false);
		await checkInfiniteTool('断面 (Profile)',  'profile.svg',  true);

		// 高さ計測の品質: 完了した高さ計測の 2 点が同一座標で壊れていないこと
		{
			const hIcon = icon('height.svg');
			hIcon.click();
			const m = PT.sticky.measure;
			m.setPosition(0, new THREE.Vector3(10, 10, 100));
			await mouseUp(0);   // 1 点目確定 (2 点目の浮き点が clone される)
			m.setPosition(1, new THREE.Vector3(10, 10, 130));   // 2 点目を移動 (ドラッグ相当)
			await mouseUp(0);   // 2 点目確定 → 完了
			const done = V.scene.measurements.find(x => x === m);
			const dz = done ? Math.abs(done.points[1].position.z - done.points[0].position.z) : -1;
			check('高さ計測の 2 点が壊れていない (高低差 30m)', done && done.points.length === 2 && Math.abs(dz - 30) < 0.001,
				`dz=${dz}`);
			hIcon.click();
		}

		// 規定点数前の右クリック = 作りかけを破棄して次へ (1 回目は継続)
		{
			const hIcon = icon('height.svg');
			hIcon.click();
			const m = PT.sticky.measure;
			await mouseUp(0);   // 1/2 クリック (未完成)
			await mouseUp(2);   // 右クリック 1 回目
			check('作りかけ (高さ 1/2 点) は右クリックで破棄 + 継続', !V.scene.measurements.includes(m) && PT.sticky.active);
			hIcon.click();
		}

		// 右クリック 2 回で完全解除 (規定点数ツール = Point でも有効)
		{
			const ptIcon = icon('point.svg');
			ptIcon.click();
			check('Point: ON', PT.sticky.active && ptIcon.hasClass('pcs-sticky-on'));
			await mouseUp(2);   // 1 回目 = 継続
			check('Point: 右クリック 1 回目は継続', PT.sticky.active);
			await mouseUp(2);   // 2 回目 = 解除
			check('Point: 右クリック 2 回で完全解除', !PT.sticky.active && !ptIcon.hasClass('pcs-sticky-on'));
		}

		// 左クリックを挟むと右クリックカウントはリセット (= 誤解除しない)
		{
			const dIcon = icon('distance.svg');
			dIcon.click();
			await mouseUp(2);   // 右 1 回目 (継続)
			await mouseUp(0);   // 左クリック = カウントリセット
			await mouseUp(2);   // 右 (リセット後の 1 回目 → 継続、 解除しない)
			check('左クリックを挟むと右クリック 2 連続が切れて誤解除しない', PT.sticky.active);
			await mouseUp(2);   // もう 1 回 = 2 連続で解除
			check('その後の右クリック 2 連続で解除', !PT.sticky.active);
		}

		// 後始末: テストで作った計測を全削除
		for (const m of [...V.scene.measurements]) V.scene.removeMeasurement(m);
		for (const p of [...V.scene.profiles]) V.scene.removeProfile(p);

		log(`=== 完了: PASS ${pass} / FAIL ${fail} (全 ${pass + fail}) ===`);
	} catch (err) {
		log('HARNESS ERROR: ' + (err && err.stack || err));
		log(`=== 完了: PASS ${pass} / FAIL ${fail} + ERROR ===`);
	}
	await sleep(800);
	window.close();
})();
