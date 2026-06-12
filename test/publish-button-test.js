// ============================================================
// publish-button-test.js — 「URL 公開」ボタンの実走検証
// 不具合: powershell.exe (5.1) 起動 → #requires 7.0 で即拒否され何も走らなかった
// 修正: pwsh (PowerShell 7) を明示起動。 本テストはボタン → 実スクリプトを
//       dry-run (-SkipDeploy) で最後まで走らせ、 exit 0 を確認する。
// 実行: PCS_PUBLISH_DRYRUN=1 で起動すること
// ============================================================
(async () => {
	const fs = require('fs');
	const os = require('os');
	const path = require('path');
	const LOG = process.env.PCS_TEST_LOG || path.join(os.tmpdir(), 'pcs_pub_test_log.txt');
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
		while (Date.now() - s < timeout) { try { if (fn()) return true; } catch (_) {} await sleep(400); }
		log('TIMEOUT: ' + what);
		return false;
	}
	const V = window.viewer;
	const PJ = window.PCS_PROJECT;

	try {
		log('=== URL 公開ボタン 実走テスト (dry-run) ===');
		await until(() => $('#pcs_site_publish').length === 1, 15000, 'sidebar');
		check('B01 公開ボタン存在', $('#pcs_site_publish').length === 1);

		// 現場なしで点群を直接読込 (= 不具合報告と同じ状況)
		await new Promise((res, rej) => {
			Potree.loadPointCloud(path.join(os.tmpdir(), 'pcs_t', 'slope_converted', 'metadata.json'), 'slope', e => {
				if (!e || !e.pointcloud) { rej(new Error('load failed')); return; }
				V.scene.addPointCloud(e.pointcloud);
				res();
			});
		});

		// 確認ダイアログを自動承認してボタンを実際に押す
		const origConfirm = window.confirm;
		window.confirm = () => true;
		$('#pcs_site_publish').click();
		window.confirm = origConfirm;

		const child = PJ._lastPublish;
		check('B02 公開プロセス起動 (pwsh)', !!child && typeof child.pid === 'number', child && String(child.pid));

		let exitCode = null;
		if (child) child.on('exit', (code) => { exitCode = code; });
		const done = await until(() => exitCode !== null, 240000, '公開スクリプト完走');
		check('B03 公開スクリプトが最後まで走る (exit 0)', done && exitCode === 0, `exit=${exitCode}`);

		// dry-run 成果物: 直近の case-* viewer に scene 入り viewer-config がある
		const work = 'C:\\potree_share\\_work';
		const cases = fs.readdirSync(work).filter(d => d.startsWith('case-')).sort();
		const latest = cases[cases.length - 1];
		const cfgPath = path.join(work, latest, 'viewer', 'viewer-config.js');
		check('B04 viewer-config 生成 + scene 埋め込み',
			fs.existsSync(cfgPath) && fs.readFileSync(cfgPath, 'utf8').includes('scene: {'), latest);

		log(`=== 完了: PASS ${pass} / FAIL ${fail} (全 ${pass + fail}) ===`);
	} catch (err) {
		log('HARNESS ERROR: ' + (err && err.stack || err));
		log(`=== 完了: PASS ${pass} / FAIL ${fail} + ERROR ===`);
	}
	await sleep(800);
	window.close();
})();
