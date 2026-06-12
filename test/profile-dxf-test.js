// ============================================================
// profile-dxf-test.js — 断面 DXF (2D) の正面投影修正の検証
// 旧: x=追加距離 / y=0 / z=標高 (XZ 平面に寝る = 2D CAD で一直線)
// 新: x=追加距離 / y=標高 / z=0 (XY 平面に立つ = 2D CAD でそのまま断面形状)
// 3D 出力 (flatten=false) は従来どおり世界座標のままであることも確認。
// ============================================================
(async () => {
	const fs = require('fs');
	const os = require('os');
	const path = require('path');
	const LOG = process.env.PCS_TEST_LOG || path.join(os.tmpdir(), 'pcs_profiledxf_test_log.txt');
	let pass = 0, fail = 0;
	fs.writeFileSync(LOG, '');
	function log(s) { console.log('[pcs-test]', s); fs.appendFileSync(LOG, s + '\r\n'); }
	function check(name, cond, detail) {
		if (cond) { pass++; log(`PASS ${name}`); }
		else { fail++; log(`FAIL ${name}${detail ? ': ' + detail : ''}`); }
	}
	const sleep = (ms) => new Promise(r => setTimeout(r, ms));

	// 断面ウィンドウが DXF ボタンに渡すのと同じ形式の点データ
	// 3 点の断面: 追加距離 0/5/10 m、 標高 450/455/452 m (世界座標は適当な大座標)
	const points = {
		data: {
			mileage: [0, 5, 10],
			position: [637900, 851200, 450, 637905, 851200, 455, 637910, 851200, 452],
			rgba: [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255],
		},
		numPoints: 3,
	};

	// DXF から POINT entity の座標 (10/20/30) を抜き出す
	function parseDxfPoints(dxf) {
		// DXF は「グループコード行 / 値行」の交互ペア。 ペア単位で走査する
		// (単純な行検索だと x=10 等の「値の行」をコードと誤読する)
		const out = [];
		const lines = dxf.split('\n').map(s => s.trim());
		for (let i = 0; i < lines.length; i++) {
			if (lines[i] === 'POINT' && lines[i - 1] === '0') {
				const v = {};
				let j = i + 1;
				while (j + 1 < lines.length && lines[j] !== '0') {
					const code = lines[j], val = lines[j + 1];
					if (code === '10') v.x = parseFloat(val);
					else if (code === '20') v.y = parseFloat(val);
					else if (code === '30') v.z = parseFloat(val);
					j += 2;
				}
				out.push(v);
			}
		}
		return out;
	}

	try {
		log('=== 断面 DXF 正面投影テスト開始 ===');
		check('P01 DXFProfileExporter 公開', typeof Potree.DXFProfileExporter !== 'undefined');

		// ---- 2D (flatten=true) = 正面投影 ----
		const dxf2d = Potree.DXFProfileExporter.toString(points, true);
		const pts2d = parseDxfPoints(dxf2d);
		check('P02 2D: POINT 3 点', pts2d.length === 3);
		check('P03 2D: x=追加距離', pts2d[0].x === 0 && pts2d[1].x === 5 && pts2d[2].x === 10,
			JSON.stringify(pts2d.map(p => p.x)));
		check('P04 2D: y=標高 (正面投影 = 断面が XY 平面に立つ)',
			pts2d[0].y === 450 && pts2d[1].y === 455 && pts2d[2].y === 452,
			JSON.stringify(pts2d.map(p => p.y)));
		check('P05 2D: z=0 (奥行なし)', pts2d.every(p => p.z === 0), JSON.stringify(pts2d.map(p => p.z)));
		// 真上から見ても一直線にならない (= y がばらける) ことの確認
		const ySpread = Math.max(...pts2d.map(p => p.y)) - Math.min(...pts2d.map(p => p.y));
		check('P06 2D: 真上表示で断面形状が見える (y 振幅 5m)', Math.abs(ySpread - 5) < 0.001, String(ySpread));

		// ---- 3D ボタン相当 (引数なし) もデフォルトで正面投影 ----
		const dxfDefault = Potree.DXFProfileExporter.toString(points);
		const ptsDefault = parseDxfPoints(dxfDefault);
		check('P07 引数なし (3D ボタン) も正面投影がデフォルト',
			ptsDefault.length === 3 && ptsDefault[0].x === 0 && ptsDefault[0].y === 450 && ptsDefault[0].z === 0,
			JSON.stringify(ptsDefault[0]));
		// 明示的に false を渡した時だけ世界座標 (上級用途)
		const dxf3d = Potree.DXFProfileExporter.toString(points, false);
		const pts3d = parseDxfPoints(dxf3d);
		check('P07b flatten=false 明示時のみ世界座標',
			pts3d.length === 3 && pts3d[0].x === 637900 && pts3d[0].y === 851200 && pts3d[0].z === 450,
			JSON.stringify(pts3d[0]));

		// ---- DXF としての体裁 ----
		check('P08 DXF ヘッダ/EOF', dxf2d.includes('SECTION') && dxf2d.trim().endsWith('EOF'));

		log(`=== 完了: PASS ${pass} / FAIL ${fail} (全 ${pass + fail}) ===`);
	} catch (err) {
		log('HARNESS ERROR: ' + (err && err.stack || err));
		log(`=== 完了: PASS ${pass} / FAIL ${fail} + ERROR ===`);
	}
	await sleep(500);
	window.close();
})();
