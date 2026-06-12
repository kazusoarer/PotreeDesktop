// ============================================================
// sima-drape-test.js — 境界線の点群表面フィット (ドレープ) 検証
// シナリオ = ユーザー実害の再現: SIMA 標高が 0 (点群は標高 450+ の斜面)
//   → 旧実装では線が地中 (z=0) に沈む。 新実装では表面 (450-453m) に乗ること。
// 合成斜面: z = 450 + 0.05 * (E - 637800)、 0.5m 間隔グリッド
// ============================================================
(async () => {
	const fs = require('fs');
	const os = require('os');
	const path = require('path');
	const T = path.join(os.tmpdir(), 'pcs_t');
	const LOG = process.env.PCS_TEST_LOG || path.join(os.tmpdir(), 'pcs_drape_test_log.txt');
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
	const surfaceZ = (e) => 450 + 0.05 * (e - 637800);

	try {
		log('=== ドレープ テスト開始 ===');
		await new Promise((res, rej) => {
			Potree.loadPointCloud(path.join(T, 'slope_converted', 'metadata.json'), 'slope', e => {
				if (!e || !e.pointcloud) { rej(new Error('load failed')); return; }
				V.scene.addPointCloud(e.pointcloud);
				V.fitToScreen();
				res();
			});
		});
		// LOD node の読込待ち (= THREE.Points が点群配下に現れるまで)
		let nodeCount = 0;
		for (let i = 0; i < 40; i++) {
			nodeCount = 0;
			V.scene.pointclouds[0].traverse(o => { if (o.isPoints) nodeCount++; });
			if (nodeCount > 0) break;
			await sleep(500);
		}
		check('D01 octree node 読込', nodeCount > 0, `nodes=${nodeCount}`);

		// 高さサンプラー単体: 既知の斜面高さと一致するか
		const parsedProbe = { points: new Map([['p', { e: 637840, n: 851140, z: null }]]), parcels: [] };
		const cells = PT.buildHeightSampler(parsedProbe);
		const h = PT.heightAt(cells, 637840, 851140);
		check('D02 高さサンプラー精度 (期待 452±0.5)', h != null && Math.abs(h - surfaceZ(637840)) < 0.5, `got ${h}`);

		// SIMA 標高 0 を読込 → 線が表面に乗る
		const group = PT.importSimaFromPath(path.join(T, 'test_drape.sim'));
		check('D03 読込成功', !!group && group.children.length === 1);
		if (group) {
			const line = group.children[0];
			const ga = line.geometry.getAttribute('position');
			check('D04 辺が細分化されている (頂点 > 4)', ga.count > 4, `count=${ga.count}`);
			let maxErr = -1, minZ = Infinity, maxZ = -Infinity;
			const wp = new THREE.Vector3();
			for (let i = 0; i < ga.count; i++) {
				wp.fromBufferAttribute(ga, i).add(group.position);
				const want = surfaceZ(wp.x) + 0.3;
				const err = Math.abs(wp.z - want);
				if (err > maxErr) maxErr = err;
				if (wp.z < minZ) minZ = wp.z;
				if (wp.z > maxZ) maxZ = wp.z;
			}
			check('D05 全頂点が表面に追従 (誤差 < 0.6m)', maxErr >= 0 && maxErr < 0.6, `maxErr=${maxErr.toFixed(3)} zRange=${minZ.toFixed(2)}-${maxZ.toFixed(2)}`);
			check('D06 SIMA 標高 0 を無視して表面高さ採用 (z > 400)', minZ > 400, `minZ=${minZ.toFixed(2)}`);
			check('D07 斜面に沿って高さが変化 (≈2m 勾配差)', (maxZ - minZ) > 1.2 && (maxZ - minZ) < 3.0, `dz=${(maxZ - minZ).toFixed(2)}`);
		}

		// 再フィット (= 同じ状態で押しても表面フィットが維持される)
		PT.refitSimaGroup(group);
		{
			const ga = group.children[0].geometry.getAttribute('position');
			const wp = new THREE.Vector3().fromBufferAttribute(ga, 0).add(group.position);
			check('D08 再フィット後も表面高さ', Math.abs(wp.z - (surfaceZ(wp.x) + 0.3)) < 0.6, `z=${wp.z.toFixed(2)}`);
		}

		// undo/redo がドレープ後も機能
		$('#pcs_undo').click();
		check('D09 一つ戻る → 赤線消去', PT.simaGroups.length === 0);
		$('#pcs_redo').click();
		check('D10 一つ進む → 復活', PT.simaGroups.length === 1);

		log(`=== 完了: PASS ${pass} / FAIL ${fail} (全 ${pass + fail}) ===`);
	} catch (err) {
		log('HARNESS ERROR: ' + (err && err.stack || err));
		log(`=== 完了: PASS ${pass} / FAIL ${fail} + ERROR ===`);
	}
	await sleep(1000);
	window.close();
})();
