// ============================================================
// dropzone-guard-test.js — LAZ 投入画面の誤表示修正の検証
// 文字列・ラベルのドラッグでは出ず、 ファイルのドラッグでだけ出ること。
// ============================================================
(async () => {
	const fs = require('fs');
	const os = require('os');
	const path = require('path');
	const LOG = process.env.PCS_TEST_LOG || path.join(os.tmpdir(), 'pcs_dropzone_test_log.txt');
	let pass = 0, fail = 0;
	fs.writeFileSync(LOG, '');
	function log(s) { console.log('[pcs-test]', s); fs.appendFileSync(LOG, s + '\r\n'); }
	function check(name, cond, detail) {
		if (cond) { pass++; log(`PASS ${name}`); }
		else { fail++; log(`FAIL ${name}${detail ? ': ' + detail : ''}`); }
	}
	const sleep = (ms) => new Promise(r => setTimeout(r, ms));
	const zone = () => document.getElementById('pointcloud_file_dropzone');
	const visible = () => zone().style.display !== 'none' && zone().style.display !== '';
	const stub = (types) => ({
		dataTransfer: { types, dropEffect: '' },
		preventDefault() {}, stopPropagation() {},
	});

	try {
		log('=== ドロップゾーン誤表示 修正テスト ===');
		zone().style.display = 'none';

		// 文字列ドラッグ (ツリーラベル・選択テキスト相当) → 出ない
		window.PCS_DESKTOP.dragEnter(stub(['text/plain']));
		check('Z01 文字列ドラッグでは投入画面が出ない', !visible());

		// 実 DOM 経由 (body の dragenter) でも出ない
		const dt = new DataTransfer();
		dt.setData('text/plain', 'ラベル');
		document.body.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
		await sleep(50);
		check('Z02 実イベント (text/plain) でも出ない', !visible());

		// ファイルのドラッグ → 出る
		window.PCS_DESKTOP.dragEnter(stub(['Files']));
		check('Z03 ファイルドラッグでは投入画面が出る', visible());

		// dragLeave で消える
		window.PCS_DESKTOP.dragLeave(stub(['Files']));
		check('Z04 dragLeave で消える', !visible());

		log(`=== 完了: PASS ${pass} / FAIL ${fail} (全 ${pass + fail}) ===`);
	} catch (err) {
		log('HARNESS ERROR: ' + (err && err.stack || err));
		log(`=== 完了: PASS ${pass} / FAIL ${fail} + ERROR ===`);
	}
	await sleep(500);
	window.close();
})();
