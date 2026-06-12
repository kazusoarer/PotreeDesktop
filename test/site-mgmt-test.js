// ============================================================
// site-mgmt-test.js — 現場管理 Phase 1 の実機検証 (リロード跨ぎ 3 段階)
//   Stage1: 変換フロー (日本語 LAZ の ASCII 退避 → site 内へ変換) → 自動保存 →
//           計測+SIMA 追加 → 保存 → リネーム → 検索 → 開く (reload)
//   Stage2: 完全復元の検証 (点群/計測/SIMA/表示名) → 旧 Export json5 を開く (reload)
//   Stage3: 旧形式互換の検証 + 一覧維持 → 総括
// 実行: PCS_TEST=本ファイル PCS_SITE_PARENT=<試験用親フォルダ> で electron 起動
// ============================================================
(async () => {
	const fs = require('fs');
	const os = require('os');
	const path = require('path');
	const T = path.join(os.tmpdir(), 'pcs_t');
	const LOG = process.env.PCS_TEST_LOG || path.join(os.tmpdir(), 'pcs_site_test_log.txt');
	const stage = parseInt(localStorage.getItem('pcsTestStage') || '1', 10);
	if (stage === 1) { try { fs.writeFileSync(LOG, ''); } catch (_) {} }
	function log(s) {
		console.log('[pcs-test]', s);
		fs.appendFileSync(LOG, `[S${stage}] ${s}\r\n`);
	}
	function check(name, cond, detail) {
		log(`${cond ? 'PASS' : 'FAIL'} ${name}${!cond && detail ? ': ' + detail : ''}`);
	}
	const sleep = (ms) => new Promise(r => setTimeout(r, ms));
	async function until(fn, timeout, what) {
		const s = Date.now();
		while (Date.now() - s < timeout) { try { if (fn()) return true; } catch (_) {} await sleep(300); }
		log('TIMEOUT: ' + what);
		return false;
	}
	const V = window.viewer;
	const PJ = window.PCS_PROJECT;
	const PT = window.PCS_TOOLS;
	const PARENT = process.env.PCS_SITE_PARENT;

	async function finishAll() {
		// 総括: ログの PASS/FAIL を数える
		const text = fs.readFileSync(LOG, 'utf8');
		const pass = (text.match(/PASS /g) || []).length;
		const fail = (text.match(/FAIL |TIMEOUT|HARNESS ERROR/g) || []).length;
		fs.appendFileSync(LOG, `=== 完了: PASS ${pass} / FAIL ${fail} ===\r\n`);
		localStorage.removeItem('pcsTestStage');
		await sleep(800);
		window.close();
	}

	try {
		// loadGUI (非同期) 完了待ち
		await until(() => $('#pcs_site_name').length === 1, 15000, 'sidebar 構築');

		if (stage === 1) {
			log('=== 現場管理テスト Stage1 ===');
			check('S01 親フォルダ = env 指定 + 作成済み', PJ.parent === PARENT && fs.existsSync(PARENT), PJ.parent);
			check('S02 起動直後は現場なし', PJ.site === null);

			// 日本語名 LAZ の変換 (実フロー: prepareConversion → convert_20)
			const jpLas = path.join(T, '佐藤2丁目テスト.las');
			const prep = PJ.prepareConversion([jpLas], 'test');
			const site = PJ.site;
			check('S03 ドロップで現場が自動作成', !!site && fs.existsSync(site.file));
			check('S04 表示名 = LAZ 名 (日本語)', site.displayName === '佐藤2丁目テスト', site.displayName);
			check('S05 内部フォルダ名は英数字のみ', /^[\x00-\x7F]+$/.test(path.basename(site.dir)), path.basename(site.dir));
			check('S06 日本語入力は ASCII へ退避', prep.inputPaths.length === 1 && /^[\x00-\x7F]+$/.test(prep.inputPaths[0]) && fs.existsSync(prep.inputPaths[0]), prep.inputPaths[0]);
			check('S07 変換先 = 現場フォルダ内 data\\cloud_1', prep.targetDir === path.join(site.dir, 'data', 'cloud_1'), prep.targetDir);

			window.PCS_DESKTOP.convert_20(prep.inputPaths, prep.targetDir, 'cloud_1');
			const ok = await until(() => V.scene.pointclouds.length === 1, 90000, '変換 + 読込');
			check('S08 日本語 LAZ が変換・読込成功', ok && fs.existsSync(path.join(prep.targetDir, 'metadata.json')));
			await sleep(700);   // onCloudLoaded (退避削除 + 自動保存) 完了待ち
			check('S09 退避 file は自動削除', !fs.existsSync(prep.inputPaths[0]));
			{
				const data = JSON.parse(fs.readFileSync(site.file, 'utf8'));
				check('S10 変換後に現場 file 自動更新 + 相対参照', !!data.potree && data.potree.pointclouds.length === 1 &&
					data.potree.pointclouds[0].url.startsWith('./data/'), JSON.stringify(data.potree && data.potree.pointclouds));
			}

			// 計測 + SIMA → dirty → 保存
			const m = new Potree.Measure();
			m.addMarker(new THREE.Vector3(637840, 851140, 452));
			m.addMarker(new THREE.Vector3(637860, 851140, 453));
			V.scene.addMeasurement(m);
			PT.importSimaFromPath(path.join(T, 'test_drape.sim'), 0.4, '#ff0000');
			check('S11 変更で * (未保存) 表示', PJ.dirty && $('#pcs_site_name').text().includes('*'));
			$('#pcs_site_save').click();
			{
				const data = JSON.parse(fs.readFileSync(site.file, 'utf8'));
				check('S12 保存: 計測 1 + SIMA 埋込み', data.potree.measurements.length === 1 &&
					data.pcs.sima.length === 1 && data.pcs.sima[0].simText.includes('D00') && data.pcs.sima[0].widthM === 0.4);
				check('S13 保存後は * が消える', !PJ.dirty && !$('#pcs_site_name').text().includes('*'));
			}

			// リネーム + 一覧検索
			PJ.renameSiteFile(site.file, '佐藤2丁目 境界確認');
			check('S14 リネーム反映 (header + file)', PJ.site.displayName === '佐藤2丁目 境界確認' &&
				JSON.parse(fs.readFileSync(site.file, 'utf8')).displayName === '佐藤2丁目 境界確認');
			$('#pcs_site_search').val('境界').trigger('input');
			const hit = $('#pcs_site_list .pcs-site-row').length;
			$('#pcs_site_search').val('存在しない現場').trigger('input');
			const miss = $('#pcs_site_list .pcs-site-row').length;
			$('#pcs_site_search').val('').trigger('input');
			check('S15 検索で絞り込み (1 件 / 0 件)', hit === 1 && miss === 0, `hit=${hit} miss=${miss}`);

			// 開く (reload 跨ぎ)
			localStorage.setItem('pcsTestStage', '2');
			log('-> reload して Stage2 (開く → 復元検証)');
			PJ.openSiteFile(site.file);
			return;
		}

		if (stage === 2) {
			log('=== Stage2: 開く → 完全復元の検証 ===');
			const ok = await until(() => V.scene.pointclouds.length === 1, 60000, '点群復元');
			check('S16 点群が復元', ok);
			check('S17 計測が復元', V.scene.measurements.length === 1, String(V.scene.measurements.length));
			await until(() => PT.simaEntries.length === 1, 10000, 'SIMA 復元');
			const en = PT.simaEntries[0];
			check('S18 SIMA が復元 (幅/色/ラベル/埋込み)', !!en && en.widthM === 0.4 && en.colorHex === '#ff0000' &&
				en.label === 'test_drape.sim' && !!en.simText);
			check('S19 表示名が復元', PJ.site && PJ.site.displayName === '佐藤2丁目 境界確認' &&
				$('#pcs_site_name').text().startsWith('佐藤2丁目 境界確認'), PJ.site && PJ.site.displayName);
			check('S20 開いた直後は未保存マークなし', !PJ.dirty);

			// 旧 Export json5 (現場管理外・絶対パス) 互換
			const legacy = path.join(T, 'legacy_test.json5');
			fs.writeFileSync(legacy, JSON.stringify(Potree.saveProject(V), null, '\t'), 'utf8');
			localStorage.setItem('pcsTestStage', '3');
			log('-> reload して Stage3 (旧形式 json5 を開く)');
			PJ.openSiteFile(legacy);
			return;
		}

		if (stage === 3) {
			log('=== Stage3: 旧形式互換 + 一覧維持 ===');
			const ok = await until(() => V.scene.pointclouds.length === 1, 60000, '旧形式の点群読込');
			check('S21 旧 Export json5 が開ける (点群)', ok);
			check('S22 旧形式でも計測が復元', V.scene.measurements.length === 1, String(V.scene.measurements.length));
			check('S23 旧形式は現場扱いしない', PJ.site === null);
			const sites = PJ.scanSites();
			check('S24 現場一覧は維持 (1 件・名前一致)', sites.length === 1 && sites[0].displayName === '佐藤2丁目 境界確認',
				JSON.stringify(sites.map(s => s.displayName)));
			await finishAll();
			return;
		}
	} catch (err) {
		log('HARNESS ERROR: ' + (err && err.stack || err));
		await finishAll();
	}
})();
