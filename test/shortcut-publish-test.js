// ============================================================
// shortcut-publish-test.js — ユーザーのショートカット起動 (実環境) での URL 公開 実走検証
//   デスクトップの「PotreeDesktop (アプリ)」ショートカット経由で起動された実プロセスで、
//   点群読込 → 「URL 公開」ボタン → 実公開 → レポートから URL 取得 → HTTP 200 まで確認。
//   公開の進捗ウィンドウ (pwsh) は -NoExit のまま残す (= 目視確認用)。
// ============================================================
(async () => {
	const fs = require('fs');
	const os = require('os');
	const path = require('path');
	const LOG = path.join(os.tmpdir(), 'pcs_shortcut_test_log.txt');
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
		while (Date.now() - s < timeout) { try { const v = fn(); if (v) return v; } catch (_) {} await sleep(700); }
		log('TIMEOUT: ' + what);
		return null;
	}
	const V = window.viewer;
	const startedAt = Date.now();

	try {
		log('=== ショートカット起動 実環境テスト開始 ===');
		log('exePath: ' + process.execPath);
		check('R01 実環境起動 (fork の electron)', process.execPath.toLowerCase().includes('potreedesktop-fork'));
		await until(() => $('#pcs_site_publish').length === 1, 20000, 'sidebar');
		check('R02 公開ボタン表示', $('#pcs_site_publish').length === 1);

		await new Promise((res, rej) => {
			Potree.loadPointCloud(path.join(os.tmpdir(), 'pcs_t', 'slope_converted', 'metadata.json'), 'slope', e => {
				if (!e || !e.pointcloud) { rej(new Error('load failed')); return; }
				V.scene.addPointCloud(e.pointcloud);
				viewer.fitToScreen();
				res();
			});
		});
		check('R03 点群読込', V.scene.pointclouds.length === 1);

		// 計測を 1 本作って「編集状態ごと公開」も実証
		const m = new Potree.Measure();
		m.name = '実環境テスト距離';
		m.addMarker(new THREE.Vector3(637840, 851140, 452));
		m.addMarker(new THREE.Vector3(637860, 851140, 453));
		V.scene.addMeasurement(m);

		// ボタンを実際に押す (確認ダイアログは自動承認)
		const origConfirm = window.confirm;
		window.confirm = () => true;
		$('#pcs_site_publish').click();
		window.confirm = origConfirm;
		const child = window.PCS_PROJECT._lastPublish;
		check('R04 公開プロセス起動 (pwsh -NoProfile)', !!child && typeof child.pid === 'number');

		// 完了検知 = _reports に新しい publish レポートが出る (最大 6 分)
		const reportsDir = 'C:\\potree_share\\_reports';
		const report = await until(() => {
			const files = fs.readdirSync(reportsDir).filter(f => f.startsWith('publish_'))
				.map(f => path.join(reportsDir, f))
				.filter(f => fs.statSync(f).mtimeMs > startedAt);
			for (const f of files) {
				const t = fs.readFileSync(f, 'utf8');
				if (t.includes('[OK] HTTP 200')) return { file: f, text: t };
			}
			return null;
		}, 360000, '公開完了レポート');
		check('R05 実公開がショートカット環境で完走', !!report, report && report.file);

		if (report) {
			const mUrl = report.text.match(/viewerUrl\s*:\s*(\S+)/) || report.text.match(/(https:\/\/\S+pointcloud-temp-viewer\.pages\.dev\S*)/);
			const url = mUrl ? mUrl[1] : null;
			check('R06 viewer URL 取得', !!url, url);
			if (url) {
				const res = await fetch(url).catch(() => null);
				check('R07 URL が HTTP 200', !!res && res.status === 200, res && String(res.status));
				const cfg = await fetch(new URL('viewer-config.js', url)).then(r => r.text()).catch(() => '');
				check('R08 公開 URL に編集状態 (計測) が埋め込み済み', cfg.includes('実環境テスト距離'));
				log('PUBLISHED_URL: ' + url);
			}
		}

		log(`=== 完了: PASS ${pass} / FAIL ${fail} (全 ${pass + fail}) ===`);
	} catch (err) {
		log('HARNESS ERROR: ' + (err && err.stack || err));
		log(`=== 完了: PASS ${pass} / FAIL ${fail} + ERROR ===`);
	}
	await sleep(1500);
	window.close();   // 公開の pwsh 窓は目視用に残る
})();
